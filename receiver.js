/*
 * AudioMirroring 커스텀 Cast Web Receiver 로직
 *
 * 핵심: A/V sync 축을 "콘텐츠 위치"가 아니라 "전송 지연(live latency)"으로 다룬다.
 *  - LL-DASH 라이브를 낮은 목표 latency로 재생
 *  - 측정 live latency(라이브 엣지 - 현재 재생 위치)를 주기적으로 폰에 리포트
 *  - 폰은 setMusicShareSyncDelay(latency)로 비디오를 지연시켜 A/V sync를 맞춤
 *
 * 리포트 경로: 폰의 LocalHttpServer /latency (HTTP POST)
 *  - manifest URL(contentId)에서 폰의 IP:PORT를 추출해 사용
 *  - Cast custom channel은 폰(MediaRoute2)에서 수신 경로가 없어 사용하지 않음
 */

(function () {
  'use strict';

  // 폰(Sender)과 동일해야 하는 네임스페이스(로그/디버깅용, 수신은 HTTP로 처리)
  const NAMESPACE = 'urn:x-cast:com.samsung.audiomirroring';

  // 목표 라이브 latency(ms). 실기기에서 튜닝.
  const TARGET_LATENCY_MS = 1500;

  // latency 리포트 주기(ms)
  const REPORT_INTERVAL_MS = 1000;

  // ---- 라이브 catch-up 파라미터 ----
  // 이보다 뒤처지면 라이브 엣지로 하드 seek (누적 표류 제거)
  const HARD_SEEK_THRESHOLD_MS = 3000;
  // seek 시 라이브 엣지에서 이만큼 뒤(버퍼 여유)로 이동
  const SEEK_MARGIN_MS = 1000;
  // 목표 + 이 값 초과 시 재생속도 살짝 올려 부드럽게 따라잡기
  const SOFT_CATCHUP_MARGIN_MS = 400;
  const CATCHUP_RATE = 1.05;   // 따라잡기 속도
  const NORMAL_RATE = 1.0;
  // catch-up 판정 주기(ms) — 리포트보다 자주 돌려 반응성 확보
  const CATCHUP_INTERVAL_MS = 500;

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  let reportTimer = null;
  let catchupTimer = null;
  let senderBaseUrl = null; // 폰 IP:PORT (manifest URL에서 추출)

  // ---------------------------------------------------------------------------
  // 1) LL-DASH 저지연 재생 설정
  // ---------------------------------------------------------------------------
  const playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 1;
  playbackConfig.autoResumeNumberOfSegments = 1;
  playbackConfig.initialBandwidth = 128000;
  playerManager.setPlaybackConfig(playbackConfig);

  // LOAD 요청 가로채기: 라이브 스트림으로 지정 + 폰 baseUrl 추출
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    (loadRequest) => {
      try {
        const media = loadRequest.media || {};
        media.streamType = cast.framework.messages.StreamType.LIVE;
        if (!media.contentType) {
          media.contentType = 'application/dash+xml';
        }
        loadRequest.media = media;

        // manifest URL에서 폰의 호스트(IP:PORT) 추출 → /latency POST 대상
        // CAF 버전에 따라 contentUrl 또는 contentId에 URL이 담긴다(둘 다 확인).
        const src = media.contentUrl || media.contentId;
        if (src) {
          try {
            const url = new URL(src);
            senderBaseUrl = url.origin; // http://192.168.x.x:port
            console.log('[AM-Receiver] senderBaseUrl =', senderBaseUrl);
          } catch (e) {
            console.error('[AM-Receiver] src parse error', src, e);
          }
        } else {
          console.error('[AM-Receiver] no contentUrl/contentId in LOAD');
        }

        console.log('[AM-Receiver] LOAD intercepted:', src, media.contentType);
      } catch (e) {
        console.error('[AM-Receiver] LOAD interceptor error', e);
      }
      return loadRequest;
    }
  );

  // ---------------------------------------------------------------------------
  // 2) 측정 live latency 계산
  //    latency = (라이브 엣지) - (현재 재생 위치)
  //    video element / liveEdge / currentTime을 함께 반환해 catch-up에서 재사용.
  // ---------------------------------------------------------------------------
  function getMediaEl() {
    return document.querySelector('video') || document.querySelector('audio') || null;
  }

  // { latencyMs, video, liveEdge, cur } 반환. 측정 불가 시 latencyMs = -1.
  function getLiveState() {
    const el = getMediaEl();
    if (el && el.seekable && el.seekable.length > 0) {
      try {
        const liveEdge = el.seekable.end(el.seekable.length - 1);
        const cur = el.currentTime;
        const latencySec = liveEdge - cur;
        if (isFinite(latencySec) && latencySec >= 0) {
          return { latencyMs: Math.round(latencySec * 1000), video: el, liveEdge: liveEdge, cur: cur };
        }
      } catch (e) { /* fallthrough */ }
    }
    return { latencyMs: -1, video: el, liveEdge: NaN, cur: NaN };
  }

  function computeLiveLatencyMs() {
    return getLiveState().latencyMs;
  }

  // ---------------------------------------------------------------------------
  // 2-1) 라이브 catch-up: latency를 목표 근처로 유지
  //   - 크게 뒤처지면 라이브 엣지로 하드 seek
  //   - 조금 뒤처지면 재생속도 1.05x로 부드럽게 따라잡기
  //   - 목표 근처면 정상 속도(1.0x)
  // ---------------------------------------------------------------------------
  function applyLiveCatchup() {
    const st = getLiveState();
    if (st.latencyMs < 0 || !st.video) return;

    const video = st.video;

    // (a) 하드 seek: 누적 표류 제거
    if (st.latencyMs > HARD_SEEK_THRESHOLD_MS) {
      const target = st.liveEdge - (SEEK_MARGIN_MS / 1000);
      try {
        if (isFinite(target) && target > 0) {
          video.currentTime = target;
          if (video.playbackRate !== NORMAL_RATE) video.playbackRate = NORMAL_RATE;
          console.log('[AM-Receiver] catchup: hard seek to live, was ' + st.latencyMs + 'ms');
        }
      } catch (e) { console.error('[AM-Receiver] seek failed', e); }
      return;
    }

    // (b) 소프트 catch-up: 재생속도 조정
    if (st.latencyMs > TARGET_LATENCY_MS + SOFT_CATCHUP_MARGIN_MS) {
      if (video.playbackRate !== CATCHUP_RATE) {
        video.playbackRate = CATCHUP_RATE;
        console.log('[AM-Receiver] catchup: rate ' + CATCHUP_RATE + ', latency ' + st.latencyMs + 'ms');
      }
    } else {
      if (video.playbackRate !== NORMAL_RATE) {
        video.playbackRate = NORMAL_RATE;
        console.log('[AM-Receiver] catchup: rate normal, latency ' + st.latencyMs + 'ms');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3) 폰으로 latency 리포트 (HTTP POST)
  // ---------------------------------------------------------------------------
  function sendReport(extra) {
    const latencyMs = computeLiveLatencyMs();
    const playerState = playerManager.getPlayerState();

    // 아직 baseUrl을 못 구했으면 매 리포트마다 재시도
    if (!senderBaseUrl) resolveSenderBaseUrl();

    if (latencyMs >= 0 && senderBaseUrl) {
      const body = JSON.stringify(Object.assign({
        liveLatencyMs: latencyMs,
        playerState: playerState,
        targetLatencyMs: TARGET_LATENCY_MS,
      }, extra || {}));

      fetch(senderBaseUrl + '/latency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      }).catch((e) => console.error('[AM-Receiver] latency POST failed', e));
    }

    console.log('[AM-Receiver] latency=' + latencyMs + 'ms state=' + playerState);
  }

  // senderBaseUrl을 아직 못 구했으면 현재 미디어 정보에서 재시도
  function resolveSenderBaseUrl() {
    if (senderBaseUrl) return;
    try {
      const info = playerManager.getMediaInformation && playerManager.getMediaInformation();
      const src = info && (info.contentUrl || info.contentId);
      if (src) {
        senderBaseUrl = new URL(src).origin;
        console.log('[AM-Receiver] senderBaseUrl (resolved) =', senderBaseUrl);
      }
    } catch (e) {
      console.error('[AM-Receiver] resolveSenderBaseUrl failed', e);
    }
  }

  function startReporting() {
    stopReporting();
    resolveSenderBaseUrl();
    reportTimer = setInterval(sendReport, REPORT_INTERVAL_MS);
    catchupTimer = setInterval(applyLiveCatchup, CATCHUP_INTERVAL_MS);
    sendReport({ reason: 'start' }); // 즉시 1회
  }

  function stopReporting() {
    if (reportTimer) {
      clearInterval(reportTimer);
      reportTimer = null;
    }
    if (catchupTimer) {
      clearInterval(catchupTimer);
      catchupTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 4) 플레이어 상태 변화 시 즉시 리포트
  // ---------------------------------------------------------------------------
  playerManager.addEventListener(
    cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
    () => { console.log('[AM-Receiver] load complete'); startReporting(); }
  );
  playerManager.addEventListener(
    cast.framework.events.EventType.PLAYING,
    () => sendReport({ reason: 'playing' })
  );
  playerManager.addEventListener(
    cast.framework.events.EventType.PAUSE,
    () => sendReport({ reason: 'pause' })
  );
  playerManager.addEventListener(
    cast.framework.events.EventType.BUFFERING,
    () => sendReport({ reason: 'buffering' })
  );
  playerManager.addEventListener(
    cast.framework.events.EventType.MEDIA_FINISHED,
    () => stopReporting()
  );
  playerManager.addEventListener(
    cast.framework.events.EventType.ERROR,
    (e) => console.error('[AM-Receiver] player error', e)
  );

  // ---------------------------------------------------------------------------
  // 5) Receiver 시작
  // ---------------------------------------------------------------------------
  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = Object.assign({}, options.customNamespaces);
  options.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;
  options.disableIdleTimeout = true;

  context.start(options);
  console.log('[AM-Receiver] started, namespace =', NAMESPACE, 'targetLatency =', TARGET_LATENCY_MS);
})();

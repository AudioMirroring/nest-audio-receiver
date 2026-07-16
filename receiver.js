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
  const TARGET_LATENCY_MS = 800;

  // latency 리포트 주기(ms)
  const REPORT_INTERVAL_MS = 1000;

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  let reportTimer = null;
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
        if (media.contentId) {
          try {
            const url = new URL(media.contentId);
            senderBaseUrl = url.origin; // http://192.168.x.x:port
            console.log('[AM-Receiver] senderBaseUrl =', senderBaseUrl);
          } catch (e) {
            console.error('[AM-Receiver] contentId parse error', e);
          }
        }

        console.log('[AM-Receiver] LOAD intercepted:', media.contentId, media.contentType);
      } catch (e) {
        console.error('[AM-Receiver] LOAD interceptor error', e);
      }
      return loadRequest;
    }
  );

  // ---------------------------------------------------------------------------
  // 2) 측정 live latency 계산
  //    latency = (라이브 엣지) - (현재 재생 위치)
  //    CAF/shaka 버전마다 접근 방법이 달라 여러 소스를 순서대로 시도한다.
  // ---------------------------------------------------------------------------
  function computeLiveLatencyMs() {
    // (a) 우선: 실제 media element의 seekable 범위 (가장 신뢰도 높음)
    const el = document.querySelector('cast-media-player') &&
      (document.querySelector('video') || document.querySelector('audio'));
    if (el && el.seekable && el.seekable.length > 0) {
      try {
        const liveEdge = el.seekable.end(el.seekable.length - 1);
        const cur = el.currentTime;
        const latencySec = liveEdge - cur;
        if (isFinite(latencySec) && latencySec >= 0) {
          return Math.round(latencySec * 1000);
        }
      } catch (e) { /* fallthrough */ }
    }

    // (b) 대안: PlayerManager의 라이브 seekable 범위
    try {
      const range = playerManager.getLiveSeekableRange && playerManager.getLiveSeekableRange();
      const cur = playerManager.getCurrentTimeSec && playerManager.getCurrentTimeSec();
      if (range && typeof range.end === 'number' && typeof cur === 'number') {
        const latencySec = range.end - cur;
        if (isFinite(latencySec) && latencySec >= 0) {
          return Math.round(latencySec * 1000);
        }
      }
    } catch (e) { /* fallthrough */ }

    return -1; // 측정 불가
  }

  // ---------------------------------------------------------------------------
  // 3) 폰으로 latency 리포트 (HTTP POST)
  // ---------------------------------------------------------------------------
  function sendReport(extra) {
    const latencyMs = computeLiveLatencyMs();
    const playerState = playerManager.getPlayerState();

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

  function startReporting() {
    stopReporting();
    reportTimer = setInterval(sendReport, REPORT_INTERVAL_MS);
    sendReport({ reason: 'start' }); // 즉시 1회
  }

  function stopReporting() {
    if (reportTimer) {
      clearInterval(reportTimer);
      reportTimer = null;
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

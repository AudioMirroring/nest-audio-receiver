/*
 * AudioMirroring 커스텀 Cast Web Receiver 로직
 *
 * 핵심: A/V sync 오프셋을 "콘텐츠 위치"가 아니라 "전송 지연(live latency)"으로 다룬다.
 *  - LL-DASH 라이브를 낮은 목표 latency로 재생
 *  - 실측 live latency(라이브 엣지 - 현재 재생 위치)를 주기적으로 폰에 리포트
 *  - 폰은 setMusicShareSyncDelay(latency)로 비디오를 지연시켜 A/V sync를 맞춤
 *
 * seek/다음곡은 라이브 타임라인 위에서 콘텐츠만 교체되므로 latency(L)가 유지된다
 * → 폰의 비디오 지연도 유지 → 재수렴 불필요.
 *
 * 설계: docs/av-sync-shaka-design.md
 */

(function () {
  'use strict';

  // 폰(Sender)의 AudioPlayback / ProviderService와 반드시 동일해야 하는 네임스페이스
  const NAMESPACE = 'urn:x-cast:com.samsung.audiomirroring';

  // 목표 라이브 latency(ms). 네트워크 지터 흡수 최소치. 실기기에서 튜닝 대상.
  const TARGET_LATENCY_MS = 800;

  // latency 리포트 주기(ms). 상태 변화 시에는 즉시 별도 전송.
  const REPORT_INTERVAL_MS = 1000;

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  let reportTimer = null;
  let lastReportedLatencyMs = -1;

  // ---------------------------------------------------------------------------
  // 1) LL-DASH 저지연 재생 설정
  //    CAF는 내부적으로 shaka-player를 사용한다. LOAD 인터셉터에서 저지연 스트리밍을
  //    활성화하고 목표 latency를 지정한다.
  // ---------------------------------------------------------------------------
  const playbackConfig = new cast.framework.PlaybackConfig();
  // 시작 시 버퍼링을 최소화(라이브 엣지에 가깝게 시작)
  playbackConfig.autoResumeDuration = 1;          // 재버퍼 후 재개에 필요한 버퍼(초)
  playbackConfig.autoResumeNumberOfSegments = 1;
  playbackConfig.initialBandwidth = 128000;       // 오디오 전용, 낮은 대역폭 힌트

  playerManager.setPlaybackConfig(playbackConfig);

  // shaka 저지연 모드는 매니페스트가 LL-DASH(availabilityTimeOffset 등)를 선언하면
  // CAF/shaka가 자동으로 인지한다. 추가로 shaka 설정이 필요하면 shakaConfig로 주입.
  // (CAF 버전에 따라 shakaConfig 노출 방식이 다르므로 실기기에서 확인 필요.)

  // LOAD 요청 가로채기: 폰이 보낸 매니페스트 URL을 라이브 스트림으로 설정
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    (loadRequest) => {
      try {
        const media = loadRequest.media || {};
        // 라이브 스트림임을 명시 → shaka가 라이브 타임라인/저지연 처리
        media.streamType = cast.framework.messages.StreamType.LIVE;
        // 매니페스트 확장자만으로 판별이 안 될 때를 대비한 contentType 보정
        if (!media.contentType) {
          media.contentType = 'application/dash+xml';
        }
        loadRequest.media = media;
        console.log('[AM-Receiver] LOAD intercepted:', media.contentId, media.contentType);
      } catch (e) {
        console.error('[AM-Receiver] LOAD interceptor error', e);
      }
      return loadRequest;
    }
  );

  // ---------------------------------------------------------------------------
  // 2) 실측 live latency 계산
  //    latency = (라이브 엣지) - (현재 재생 위치)
  //    CAF/shaka에서 얻는 방법이 버전마다 다르므로 여러 소스를 순서대로 시도한다.
  // ---------------------------------------------------------------------------
  function computeLiveLatencyMs() {
    // (a) 우선: 하위 media element의 seekable 범위 이용 (가장 신뢰도 높음)
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
  // 3) 폰으로 latency / 상태 리포트
  // ---------------------------------------------------------------------------
  function sendReport(extra) {
    const latencyMs = computeLiveLatencyMs();
    const playerState = playerManager.getPlayerState();
    const msg = Object.assign({
      type: 'sync',
      liveLatencyMs: latencyMs,
      playerState: playerState,       // IDLE | BUFFERING | PLAYING | PAUSED
      targetLatencyMs: TARGET_LATENCY_MS,
      ts: Date.now(),
    }, extra || {});

    // 모든 연결된 sender에게 브로드캐스트
    context.sendCustomMessage(NAMESPACE, undefined, msg);

    if (latencyMs >= 0) lastReportedLatencyMs = latencyMs;
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
  // 4) 폰 → Receiver 커스텀 명령 수신 (선택적: flush/재정렬 등)
  // ---------------------------------------------------------------------------
  context.addCustomMessageListener(NAMESPACE, (event) => {
    const data = event.data || {};
    console.log('[AM-Receiver] custom msg from sender:', data);
    switch (data.cmd) {
      case 'ping':
        sendReport({ reason: 'pong' });
        break;
      // 향후 필요 시 flush/seek-to-live 등 추가
      default:
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // 5) 플레이어 상태 변화 시 즉시 리포트 (재수렴을 빠르게)
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
  // 6) Receiver 시작 (커스텀 네임스페이스 등록 포함)
  // ---------------------------------------------------------------------------
  const options = new cast.framework.CastReceiverOptions();
  // 커스텀 네임스페이스를 시스템 메시지로 등록
  options.customNamespaces = Object.assign({}, options.customNamespaces);
  options.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;
  // 유휴 시 자동 종료 지연(라이브 특성상 넉넉히)
  options.disableIdleTimeout = true;

  context.start(options);
  console.log('[AM-Receiver] started, namespace =', NAMESPACE, 'targetLatency =', TARGET_LATENCY_MS);
})();

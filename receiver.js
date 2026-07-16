/*
 * AudioMirroring Cast Web Receiver (동작 확인 baseline)
 *
 * - LL-DASH 라이브 재생
 * - live latency 계산 후 폰의 /latency 로 HTTP POST 리포트
 * - manifest URL(contentId)에서 폰 IP:PORT 추출
 *
 * ※ catch-up / 후킹 없는 "8810ms 로그가 나왔던" 최소 버전
 */

(function () {
  'use strict';

  const NAMESPACE = 'urn:x-cast:com.samsung.audiomirroring';
  const TARGET_LATENCY_MS = 500;
  const REPORT_INTERVAL_MS = 1000;

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  let reportTimer = null;
  let senderBaseUrl = null;

  console.log('[AM-Receiver] receiver.js loaded');

  // 저지연 재생 설정
  const playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 1;
  playbackConfig.autoResumeNumberOfSegments = 4;
  playbackConfig.initialBandwidth = 128000;
  playerManager.setPlaybackConfig(playbackConfig);

  // LOAD 가로채기: 라이브 지정 + 폰 baseUrl 추출
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

        if (media.contentId) {
          try {
            senderBaseUrl = new URL(media.contentId).origin;
            console.log('[AM-Receiver] senderBaseUrl =', senderBaseUrl);
          } catch (e) {
            console.error('[AM-Receiver] contentId parse error', e);
          }
        }
        console.log('[AM-Receiver] LOAD:', media.contentId);
      } catch (e) {
        console.error('[AM-Receiver] LOAD error', e);
      }
      return loadRequest;
    }
  );

  // live latency 계산
  function computeLiveLatencyMs() {
    try {
      const video = document.querySelector('video') || document.querySelector('audio');
      if (!video || !video.seekable || video.seekable.length === 0) return -1;
      const liveEdge = video.seekable.end(video.seekable.length - 1);
      const cur = video.currentTime;
      const latencySec = liveEdge - cur;
      if (isFinite(latencySec) && latencySec >= 0) {
        return Math.round(latencySec * 1000);
      }
    } catch (e) { /* ignore */ }
    return -1;
  }

  // latency 리포트 (HTTP POST)
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
    sendReport({ reason: 'start' });
  }

  function stopReporting() {
    if (reportTimer) {
      clearInterval(reportTimer);
      reportTimer = null;
    }
  }

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

  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = Object.assign({}, options.customNamespaces);
  options.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;
  options.disableIdleTimeout = true;

  context.start(options);
  console.log('[AM-Receiver] started');
})();

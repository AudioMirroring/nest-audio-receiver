/*
 * AudioMirroring Cast Web Receiver (robust 진단 버전)
 *
 * 목표: senderBaseUrl/latency/타이머 게이트를 모두 제거해 "무조건 폰에 보고"
 *  - senderBaseUrl: 세그먼트 요청(fetch/XHR) 후킹으로 확보 (매니페스트 파싱 불필요)
 *  - 리포트: 시작 즉시 setInterval (PLAYER_LOAD_COMPLETE 의존 X)
 *  - 전송: GET /latency?ms=..&r=.. (단순 요청 → CORS preflight 없음, DASH GET과 동일 경로)
 *  - latency 못 구해도 하트비트(ms=-1) 전송 → 폰 로그로 생존 확인
 */

(function () {
  'use strict';

  const NAMESPACE = 'urn:x-cast:com.samsung.audiomirroring';
  const TARGET_LATENCY_MS = 1500;
  const REPORT_INTERVAL_MS = 1000;

  // catch-up 파라미터
  const HARD_SEEK_THRESHOLD_MS = 3000;
  const SEEK_MARGIN_MS = 1000;
  const SOFT_CATCHUP_MARGIN_MS = 400;
  const CATCHUP_RATE = 1.05;
  const NORMAL_RATE = 1.0;

  let senderBaseUrl = null;

  console.log('[AM-Receiver] receiver.js loaded (robust)');

  // ---------------------------------------------------------------------------
  // 0) 세그먼트 요청 후킹 → 폰 origin 확보
  // ---------------------------------------------------------------------------
  function captureBaseUrl(u) {
    if (senderBaseUrl || !u) return;
    try {
      const ref = (self.location && self.location.href) || undefined;
      const o = new URL(u, ref);
      if (o.protocol === 'http:' && o.pathname.indexOf('/dash') !== -1) {
        senderBaseUrl = o.origin;
        console.log('[AM-Receiver] senderBaseUrl (hooked) =', senderBaseUrl);
      }
    } catch (e) { /* ignore */ }
  }

  if (typeof self !== 'undefined' && self.fetch) {
    const of = self.fetch.bind(self);
    self.fetch = function (input, init) {
      try { captureBaseUrl(typeof input === 'string' ? input : (input && input.url)); } catch (e) {}
      return of(input, init);
    };
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url) {
      try { captureBaseUrl(url); } catch (e) {}
      return oo.apply(this, arguments);
    };
  }

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  // ---------------------------------------------------------------------------
  // 1) 저지연 재생 설정
  // ---------------------------------------------------------------------------
  const playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 1;
  playbackConfig.autoResumeNumberOfSegments = 1;
  playbackConfig.initialBandwidth = 128000;
  playerManager.setPlaybackConfig(playbackConfig);

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    (loadRequest) => {
      try {
        const media = loadRequest.media || {};
        media.streamType = cast.framework.messages.StreamType.LIVE;
        if (!media.contentType) media.contentType = 'application/dash+xml';
        loadRequest.media = media;
        // 후킹으로도 잡지만, 여기서도 시도
        const src = media.contentUrl || media.contentId;
        captureBaseUrl(src);
        console.log('[AM-Receiver] LOAD:', src);
      } catch (e) {
        console.error('[AM-Receiver] LOAD error', e);
      }
      return loadRequest;
    }
  );

  // ---------------------------------------------------------------------------
  // 2) live latency / catch-up
  // ---------------------------------------------------------------------------
  function getMediaEl() {
    return document.querySelector('video') || document.querySelector('audio') || null;
  }

  function getLiveState() {
    const el = getMediaEl();
    if (el && el.seekable && el.seekable.length > 0) {
      try {
        const liveEdge = el.seekable.end(el.seekable.length - 1);
        const cur = el.currentTime;
        const latencySec = liveEdge - cur;
        if (isFinite(latencySec) && latencySec >= 0) {
          return { latencyMs: Math.round(latencySec * 1000), video: el, liveEdge: liveEdge };
        }
      } catch (e) {}
    }
    return { latencyMs: -1, video: el, liveEdge: NaN };
  }

  function applyLiveCatchup() {
    const st = getLiveState();
    if (st.latencyMs < 0 || !st.video) return;
    const video = st.video;

    if (st.latencyMs > HARD_SEEK_THRESHOLD_MS) {
      const target = st.liveEdge - (SEEK_MARGIN_MS / 1000);
      try {
        if (isFinite(target) && target > 0) {
          video.currentTime = target;
          if (video.playbackRate !== NORMAL_RATE) video.playbackRate = NORMAL_RATE;
          console.log('[AM-Receiver] catchup: hard seek, was ' + st.latencyMs + 'ms');
        }
      } catch (e) {}
      return;
    }
    if (st.latencyMs > TARGET_LATENCY_MS + SOFT_CATCHUP_MARGIN_MS) {
      if (video.playbackRate !== CATCHUP_RATE) video.playbackRate = CATCHUP_RATE;
    } else {
      if (video.playbackRate !== NORMAL_RATE) video.playbackRate = NORMAL_RATE;
    }
  }

  // ---------------------------------------------------------------------------
  // 3) 리포트 (GET, 하트비트 포함)
  // ---------------------------------------------------------------------------
  function sendReport(reason) {
    const latencyMs = getLiveState().latencyMs;

    if (senderBaseUrl) {
      const url = senderBaseUrl + '/latency?ms=' + latencyMs +
        '&r=' + encodeURIComponent(reason || 'tick');
      fetch(url).catch(function (e) { console.error('[AM-Receiver] GET failed', e); });
    }
    console.log('[AM-Receiver] latency=' + latencyMs + 'ms base=' + senderBaseUrl);
  }

  // ---------------------------------------------------------------------------
  // 4) 시작 즉시 타이머 (이벤트 의존 X)
  // ---------------------------------------------------------------------------
  setInterval(function () { sendReport('tick'); }, REPORT_INTERVAL_MS);
  setInterval(applyLiveCatchup, 500);

  playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
    () => sendReport('load'));
  playerManager.addEventListener(cast.framework.events.EventType.PLAYING,
    () => sendReport('playing'));
  playerManager.addEventListener(cast.framework.events.EventType.ERROR,
    (e) => console.error('[AM-Receiver] player error', e));

  // ---------------------------------------------------------------------------
  // 5) Receiver 시작
  // ---------------------------------------------------------------------------
  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = Object.assign({}, options.customNamespaces);
  options.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;
  options.disableIdleTimeout = true;

  context.start(options);
  console.log('[AM-Receiver] started (robust), target =', TARGET_LATENCY_MS);
})();

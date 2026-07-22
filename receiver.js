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
  let shakaPlayer = null;

  // Get Shaka Player instance from CAF
  function getShakaPlayer() {
    if (shakaPlayer) return shakaPlayer;
    try {
      const mediaEl = document.querySelector('video') || document.querySelector('audio');
      if (mediaEl && window.shaka && window.shaka.Player) {
        shakaPlayer = shaka.Player.probeSupport();
        // Try to get attached player
        if (mediaEl && mediaEl.__shaka_player__) {
          shakaPlayer = mediaEl.__shaka_player__;
        }
      }
    } catch (e) {}
    return shakaPlayer;
  }

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
    // 방법 1: CAF 공식 API (Shadow DOM 무관) — 가장 신뢰 가능
    try {
      const range = playerManager.getLiveSeekableRange();
      const cur = playerManager.getCurrentTimeSec();
      if (range && typeof range.end === 'number' && typeof cur === 'number') {
        const latencySec = range.end - cur;
        if (isFinite(latencySec) && latencySec >= 0) {
          return { latencyMs: Math.round(latencySec * 1000), liveEdge: range.end, cur: cur };
        }
      }
    } catch (e) {
      console.error('[AM-Receiver] getLiveSeekableRange error', e);
    }

    // 방법 2: fallback — DOM video 요소 (CAF는 shadow DOM이라 대부분 실패)
    const el = getMediaEl();
    if (el && el.seekable && el.seekable.length > 0) {
      try {
        const liveEdge = el.seekable.end(el.seekable.length - 1);
        const cur = el.currentTime;
        const latencySec = liveEdge - cur;
        if (isFinite(latencySec) && latencySec >= 0) {
          return { latencyMs: Math.round(latencySec * 1000), liveEdge: liveEdge, cur: cur };
        }
      } catch (e) {}
    }

    return { latencyMs: -1, liveEdge: NaN, cur: NaN };
  }

  function applyLiveCatchup() {
    const st = getLiveState();
    if (st.latencyMs < 0) return;

    if (st.latencyMs > HARD_SEEK_THRESHOLD_MS) {
      const target = st.liveEdge - (SEEK_MARGIN_MS / 1000);
      try {
        if (isFinite(target) && target > 0) {
          playerManager.seek(target);
          console.log('[AM-Receiver] catchup: hard seek, was ' + st.latencyMs + 'ms');
        }
      } catch (e) {}
      return;
    }

    // soft catch-up: playbackRate 조정 (지원되는 경우만)
    try {
      const rate = (st.latencyMs > TARGET_LATENCY_MS + SOFT_CATCHUP_MARGIN_MS)
        ? CATCHUP_RATE : NORMAL_RATE;
      if (typeof playerManager.setPlaybackRate === 'function' &&
          playerManager.getPlaybackRate() !== rate) {
        playerManager.setPlaybackRate(rate);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 3) 리포트 (GET, 하트비트 포함)
  // ---------------------------------------------------------------------------
  function sendReport(reason) {
    const latencyMs = getLiveState().latencyMs;

    if (senderBaseUrl) {
      const url = senderBaseUrl + '/latency';
      const payload = JSON.stringify({
        liveLatencyMs: latencyMs,
        playerState: 'PLAYING',
        reason: reason || 'tick'
      });
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }).catch(function (e) { console.error('[AM-Receiver] POST failed', e); });
    }
    console.log('[AM-Receiver] latency=' + latencyMs + 'ms base=' + senderBaseUrl);
  }

  // ---------------------------------------------------------------------------
  // 4) 시작 즉시 타이머 (이벤트 의존 X)
  // ---------------------------------------------------------------------------
  setInterval(function () { sendReport('tick'); }, REPORT_INTERVAL_MS);
  // catch-up 비활성화: hard seek이 LL-DASH edge 근처에서 버퍼링 루프를 유발해
  // 소리가 끊김. 폰이 setMusicShareSyncDelay로 보상하므로 receiver는 보고만 한다.
  // setInterval(applyLiveCatchup, 500);

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

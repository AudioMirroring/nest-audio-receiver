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
  const RECEIVER_VER = 'v10'; // index.html의 ?v= 와 함께 올릴 것 (캐시 확인용)
  const TARGET_LATENCY_MS = 1500;
  const REPORT_INTERVAL_MS = 1000;

  // catch-up 파라미터 (soft only — hard seek 금지)
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
  playbackConfig.autoResumeDuration = 0.5;  // 이만큼 차면 재생 시작/재개
  playbackConfig.autoPauseDuration = 0.2;   // 이 밑으로 떨어져야 자동 pause
  playbackConfig.autoResumeNumberOfSegments = 1;
  playbackConfig.initialBandwidth = 128000;
  // 시작 버퍼링 최소화: 기본값으로는 재생 시작 전 ~5초를 버퍼링해서
  // live edge에 그만큼 뒤처진 채 고정됨 (폰 latency 로그 6000ms의 정체).
  // CAF 버전에 따라 키 이름이 shakaConfiguration/shakaConfig로 다르므로 둘 다 설정.
  // Shaka 소스 분석(v4.3.4) 근거:
  // - 재생 시작/재개 게이트 = max(MPD minBufferTime, rebufferingGoal) 동안 playbackRate=0 강제
  // - STARVING 진입 = bufferLead < min(0.5, rebufferingGoal/2) → 0.01이면 사실상 게이트 제거
  // - defaultPresentationDelay: MPD에 suggestedPresentationDelay 없을 때 시작 위치 = edge - 1.5s
  const shakaCfg = {
    streaming: {
      lowLatencyMode: true,
      rebufferingGoal: 0.01,
      // 주의: CAF/Chromium 파이프라인이 재생 시작에 ~4.7s 버퍼를 요구함.
      // bufferingGoal을 그보다 작게 잡으면 Shaka가 fetch를 멈춰 데드락 (v9에서 확인).
      bufferingGoal: 10,
      inaccurateManifestTolerance: 0,
      updateIntervalSeconds: 0.5,
      stallEnabled: true
    },
    manifest: {
      defaultPresentationDelay: 1.5,
      dash: { ignoreMinBufferTime: true }
    }
  };
  playbackConfig.shakaConfiguration = shakaCfg;
  playbackConfig.shakaConfig = shakaCfg;
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
        // 적용 시점 문제 대비: LOAD 직전에 playbackConfig 재적용
        try { playerManager.setPlaybackConfig(playbackConfig); } catch (e) {}
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
    // CAF는 media 요소를 <cast-media-player>의 shadow DOM 안에 만들므로
    // 일반 querySelector로는 못 찾는다. shadowRoot가 열려 있으면 그 안을 뒤진다.
    var el = document.querySelector('video') || document.querySelector('audio');
    if (el) return el;
    try {
      var cmp = document.querySelector('cast-media-player');
      if (cmp && cmp.shadowRoot) {
        el = cmp.shadowRoot.querySelector('video') || cmp.shadowRoot.querySelector('audio');
        if (el) return el;
      }
    } catch (e) {}
    return null;
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

  // soft catch-up 전용. hard seek은 LL-DASH edge 근처에서 버퍼링 루프를
  // 유발해 소리를 끊어먹으므로 사용 금지 (2026-07-22 확인).
  // 백엔드가 rate shifter를 지원(audio_decoder_android: CreateRateShifter)하므로
  // shadow DOM 안의 media 요소 playbackRate를 직접 조정한다.
  let appliedRate = NORMAL_RATE;
  let catchupPath = 'none'; // 진단용: el(media element) / pm(playerManager) / none

  // 적응형 목표: catch-up 중 스톨(파이프라인 재버퍼링)이 감지되면 그 지점 위로
  // 목표를 올려 다시는 그 밑으로 파고들지 않는다 → 진동 제거, 바닥 자동 학습
  let effTargetMs = TARGET_LATENCY_MS;
  let prevLatencyMs = -1;

  function applyLiveCatchup() {
    const st = getLiveState();
    if (st.latencyMs < 0) return;

    // 스톨 감지: 배속 회수 중인데 latency가 오히려 증가(재생 멈춤) → 바닥에 부딪힘
    if (prevLatencyMs >= 0 && appliedRate > NORMAL_RATE &&
        st.latencyMs - prevLatencyMs > 400) {
      effTargetMs = Math.min(8000, Math.max(effTargetMs, prevLatencyMs + 800));
      console.log('[AM-Receiver] stall detected, effTarget=' + effTargetMs + 'ms');
    }
    prevLatencyMs = st.latencyMs;

    const excess = st.latencyMs - effTargetMs;
    let rate = NORMAL_RATE;
    if (excess > 3000) rate = 1.15;               // 많이 밀렸으면 빠르게 회수
    else if (excess > SOFT_CATCHUP_MARGIN_MS) rate = CATCHUP_RATE;

    const el = getMediaEl();
    try {
      if (el) {
        catchupPath = 'el';
        if (el.playbackRate !== rate) el.playbackRate = rate;
        appliedRate = el.playbackRate;
      } else if (typeof playerManager.setPlaybackRate === 'function') {
        catchupPath = 'pm';
        if (playerManager.getPlaybackRate() !== rate) playerManager.setPlaybackRate(rate);
        appliedRate = rate;
      } else {
        catchupPath = 'none';
      }
    } catch (e) {
      catchupPath = 'err';
    }
  }

  // ---------------------------------------------------------------------------
  // 3) 리포트 (GET, 하트비트 포함)
  // ---------------------------------------------------------------------------
  function sendReport(reason) {
    const latencyMs = getLiveState().latencyMs;

    if (senderBaseUrl) {
      const url = senderBaseUrl + '/latency';
      // ver에 진단 정보 포함: 버전|catch-up 경로|배속|적응목표|shaka버전|rebufferingGoal 실측
      // → 폰 로그만으로 설정 적용 여부까지 원격 확인
      let shakaVer = 'ns';
      let rbGoal = '?';
      try {
        if (window.shaka && shaka.Player) shakaVer = shaka.Player.version || 'y';
        const pc = playerManager.getPlaybackConfig && playerManager.getPlaybackConfig();
        const sc = pc && (pc.shakaConfiguration || pc.shakaConfig);
        if (sc && sc.streaming && sc.streaming.rebufferingGoal !== undefined) {
          rbGoal = sc.streaming.rebufferingGoal;
        }
      } catch (e) {}
      const payload = JSON.stringify({
        liveLatencyMs: latencyMs,
        ver: RECEIVER_VER + '|' + catchupPath + '|r' + appliedRate +
             '|t' + effTargetMs + '|sk' + shakaVer + '|rb' + rbGoal,
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
  // 적용 시점 문제 대비: start 옵션으로도 playbackConfig 전달
  options.playbackConfig = playbackConfig;

  context.start(options);
  console.log('[AM-Receiver] started (robust), target =', TARGET_LATENCY_MS);
})();

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
  const RECEIVER_VER = 'v15'; // index.html의 ?v= 와 함께 올릴 것 (캐시 확인용)
  // seekable range가 센티널(2^32s = duration 미상)로 나오는 경우가 있음
  // (인코더 재시작 직후 LOAD 레이스에서 관측). 이 값으로 catch-up이 켜지면
  // 오디오가 1.15배속으로 계속 재생되므로 반드시 무효 처리한다.
  const MAX_VALID_LATENCY_MS = 60000;
  // 이 기기(Pixel Tablet cast_shell)의 파이프라인은 재생 유지에 ~4초 버퍼를
  // 요구함(v10에서 실측: 3682ms까지 내려가면 스톨). 그 밑을 목표로 잡으면
  // 스톨→풍선→점프 진동이 나므로 바닥 위에 목표를 둔다.
  const TARGET_LATENCY_MS = 4500;
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
        everLoaded = true;
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
        const latencyMs = Math.round(latencySec * 1000);
        if (isFinite(latencySec) && latencySec >= 0 && latencyMs <= MAX_VALID_LATENCY_MS) {
          return { latencyMs: latencyMs, liveEdge: range.end, cur: cur };
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
        const latencyMs = Math.round(latencySec * 1000);
        if (isFinite(latencySec) && latencySec >= 0 && latencyMs <= MAX_VALID_LATENCY_MS) {
          return { latencyMs: latencyMs, liveEdge: liveEdge, cur: cur };
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
  let inStall = false; // 스톨 에피소드당 목표 상향은 1회만 (v10에서 연속 상향 폭주 버그)

  function applyLiveCatchup() {
    const st = getLiveState();
    if (st.latencyMs < 0) {
      // latency 무효(측정 실패/센티널) → 배속을 반드시 정상으로 원복.
      // 원복 없이 return만 하면 1.15배속에 박제됨 (2026-07-22 C300에서 관측)
      if (appliedRate !== NORMAL_RATE) {
        try {
          const el = getMediaEl();
          if (el) { el.playbackRate = NORMAL_RATE; appliedRate = el.playbackRate; }
        } catch (e) {}
      }
      return;
    }

    // 스톨 감지: 배속 회수 중인데 latency가 오히려 증가(재생 멈춤) → 바닥에 부딪힘
    if (prevLatencyMs >= 0 && st.latencyMs - prevLatencyMs > 400) {
      if (!inStall && appliedRate > NORMAL_RATE) {
        effTargetMs = Math.min(8000, Math.max(effTargetMs, prevLatencyMs + 800));
        console.log('[AM-Receiver] stall detected, effTarget=' + effTargetMs + 'ms');
      }
      inStall = true;
    } else if (prevLatencyMs >= 0 && st.latencyMs - prevLatencyMs < 100) {
      inStall = false; // latency 증가가 멈춤 → 스톨 종료
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
  // ── 자가 회복 ──────────────────────────────────────────────────────────
  // 재연결 레이스 등으로 페이지가 "재생은 되는데 측정 불능" 좀비 상태가 되면
  // 폰의 재-LOAD로는 복구 불가(같은 깨진 페이지 재사용). 유일한 해법은
  // receiver가 스스로 종료(context.stop())해서 다음 연결이 새 페이지로 뜨게 하는 것.
  // latency는 비디오 렌더링 제어의 입력이므로 측정 불능 = 기능 불능이다.
  let everLoaded = false;
  let unhealthyInvalidTicks = 0;  // PLAYING인데 측정 불능(-1)이 연속된 초
  let unhealthyFrozenTicks = 0;   // PLAYING인데 latency가 +1000ms/s로 폭주(재생 정지)한 연속 초
  let healthPrevLatency = -1;

  function checkSelfHeal(latencyMs, curSec) {
    let playing = false;
    try {
      playing = playerManager.getPlayerState() === cast.framework.messages.PlayerState.PLAYING;
    } catch (e) {}

    if (!everLoaded || !playing) {
      // pause/buffering/미로드 상태는 판정 제외 (pause 중 latency 증가는 정상 현상)
      unhealthyInvalidTicks = 0;
      unhealthyFrozenTicks = 0;
      healthPrevLatency = -1;
      return;
    }

    if (latencyMs < 0) {
      // latency 무효라도 cur가 살아있으면 폰이 직접 계산 가능 → 죽을 필요 없음.
      // 둘 다 죽었을 때(측정 완전 불능)만 카운트.
      if (curSec < 0) unhealthyInvalidTicks++;
      else unhealthyInvalidTicks = 0;
      unhealthyFrozenTicks = 0;
    } else {
      unhealthyInvalidTicks = 0;
      if (healthPrevLatency >= 0 && latencyMs - healthPrevLatency > 800) {
        unhealthyFrozenTicks++;
      } else {
        unhealthyFrozenTicks = 0;
      }
    }
    healthPrevLatency = latencyMs;

    if (unhealthyInvalidTicks >= 12 || unhealthyFrozenTicks >= 12) {
      console.error('[AM-Receiver] unhealthy (invalid=' + unhealthyInvalidTicks +
        ', frozen=' + unhealthyFrozenTicks + ') — self-stopping for fresh relaunch');
      try { context.stop(); } catch (e) {}
    }
  }

  // 폰에서 온 명령 처리. seekToEdge: 버퍼의 이전 콘텐츠(곡 변경 전 음원 등)를
  // 건너뛰고 live edge 근처로 점프 — LOAD 재전송과 달리 세션을 깨뜨리지 않는다.
  function handleCommand(cmd) {
    console.log('[AM-Receiver] command:', cmd);
    if (cmd === 'seekToEdge') {
      try {
        const r = playerManager.getLiveSeekableRange();
        if (r && typeof r.end === 'number' && isFinite(r.end) && r.end > 0.5) {
          playerManager.seek(r.end - 0.5);
          console.log('[AM-Receiver] seekToEdge -> ' + (r.end - 0.5));
        }
      } catch (e) {
        console.error('[AM-Receiver] seekToEdge failed', e);
      }
    }
  }

  function sendReport(reason) {
    const latencyMs = getLiveState().latencyMs;

    // 재생 위치(초): Shaka seekable range가 깨진 좀비 상태에서도 살아있는 단순 API.
    // 폰이 (인코더 PTS - cur)로 latency를 직접 계산하는 대체 경로의 입력.
    let curSec = -1;
    try {
      const c = playerManager.getCurrentTimeSec();
      if (typeof c === 'number' && isFinite(c) && c >= 0) curSec = c;
    } catch (e) {}

    checkSelfHeal(latencyMs, curSec);

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
        cur: curSec,
        ver: RECEIVER_VER + '|' + catchupPath + '|r' + appliedRate +
             '|t' + effTargetMs + '|sk' + shakaVer + '|rb' + rbGoal,
        reason: reason || 'tick'
      });
      // 응답은 폰→receiver 명령 채널: {"cmd":"seekToEdge"} 또는 {"cmd":null}
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }).then(function (res) { return res.json(); })
        .then(function (j) { if (j && j.cmd) handleCommand(j.cmd); })
        .catch(function (e) { /* 구버전 폰("OK" 응답) 등 무시 */ });
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

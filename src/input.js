/* ═══════════════════════════════════════════════════════════════════
   p08 · INPUT — keyboard · pointer orbit · parallax · touch · dive
   ───────────────────────────────────────────────────────────────────
   Every way the user touches the system besides the transport buttons
   (p06) and the search box (p02b) is handled here.

     §1  Local helpers (typing detection, clamps, action table)
     §2  Keyboard — the full keymap from AConfig.keybinds plus an
         extended set (number-seek, pitch/speed fine-tune, fullscreen,
         help, clear, demo), with repeat handling + focus guards
     §3  Pointer — drag-orbit the 3D camera with inertia, wheel-zoom,
         right-drag pan, double-click orbit boost, hover parallax
     §4  Touch — tap / two-finger pinch-zoom / swipe-up (pod) /
         swipe-down (dock)
     §5  Dive → main — the boot screen dismisses on the first real
         interaction and hands control to the live UI
     §6  Idle drift — a slow cinematic camera drift when no input for
         a while (keeps the scene alive on a hands-off screen)
     §7  Screen-reader announcements for transport changes

   It writes into Aqua.gl.camera (dYaw / dPitch / dRadius) and emits
   'ui:spin' / 'ui:zoom' on the bus (consumed by the geometry part).
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('input', function initInput(){
  'use strict';

  const A    = Aqua;
  const el   = A.el.bind(A);
  const bus  = A.bus;
  const S    = A.settings;
  const Q    = A.play;
  const CFG  = A.config;
  const M    = A.math.AMath;

  const cl  = (v, lo, hi) => (M && M.clamp) ? M.clamp(v, lo, hi) : Math.max(lo, Math.min(hi, v));

  /* ───────────────────────────────────────────────────────────────
     §1 · LOCAL HELPERS
  ─────────────────────────────────────────────────────────────── */

  /* true when the user is typing in a text field — global shortcuts
     must stand down in that case (except Escape). */
  function isTyping(e){
    const t = e && e.target;
    if(!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    if(tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if(t.isContentEditable) return true;
    return false;
  }

  /* the 3D camera (or null when WebGL is unavailable) */
  function cam(){
    return (A.gl && A.gl.camera) ? A.gl.camera : null;
  }

  /* ───────────────────────────────────────────────────────────────
     §2 · KEYBOARD
  ─────────────────────────────────────────────────────────────── */

  /* The base keymap comes from AConfig (single source of truth).  We
     layer an extended map on top for the extra shortcuts the lab hint
     panel advertises.  Each entry maps e.code → an action id. */
  const ACTIONS = {};
  const baseKeys = (CFG && CFG.keybinds) || {};
  for(const code in baseKeys){
    ACTIONS[code] = baseKeys[code];
  }
  /* extended shortcuts (do not shadow the base map) */
  const EXTENDED = {
    Digit0: 'seek-0',  Digit1: 'seek-1',  Digit2: 'seek-2',
    Digit3: 'seek-3',  Digit4: 'seek-4',  Digit5: 'seek-5',
    Digit6: 'seek-6',  Digit7: 'seek-7',  Digit8: 'seek-8',
    Digit9: 'seek-9',
    BracketLeft:  'pitch-down',
    BracketRight: 'pitch-up',
    Semicolon:    'speed-down',
    Equal:        'speed-up',
    KeyF:         'fullscreen',
    KeyH:         'help',
    KeyC:         'clear',
    KeyG:         'demo',
    KeyO:         'open-pod',
    KeyD:         'open-lib',
    KeyA:         'open-lab',
    Escape:       'escape'
  };
  for(const code in EXTENDED){
    if(!ACTIONS[code]) ACTIONS[code] = EXTENDED[code];
  }

  /* dispatch an action id.  Returns true if it was handled. */
  function dispatch(action, e){
    switch(action){
      case 'toggle-play': doToggle(); break;
      case 'skip-fwd':    doSkip(10); break;
      case 'skip-back':   doSkip(-10); break;
      case 'vol-up':      doVolume(+0.05); break;
      case 'vol-down':    doVolume(-0.05); break;
      case 'next':        doNext(); break;
      case 'prev':        doPrev(); break;
      case 'shuffle':     doShuffle(); break;
      case 'repeat':      doRepeat(); break;
      case 'mute':        doMute(); break;
      case 'theme':       doTheme(); break;
      case 'lab':         doLab(); break;
      case 'search':      doSearch(); break;

      case 'pitch-up':    doPitch(+1); break;
      case 'pitch-down':  doPitch(-1); break;
      case 'speed-up':    doSpeed(+0.05); break;
      case 'speed-down':  doSpeed(-0.05); break;
      case 'fullscreen':  doFullscreen(); break;
      case 'help':        doHelp(); break;
      case 'clear':       doClear(); break;
      case 'demo':        doDemo(); break;
      case 'open-pod':    doPod(); break;
      case 'open-lib':    doLib(); break;
      case 'open-lab':    doLab(); break;
      case 'escape':      doEscape(); break;

      default:
        if(action && action.indexOf('seek-') === 0){
          const pct = parseInt(action.slice(5), 10);
          if(!isNaN(pct)) doSeekPct(pct);
        }
        return false;
    }
    if(e && e.preventDefault) e.preventDefault();
    announce(action);
    return true;
  }

  /* ── individual actions ─────────────────────────────────────── */

  function safeAudio(fn){
    try{
      const au = A.audio;
      if(au && au.build) au.build();
    }catch(err){
      A.showBanner('AUDIO ENGINE OFFLINE: ' + (err && err.message || err), 4000);
      return false;
    }
    try{ if(au && au.resume) au.resume(); }catch(_){}
    fn();
    return true;
  }

  function doToggle(){
    if(!Q.list.length){
      /* empty queue — fall back to the demo generator (p09) */
      if(A.demo && A.demo.generate){
        safeAudio(() => A.demo.generate(true));
      }else{
        A.toast('Load tracks first — or press G for a demo signal', '◈');
      }
      return;
    }
    safeAudio(() => Q.toggle());
  }
  function doSkip(d){  safeAudio(() => Q.skip(d)); }
  function doNext(){   safeAudio(() => Q.next(false)); }
  function doPrev(){   safeAudio(() => Q.prev()); }

  function doVolume(delta){
    S.volume = cl((S.volume || 0) + delta, 0, 1);
    if(S.volume > 0 && S.muted){ S.muted = false; }
    A.saveSettings();
    if(A.audio && A.audio.applyVolume) A.audio.applyVolume();
    syncVolumeUI();
  }
  function doMute(){
    S.muted = !S.muted;
    A.saveSettings();
    if(A.audio && A.audio.applyVolume) A.audio.applyVolume();
    syncVolumeUI();
  }
  function syncVolumeUI(){
    const v = el('dockVol');
    if(v) v.value = S.volume;
    const m = el('dMute');
    if(m){ m.textContent = S.muted ? '🔇' : '🔊'; m.classList.toggle('on', !!S.muted); }
  }

  function doShuffle(){
    Q.setShuffle(!Q.shuffle);
    A.toast('Shuffle ' + (Q.shuffle ? 'ON' : 'OFF'), '⤨');
  }
  function doRepeat(){
    Q.cycleRepeat();
    A.toast('Repeat ' + (Q.repeat === null ? 'OFF' : (Q.repeat === 'one' ? 'ONE' : 'ALL')), '⟳');
  }
  function doTheme(){
    A.setTheme(A.getTheme() === 'dark' ? 'light' : 'dark');
  }
  function doLab(){
    if(A.lib && A.lib.setLab) A.lib.setLab();
  }
  function doLib(){
    if(A.lib && A.lib.toggleLib) A.lib.toggleLib();
  }
  function doPod(){
    const pod = el('pod');
    if(pod) pod.classList.toggle('open');
  }

  function doSearch(){
    const si = el('searchInput');
    if(si){
      si.focus();
      si.select && si.select();
    }
  }

  function doPitch(delta){
    S.pitch = cl((S.pitch || 0) + delta, -6, 6);
    A.saveSettings();
    syncLabSlider('pitchS', 'pitchV', S.pitch, pitchFmt);
    pushLab();
    A.toast('Pitch ' + pitchFmt(S.pitch), '∿');
  }
  function doSpeed(delta){
    S.speed = cl((S.speed || 1) + delta, 0.5, 2);
    A.saveSettings();
    syncLabSlider('speedS', 'speedV', S.speed, speedFmt);
    pushLab();
    A.toast('Speed ' + speedFmt(S.speed), '»');
  }
  function pitchFmt(v){ return (Math.round(v*10)/10 > 0 ? '+' : '') + (Math.round(v*10)/10) + ' st'; }
  function speedFmt(v){ return (Math.round(v*100)/100).toFixed(2) + 'x'; }
  function pushLab(){
    if(A.lib && A.lib.pushAudio) A.lib.pushAudio();
  }
  function syncLabSlider(sliderId, labelId, value, fmt){
    const s = el(sliderId), l = el(labelId);
    if(s) s.value = value;
    if(l) l.textContent = fmt(value);
  }

  function doFullscreen(){
    const t = el('theater');
    const target = (t && t.classList.contains('open')) ? t : (el('stage') || document.documentElement);
    if(!document.fullscreenElement){
      const p = target.requestFullscreen && target.requestFullscreen();
      if(p && p.catch) p.catch(() => {});
    }else{
      const p = document.exitFullscreen && document.exitFullscreen();
      if(p && p.catch) p.catch(() => {});
    }
  }

  function doHelp(){
    A.toast(
      'SPACE play · ←/→ 10s · N/P · S shuffle · R repeat · ' +
      '↑/↓ vol · M mute · T theme · L lab · A lab · D lib · ' +
      '/ search · 0-9 seek · [ ] pitch · ;/= speed · F fullscreen · ' +
      'G demo · C clear · ESC close',
      '⌨', 6000
    );
  }

  function doClear(){
    if(!Q.list.length){ A.toast('Library already empty', '·'); return; }
    if(A.lib && A.lib.clear) A.lib.clear();
  }

  function doDemo(){
    if(A.demo && A.demo.generate){
      safeAudio(() => A.demo.generate(true));
    }else{
      A.toast('Demo generator offline', '⚠');
    }
  }

  function doEscape(){
    /* close, in order of topmost: theater → lab → pod → dive */
    const theater = el('theater');
    if(theater && theater.classList.contains('open')){
      const tc = el('theaterClose');
      if(tc) tc.click();
      return;
    }
    const lab = el('labPanel');
    if(lab && lab.classList.contains('open')){
      A.lib && A.lib.setLab ? A.lib.setLab(false) : lab.classList.remove('open');
      return;
    }
    const pod = el('pod');
    if(pod && pod.classList.contains('open')){
      pod.classList.remove('open');
      return;
    }
    /* blur any focused input */
    const si = el('searchInput');
    if(si && document.activeElement === si){ si.blur(); }
  }

  function doSeekPct(pct){
    const d = Q.duration;
    if(!d || !isFinite(d)) return;
    Q.seek((pct / 100) * d);
    A.toast('Seek ' + (pct * 10) + '%', '⏱');
  }

  /* ── the keydown handler ────────────────────────────────────── */

  let lastKeyTime = 0;
  function onKeyDown(e){
    /* Escape + Ctrl/Cmd combos always work, even while typing */
    const isEscape = (e.code === 'Escape');
    const isCombo  = (e.ctrlKey || e.metaKey);
    if(isTyping(e) && !isEscape && !isCombo) return;

    /* let the browser handle browser-level combos (e.g. Cmd+R) */
    if(isCombo) return;

    const action = ACTIONS[e.code];
    if(!action) return;

    /* key-repeat: volume/seek/pitch/speed can repeat; toggles cannot */
    const noRepeat = { 'toggle-play':1, 'shuffle':1, 'repeat':1, 'mute':1,
                       'theme':1, 'lab':1, 'help':1, 'clear':1, 'demo':1,
                       'open-pod':1, 'open-lib':1, 'open-lab':1, 'escape':1,
                       'fullscreen':1, 'search':1 };
    if(e.repeat && noRepeat[action]) return;

    /* throttle the repeatable ones to ~90ms so a held key doesn't
       strobe the UI */
    const now = performance.now();
    if(e.repeat && (now - lastKeyTime) < 90) return;
    lastKeyTime = now;

    if(action === 'escape' || dispatch(action, e)){
      if(e.preventDefault) e.preventDefault();
      markActivity();
    }
  }

  /* ───────────────────────────────────────────────────────────────
     §3 · POINTER — orbit · zoom · parallax
  ─────────────────────────────────────────────────────────────── */

  const PTR = {
    down: false,
    button: 0,
    x: 0, y: 0,          // last position
    px: 0, py: 0,        // position at press
    velYaw: 0, velPitch: 0,  // inertia
    moved: 0,            // total px moved (tap vs drag)
    parallaxX: 0, parallaxY: 0,   // smoothed hover offset
    parallaxTX: 0, parallaxTY: 0, // hover target
    lastMove: 0
  };

  /* the stage is the orbit surface; the whole window receives the
     pointer events so a drag that leaves the stage keeps tracking */
  function stageEl(){ return el('stage'); }

  function wirePointer(){
    const stage = stageEl();
    const win = window;

    win.addEventListener('pointerdown', onPointerDown, { passive: false });
    win.addEventListener('pointermove', onPointerMove, { passive: false });
    win.addEventListener('pointerup',   onPointerUp,   { passive: false });
    win.addEventListener('pointercancel', onPointerUp, { passive: false });
    win.addEventListener('wheel', onWheel, { passive: false });
    if(stage){
      stage.addEventListener('dblclick', onStageDblClick);
    }
    document.addEventListener('mouseleave', () => {
      PTR.parallaxTX = 0; PTR.parallaxTY = 0;
    });
  }

  /* only orbit when the press starts on the 3D stage (not on a panel,
     the dock, or a slider) */
  function isOrbitSurface(target){
    if(!target) return false;
    /* ignore presses inside any interactive panel / control */
    const ignore = ['INPUT','BUTTON','SELECT','TEXTAREA','A','CANVAS'];
    /* but the glCanvas + stage + fx2d ARE the orbit surface */
    let n = target;
    while(n && n !== document.body){
      const id = n.id || '';
      if(id === 'stage' || id === 'glCanvas' || id === 'fx2d' ||
         id === 'dive' || n.classList && n.classList.contains('screen')){
        return true;
      }
      const tag = (n.tagName || '').toUpperCase();
      if(ignore.indexOf(tag) >= 0) return false;
      if(n.id === 'libPanel' || n.id === 'labPanel' || n.id === 'pod' ||
         n.id === 'dock' || n.id === 'theater') return false;
      n = n.parentElement;
    }
    return false;
  }

  function onPointerDown(e){
    markActivity();
    /* right-button drag = pan the camera target */
    PTR.button = (e.button == null) ? 0 : e.button;
    PTR.down = true;
    PTR.x = e.clientX; PTR.y = e.clientY;
    PTR.px = e.clientX; PTR.py = e.clientY;
    PTR.moved = 0;
    PTR.velYaw = 0; PTR.velPitch = 0;
    PTR.orbiting = isOrbitSurface(e.target);
    PTR.panning  = (PTR.button === 2) && PTR.orbiting;
    if(PTR.orbiting){
      try{ e.preventDefault(); }catch(_){}
    }
  }

  function onPointerMove(e){
    const nx = e.clientX, ny = e.clientY;

    /* hover parallax (always tracked, even when not pressed) */
    PTR.parallaxTX = (nx / Math.max(1, window.innerWidth)  - 0.5) * 2; // -1..1
    PTR.parallaxTY = (ny / Math.max(1, window.innerHeight) - 0.5) * 2;
    PTR.lastMove = performance.now();

    if(!PTR.down) return;
    const dx = nx - PTR.x;
    const dy = ny - PTR.y;
    PTR.x = nx; PTR.y = ny;
    PTR.moved += Math.abs(dx) + Math.abs(dy);

    const c = cam();
    if(PTR.panning && c){
      /* pan the look-at target in the camera's local plane */
      const s = 0.0016 * c.radius;
      const cp = Math.cos(c.pitch);
      const fwd = { x: -Math.sin(c.yaw) * cp, z: -Math.cos(c.yaw) * cp };
      const right = { x: Math.cos(c.yaw), z: -Math.sin(c.yaw) };
      c.target.x = cl(c.target.x + (right.x * -dx + fwd.x * -dy) * s, -6, 6);
      c.target.z = cl(c.target.z + (right.z * -dx + fwd.z * -dy) * s, -6, 6);
      c.target.y = cl(c.target.y + dy * s * 0.6, -2, 4);
      return;
    }

    if(!PTR.orbiting) return;
    if(c){
      /* orbit: horizontal → yaw, vertical → pitch */
      const k = 0.006;
      c.dYaw   = cl(c.dYaw   + dx * k, -Math.PI, Math.PI);
      c.dPitch = cl(c.dPitch + dy * k, -1.2, 1.25);
      PTR.velYaw   = dx * k;
      PTR.velPitch = dy * k;
      /* also spin the 3D object a little so it feels physical */
      bus.emit('ui:spin', dx * 0.0009);
    }
  }

  function onPointerUp(e){
    if(!PTR.down) return;
    PTR.down = false;
    const wasTap = (PTR.moved < 6);
    const surface = PTR.orbiting;
    PTR.orbiting = false;
    PTR.panning = false;
    if(wasTap && surface){
      /* a clean tap on the stage = play/pause (mirrors the space bar) */
      doToggle();
    }
  }

  function onWheel(e){
    if(!isOrbitSurface(e.target) && !PTR.down) return;
    e.preventDefault();
    markActivity();
    const dy = (e.deltaY || 0);
    const zoom = dy * 0.0016;
    const c = cam();
    if(c){
      c.dRadius = cl(c.dRadius + zoom, 4.2, 16);
    }
    bus.emit('ui:zoom', zoom);
  }

  function onStageDblClick(){
    markActivity();
    /* double-click = a confident orbit boost + a spin kick */
    const c = cam();
    if(c){
      c.dRadius = cl(c.dRadius - 0.9, 4.2, 16);
    }
    bus.emit('ui:spin', 0.6);
    bus.emit('ui:zoom', -0.5);
  }

  /* ── inertia + parallax smoothing (runs on its own rAF) ─────── */

  let inputRaf = 0;
  function inputLoop(){
    const c = cam();
    if(c){
      /* inertia: keep spinning after release, with friction */
      if(!PTR.down){
        if(Math.abs(PTR.velYaw) > 0.0004 || Math.abs(PTR.velPitch) > 0.0004){
          c.dYaw   = cl(c.dYaw   + PTR.velYaw,   -Math.PI, Math.PI);
          c.dPitch = cl(c.dPitch + PTR.velPitch, -1.2, 1.25);
          PTR.velYaw   *= 0.94;
          PTR.velPitch *= 0.94;
        }
      }
      /* hover parallax: a gentle, eased offset layered on the yaw */
      const pk = 0.06;
      PTR.parallaxX += (PTR.parallaxTX - PTR.parallaxX) * pk;
      PTR.parallaxY += (PTR.parallaxTY - PTR.parallaxY) * pk;
      if(!PTR.down){
        c.dYaw   = cl(c.dYaw   + PTR.parallaxX * 0.02, -Math.PI, Math.PI);
        c.dPitch = cl(c.dPitch + PTR.parallaxY * 0.012, -1.2, 1.25);
      }
    }
    inputRaf = requestAnimationFrame(inputLoop);
  }

  /* ───────────────────────────────────────────────────────────────
     §4 · TOUCH GESTURES
  ─────────────────────────────────────────────────────────────── */

  const TOUCH = {
    active: false,
    pins: {},
    lastDist: 0,
    lastMidY: 0,
    startMidY: 0,
    startT: 0
  };

  function wireTouch(){
    if(!('ontouchstart' in window) && !(navigator && navigator.maxTouchPoints > 0)){
      return;   // pointer events already cover mouse
    }
    const stage = stageEl();
    if(!stage) return;

    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove',  onTouchMove,  { passive: false });
    stage.addEventListener('touchend',   onTouchEnd,   { passive: true });
    stage.addEventListener('touchcancel',onTouchEnd,   { passive: true });
  }

  function onTouchStart(e){
    markActivity();
    TOUCH.active = true;
    TOUCH.startT = performance.now();
    TOUCH.pins = {};
    for(let i = 0; i < e.touches.length; i++){
      TOUCH.pins[e.touches[i].identifier] = { x: e.touches[i].clientX, y: e.touches[i].clientY };
    }
    if(e.touches.length === 1){
      TOUCH.lastMidY = e.touches[0].clientY;
      TOUCH.startMidY = e.touches[0].clientY;
    }else if(e.touches.length === 2){
      TOUCH.lastDist = touchDist(e.touches);
    }
  }

  function onTouchMove(e){
    if(!TOUCH.active) return;
    const c = cam();
    if(e.touches.length === 2 && c){
      e.preventDefault();
      const d = touchDist(e.touches);
      const delta = TOUCH.lastDist - d;      // pinch-in → positive → zoom in
      TOUCH.lastDist = d;
      c.dRadius = cl(c.dRadius - delta * 0.012, 4.2, 16);
      bus.emit('ui:zoom', -delta * 0.02);
    }else if(e.touches.length === 1){
      const y = e.touches[0].clientY;
      const dy = y - TOUCH.lastMidY;
      TOUCH.lastMidY = y;
      if(c){
        c.dPitch = cl(c.dPitch + dy * 0.004, -1.2, 1.25);
        c.dYaw   = cl(c.dYaw   + 0, -Math.PI, Math.PI);
        bus.emit('ui:spin', 0.0001);
      }
    }
  }

  function onTouchEnd(e){
    if(!TOUCH.active) return;
    const dt = performance.now() - TOUCH.startT;
    const remaining = e.touches.length;
    if(remaining === 0){
      const totalDy = TOUCH.lastMidY - TOUCH.startMidY;
      /* a quick vertical swipe */
      if(dt < 420 && Math.abs(totalDy) > 70){
        if(totalDy > 0){
          /* swipe up → open the pod (listening room) */
          const pod = el('pod');
          if(pod) pod.classList.add('open');
        }else{
          /* swipe down → collapse the pod, reveal the dock focus */
          const pod = el('pod');
          if(pod) pod.classList.remove('open');
        }
      }
      TOUCH.active = false;
    }
    /* keep the surviving pins */
    TOUCH.pins = {};
    for(let i = 0; i < remaining; i++){
      TOUCH.pins[e.touches[i].identifier] = { x: e.touches[i].clientX, y: e.touches[i].clientY };
    }
    if(remaining === 1){
      TOUCH.lastMidY = TOUCH.startMidY = e.touches[0].clientY;
    }
  }

  function touchDist(touches){
    const a = touches[0], b = touches[1];
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ───────────────────────────────────────────────────────────────
     §5 · DIVE → MAIN
  ─────────────────────────────────────────────────────────────── */

  /* The dive (boot) screen sits over the stage.  It is dismissed the
     moment the user loads a track (p06 does that) OR on the first
     meaningful interaction.  Here we make sure the very first gesture
     wakes the engine and fades the dive. */
  function wireDive(){
    const dive = el('dive');
    if(!dive) return;
    /* clicking the dive backdrop (not a button) dismisses it */
    dive.addEventListener('click', (e) => {
      if(e.target === dive || (e.target.className &&
         String(e.target.className).indexOf('dive-frame') >= 0)){
        dismissDive();
      }
    });
    /* any key also dismisses it (handled by onKeyDown via markActivity) */
  }

  function dismissDive(){
    const dive = el('dive');
    if(dive) dive.classList.remove('on');
  }

  /* ───────────────────────────────────────────────────────────────
     §6 · IDLE DRIFT
  ─────────────────────────────────────────────────────────────── */

  const IDLE = {
    last: 0,
    drift: 0
  };
  const IDLE_AFTER = 6000;   // ms of no input before the drift starts

  function markActivity(){
    IDLE.last = performance.now();
    IDLE.drift = 0;
  }

  let idleRaf = 0;
  function idleLoop(){
    const c = cam();
    const now = performance.now();
    const since = now - IDLE.last;
    if(c && !PTR.down){
      if(since > IDLE_AFTER){
        /* a slow, continuous yaw crawl — cinematic on a hands-off
           screen.  It eases in so it never snaps. */
        IDLE.drift = Math.min(1, IDLE.drift + 0.0025);
        c.dYaw = cl(c.dYaw + 0.00022 * IDLE.drift, -Math.PI, Math.PI);
      }else{
        IDLE.drift = Math.max(0, IDLE.drift - 0.02);
      }
    }
    idleRaf = requestAnimationFrame(idleLoop);
  }

  /* ───────────────────────────────────────────────────────────────
     §7 · SCREEN-READER ANNOUNCEMENTS
  ─────────────────────────────────────────────────────────────── */

  let srRegion = null;
  function ensureSr(){
    if(srRegion) return srRegion;
    srRegion = document.createElement('div');
    srRegion.setAttribute('aria-live', 'polite');
    srRegion.setAttribute('role', 'status');
    srRegion.className = 'sr-only';
    srRegion.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;' +
      'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';
    document.body.appendChild(srRegion);
    return srRegion;
  }
  function announce(action){
    try{
      const region = ensureSr();
      const t = Q.current;
      let msg = '';
      switch(action){
        case 'toggle-play':
          msg = (Q.state === 'playing' ? 'Playing ' : 'Paused ') + (t ? t.name : '');
          break;
        case 'next':  msg = 'Next track' + (t ? ' ' + t.name : ''); break;
        case 'prev':  msg = 'Previous track' + (t ? ' ' + t.name : ''); break;
        case 'mute':  msg = S.muted ? 'Muted' : 'Unmuted'; break;
        case 'shuffle': msg = 'Shuffle ' + (Q.shuffle ? 'on' : 'off'); break;
        case 'repeat':  msg = 'Repeat ' + (Q.repeat === null ? 'off' : Q.repeat); break;
        default: msg = '';
      }
      if(msg) region.textContent = msg;
    }catch(_){}
  }

  /* ───────────────────────────────────────────────────────────────
     BOOT
  ─────────────────────────────────────────────────────────────── */

  document.addEventListener('keydown', onKeyDown, { passive: false });
  wirePointer();
  wireTouch();
  wireDive();

  /* the engine LED flips to READY once the GL part is up (p03 emits
     gl:ready) — a nice confirmation that the 3D scene is live */
  bus.on('gl:ready', () => {
    const led = el('ledEngine'), stat = el('statEngine');
    if(led) led.classList.add('on');
    if(stat) stat.textContent = 'ENGINE: READY';
  });

  markActivity();
  inputRaf = requestAnimationFrame(inputLoop);
  idleRaf  = requestAnimationFrame(idleLoop);

  /* expose for testing + other parts */
  A.input = {
    dispatch: dispatch,
    actions: ACTIONS,
    orbit: {
      rotate: (dx, dy) => {
        const c = cam();
        if(!c) return;
        c.dYaw   = cl(c.dYaw   + dx * 0.006, -Math.PI, Math.PI);
        c.dPitch = cl(c.dPitch + dy * 0.006, -1.2, 1.25);
      },
      zoom: (d) => {
        const c = cam();
        if(!c) return;
        c.dRadius = cl(c.dRadius + d, 4.2, 16);
        bus.emit('ui:zoom', d);
      }
    },
    state: PTR,
    dismissDive: dismissDive
  };

  console.info('[Aqua Input] keyboard + pointer + touch online — ' + Object.keys(ACTIONS).length + ' shortcuts');
});

/* ═══════════════ PART: p09_demo.js ═══════════════ */

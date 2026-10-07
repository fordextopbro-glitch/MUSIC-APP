/* ═══════════════════════════════════════════════════════════════════
   PART p02b · AMBIENT 2D LAYER + HUD BOOTSTRAP
   ─────────────────────────────────────────────────────────────────
   · Full-screen synthwave grid (retro-neon floor + star field)
     rendered on the 2D canvas — visible until the WebGL part
     takes over (event "gl:ready"), then this layer idles.
   · Theme engine (VOID dark / CHROME light), persisted.
   · Toast system, engine banner, FPS readout, status LEDs.
   · Global pointer events → "ui:ripple" bus events.
   · All subsystems call Aqua.toast / Aqua.setTheme from here.
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('ambient2d', function initAmbient(){
  'use strict';

  const cvs = Aqua.el('fx2d');
  if(!cvs) throw new Error('fx2d canvas missing');
  const ctx = cvs.getContext('2d');
  if(!ctx) throw new Error('2d context unavailable');

  if(!Aqua.bus){
    Aqua.bus = new EventBus();
  }
  if(!Aqua.flags) Aqua.flags = { glReady: false, audioReady: false, playing: false };

  /* ── local state ─────────────────────────────────────────────── */
  let W = 0, H = 0, DPR = 1;
  let t = 0, lastNow = performance.now();
  let active = true;          // false once WebGL takes the stage
  let energy = 0;             // 0..1 music energy (from bus)
  let mouse = { x: 0, y: 0, on: false };
  let theme = null;           // cached CSS custom props
  let stars = [];
  let ripples = [];
  let pulses = [];            // moving data-pulse dots on grid columns
  let PULSE_COUNT = 10;

  /* ── theme cache (read from CSS custom properties) ───────────── */
  function readTheme(){
    const cs = getComputedStyle(document.documentElement);
    const g = k => (cs.getPropertyValue(k) || '').trim();
    theme = {
      a1: g('--a1') || '#00e5ff',
      a2: g('--a2') || '#ff2d95',
      a3: g('--a3') || '#7c4dff',
      bg0: g('--bg0') || '#020308',
      bg1: g('--bg1') || '#05070f',
      bg2: g('--bg2') || '#090d1c',
      dark: document.documentElement.dataset.theme !== 'light'
    };
    seedStars();
  }

  /* ── sizing ──────────────────────────────────────────────────── */
  function resize(){
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth;
    H = window.innerHeight;
    cvs.width = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    cvs.style.width = W + 'px';
    cvs.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    seedPulses();
  }

  function seedStars(){
    stars = [];
    const n = Math.round((W * H) / 9000);
    const rnd = ARand.seeded('stars-' + (theme ? theme.dark : 'light'));
    for(let i = 0; i < n; i++){
      stars.push({
        x: rnd.next(),
        y: rnd.range(0, 0.44),
        r: rnd.range(0.4, 1.7),
        ph: rnd.range(0, TWO_PI),
        sp: rnd.range(0.4, 1.6)
      });
    }
  }

  function seedPulses(){
    pulses = [];
    for(let i = 0; i < PULSE_COUNT; i++){
      pulses.push({
        col: i,
        off: ARand.seeded('pulse-' + i).range(0, 1),
        sp: 0.25 + ARand.seeded('psp-' + i).range(0, 0.5)
      });
    }
  }

  /* ── drawing ─────────────────────────────────────────────────── */
  function horizonY(){
    return H * 0.44 + (mouse.on ? (mouse.y - H * 0.5) * 0.012 : 0);
  }

  function vanishingX(){
    return W * 0.5 + (mouse.on ? (mouse.x - W * 0.5) * 0.03 : 0);
  }

  function drawSky(hy, vx){
    /* base gradient */
    const sky = ctx.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, theme.bg0);
    sky.addColorStop(1, theme.bg1);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hy + 1);

    /* stars (twinkle) */
    for(let i = 0; i < stars.length; i++){
      const s = stars[i];
      const tw = 0.45 + 0.55 * Math.sin(t * s.sp + s.ph);
      ctx.globalAlpha = tw * (theme.dark ? 0.8 : 0.5);
      ctx.fillStyle = i % 7 === 0 ? theme.a1 : '#ffffff';
      const x = s.x * W;
      const y = s.y * H;
      ctx.fillRect(x, y, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    /* horizon glow (accent nebula) */
    const gl = ctx.createRadialGradient(vx, hy, 0, vx, hy, W * 0.55);
    const gA = 0.16 + energy * 0.14;
    gl.addColorStop(0, AColor.rgba(theme.a3, gA));
    gl.addColorStop(0.45, AColor.rgba(theme.a1, gA * 0.4));
    gl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gl;
    ctx.fillRect(0, 0, W, hy + 2);

    /* horizon line */
    ctx.strokeStyle = AColor.rgba(theme.a1, 0.16 + energy * 0.2);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, hy);
    ctx.lineTo(W, hy);
    ctx.stroke();
    ctx.strokeStyle = AColor.rgba(theme.a1, 0.65 + energy * 0.3);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, hy);
    ctx.lineTo(W, hy);
    ctx.stroke();
  }

  function drawFloor(hy, vx){
    const bottom = H + 4;
    const cols = 26;

    /* vertical fan lines from vanishing point */
    ctx.lineWidth = 1;
    for(let i = -13; i <= 13; i++){
      const xb = vx + i * (W * 0.085);
      const alpha = 0.05 + 0.20 * (1 - Math.abs(i) / 14);
      ctx.strokeStyle = AColor.rgba(theme.a1, alpha + energy * 0.08);
      ctx.beginPath();
      ctx.moveTo(vx, hy);
      ctx.lineTo(xb, bottom);
      ctx.stroke();
    }

    /* horizontal scan lines (perspective-compressed, scrolling) */
    const rows = 30;
    const speed = 0.55 * (1 + energy * 1.6);
    const offset = AMath.fract(t * speed);
    for(let k = 0; k < rows; k++){
      const p = (k + offset) / rows;
      const y = hy + (bottom - hy) * p * p;
      const a = (0.05 + p * 0.4) * (0.75 + energy * 0.5);
      ctx.strokeStyle = AColor.rgba(
        k % 5 === 0 ? theme.a2 : theme.a1,
        AMath.clamp01(a)
      );
      ctx.lineWidth = k % 5 === 0 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    /* data pulses travelling down the columns */
    for(let i = 0; i < pulses.length; i++){
      const pl = pulses[i];
      const idx = pl.col - Math.floor((PULSE_COUNT - 1) / 2);
      const xb = vx + idx * (W * 0.085);
      const p = AMath.fract(t * pl.sp * (0.6 + energy) + pl.off);
      const y = hy + (bottom - hy) * p * p;
      const fade = p < 0.08 ? p / 0.08 : (p > 0.92 ? (1 - p) / 0.08 : 1);
      ctx.fillStyle = AColor.rgba(theme.a2, 0.7 * fade);
      ctx.beginPath();
      ctx.arc(xb, y, 1.8 + energy * 1.4, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = AColor.rgba(theme.a2, 0.14 * fade);
      ctx.beginPath();
      ctx.arc(xb, y, 5 + energy * 3, 0, TWO_PI);
      ctx.fill();
    }

    /* fog near horizon for depth */
    const fog = ctx.createLinearGradient(0, hy, 0, hy + (bottom - hy) * 0.28);
    fog.addColorStop(0, AColor.rgba(theme.bg1, 0.95));
    fog.addColorStop(1, AColor.rgba(theme.bg1, 0));
    ctx.fillStyle = fog;
    ctx.fillRect(0, hy, W, (bottom - hy) * 0.28);
  }

  function drawRipples(){
    for(let i = ripples.length - 1; i >= 0; i--){
      const r = ripples[i];
      r.r += r.vr;
      r.vr *= 0.984;
      r.a *= 0.955;
      if(r.a < 0.02){
        ripples.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = AColor.rgba(theme.a1, r.a);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, TWO_PI);
      ctx.stroke();
      ctx.strokeStyle = AColor.rgba(theme.a2, r.a * 0.5);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r * 0.62, 0, TWO_PI);
      ctx.stroke();
    }
  }

  function draw(){
    if(!theme) readTheme();
    const hy = horizonY();
    const vx = vanishingX();
    ctx.clearRect(0, 0, W, H);
    /* below-horizon base fill (floor background) */
    ctx.fillStyle = theme.bg0;
    ctx.fillRect(0, hy, W, H - hy);
    drawSky(hy, vx);
    drawFloor(hy, vx);
    drawRipples();
  }

  /* ── frame loop ──────────────────────────────────────────────── */
  function frame(now){
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    t += dt;
    if(active && !document.hidden){
      draw();
      Aqua.perf.tick();
    }
    requestAnimationFrame(frame);
  }

  /* ═════════════════════════════════════════════════════════════
     HUD BOOTSTRAP (theme / toasts / banner / LEDs / FPS)
  ═══════════════════════════════════════════════════════════════ */

  /* ── toasts ──────────────────────────────────────────────────── */
  Aqua.toast = function(msg, ico){
    const box = Aqua.el('toasts');
    if(!box) return;
    while(box.children.length >= 4) box.firstChild.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = '<span class="t-ico"></span><span class="t-msg"></span>';
    el.querySelector('.t-ico').textContent = ico || '◈';
    el.querySelector('.t-msg').textContent = String(msg);
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 450);
    }, 2600);
  };

  /* ── engine banner (fatal / warning) ─────────────────────────── */
  Aqua.showBanner = function(msg, ms){
    const b = Aqua.el('engineBanner');
    if(!b) return;
    b.textContent = '⚠ ' + String(msg);
    b.classList.add('show');
    clearTimeout(Aqua.showBanner._t);
    if(ms){
      Aqua.showBanner._t = setTimeout(() => b.classList.remove('show'), ms);
    }
  };

  /* ── status LEDs ─────────────────────────────────────────────── */
  function setLed(id, cls, labelId, label){
    const led = Aqua.el(id);
    if(led){
      led.classList.remove('on', 'warn', 'err');
      if(cls) led.classList.add(cls);
    }
    if(labelId){
      const l = Aqua.el(labelId);
      if(l) l.textContent = label;
    }
  }

  /* ── theme engine ────────────────────────────────────────────── */
  Aqua.setTheme = function(next, silent){
    const t = (next === 'light') ? 'light' : 'dark';
    Aqua.settings.theme = t;
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
    const icon = Aqua.el('themeIcon');
    if(icon) icon.textContent = t === 'dark' ? '◐' : '◑';
    const btn = Aqua.el('themeBtn');
    if(btn) btn.title = t === 'dark' ? 'Switch to CHROME / light (T)' : 'Switch to VOID / dark (T)';
    Aqua.saveSettings();
    readTheme();
    Aqua.bus.emit('theme:change', t);
    if(!silent) Aqua.toast(t === 'dark' ? 'Theme: VOID (dark)' : 'Theme: CHROME (light)', '◐');
  };

  Aqua.getTheme = function(){
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  };

  /* ── dynamic palette switching (per track) ───────────────────── */
  Aqua.setPalette = function(p){
    const r = document.documentElement.style;
    r.setProperty('--a1', p.a1);
    r.setProperty('--a2', p.a2);
    r.setProperty('--a3', p.a3);
    readTheme();
    Aqua.bus.emit('palette:change', p);
  };

  /* ── pointer events → bus ────────────────────────────────────── */
  window.addEventListener('pointermove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.on = true;
  }, { passive: true });

  document.addEventListener('mouseleave', () => { mouse.on = false; });
  window.addEventListener('blur', () => { mouse.on = false; });

  window.addEventListener('pointerdown', e => {
    Aqua.bus.emit('ui:ripple', { x: e.clientX, y: e.clientY });
  }, { passive: true });

  /* UI-level tap ripple (DOM span) on interactive elements */
  window.addEventListener('pointerdown', e => {
    const node = e.target && e.target.closest
      ? e.target.closest('button, .lib-row, .chip, .tgl, .dial, .tbtn, .pbtn')
      : null;
    if(node && node.tagName !== 'INPUT'){
      const r = node.getBoundingClientRect();
      const d = Math.max(r.width, r.height) * 1.7;
      const s = document.createElement('span');
      s.className = 'u-ripple';
      s.style.width = s.style.height = d + 'px';
      s.style.left = (e.clientX - r.left - d / 2) + 'px';
      s.style.top = (e.clientY - r.top - d / 2) + 'px';
      if(getComputedStyle(node).position === 'static') node.style.position = 'relative';
      node.appendChild(s);
      s.addEventListener('animationend', () => s.remove());
    }
  }, { passive: true });

  /* ── bus subscriptions ───────────────────────────────────────── */
  Aqua.bus.on('ui:ripple', r => {
    if(ripples.length < 26) ripples.push({ x: r.x, y: r.y, r: 4, vr: 2.4, a: 0.5 });
  });
  Aqua.bus.on('theme:change', () => readTheme());
  Aqua.bus.on('audio:energy', e => { energy = AMath.clamp01(e); });
  Aqua.bus.on('gl:ready', () => { active = false; });
  Aqua.bus.on('gl:lost', () => { active = true; });

  /* ── header buttons (wire now so shell is alive pre-engine) ──── */
  const themeBtn = Aqua.el('themeBtn');
  if(themeBtn){
    themeBtn.addEventListener('click', () => {
      Aqua.setTheme(Aqua.getTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  const searchClear = Aqua.el('searchClear');
  const searchInput = Aqua.el('searchInput');
  if(searchClear && searchInput){
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      Aqua.bus.emit('search:input', '');
      searchInput.blur();
    });
  }
  if(searchInput){
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      searchClear.style.display = q ? 'flex' : 'none';
      const cnt = Aqua.el('searchCount');
      if(cnt) cnt.style.display = 'none';
      Aqua.bus.emit('search:input', q);
    });
  }

  /* ── FPS readout ─────────────────────────────────────────────── */
  const fpsEl = Aqua.el('statFps');
  if(fpsEl){
    setInterval(() => {
      const f = Aqua.perf.fps || 0;
      fpsEl.textContent = (f > 0 ? f : '--') + ' FPS';
    }, 600);
  }

  /* ── boot status ─────────────────────────────────────────────── */
  setLed('ledEngine', 'warn', 'statEngine', 'ENGINE: 2D BOOT');
  setLed('ledAudio', null, 'statAudio', 'AUDIO: IDLE');

  /* ── resize ──────────────────────────────────────────────────── */
  window.addEventListener('resize', () => {
    resize();
    readTheme();
  });

  /* ── go ──────────────────────────────────────────────────────── */
  resize();
  readTheme();
  requestAnimationFrame(frame);

  console.info('[Aqua] ambient2d ready — grid/stars/ripples + HUD bootstrap');
});

/* ═══════════════ PART: p03_gl.js ═══════════════ */

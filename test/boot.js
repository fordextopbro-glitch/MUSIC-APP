/*
 * test/boot.js — boot the app in Node against browser stubs, with each
 * module run in its OWN script scope (Node `vm`), faithfully modelling
 * the separate <script> tags the browser uses for the modular build.
 *
 * This catches both init errors AND cross-script reference errors
 * (e.g. a part reaching for a kernel class it shouldn't be able to see).
 *
 * Usage:
 *   node test/boot.js          — load src/*.js (the modular source)
 *   node test/boot.js bundle   — load the single-file bundle's <script> blocks
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* collect the scripts to run, in order.
   src mode: read the module order straight from index.html (single
   source of truth — adding a <script src> there is enough to cover it). */
let scripts = [];   // [{ filename, code }]
if ((process.argv[2] || '') === 'bundle') {
  const html = fs.readFileSync(path.join(ROOT, 'MUSIC INDEX.html'), 'utf8');
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) =>
    scripts.push({ filename: 'script' + i + '.js', code: m[1] }));
} else {
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const mods = [...idx.matchAll(/<script\s+src="(src\/[^"]+)"\s*><\/script>/g)].map(m => m[1]);
  mods.forEach(rel => scripts.push({
    filename: rel.replace(/^src\//, ''),
    code: fs.readFileSync(path.join(ROOT, rel), 'utf8')
  }));
}

/* ── DOM / browser stubs ───────────────────────────────────────────── */
const noop = () => {};
const gradient = { addColorStop: noop };
const ctx2d = {
  setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop,
  moveTo: noop, lineTo: noop, stroke: noop, fill: noop, arc: noop,
  fillText: noop, rect: noop, closePath: noop, save: noop, restore: noop,
  translate: noop, rotate: noop, scale: noop, setLineDash: noop,
  measureText: () => ({ width: 0 }), drawImage: noop, putImageData: noop,
  getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  createLinearGradient: () => gradient, createRadialGradient: () => gradient,
  globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', font: ''
};

const GL_CONST = { NO_ERROR: 0, ARRAY_BUFFER: 34962, STATIC_DRAW: 35044,
  TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6, LINES: 1, LINE_STRIP: 3,
  POINTS: 0, DEPTH_BUFFER_BIT: 256, DEPTH_TEST: 2929, BLEND: 3042,
  CLAMP_TO_EDGE: 33071, LINEAR: 9729, RGBA: 6408, UNSIGNED_BYTE: 5121,
  DEPTH_COMPONENT16: 33190, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
  COMPILE_STATUS: 35713, LINK_STATUS: 35714, MAX_TEXTURE_SIZE: 4096,
  TEXTURE_2D: 3553, FRAMEBUFFER: 36160, COLOR_ATTACHMENT0: 36064, TEXTURE0: 33984 };

function makeGLStub() {
  return new Proxy({}, {
    get(t, p) {
      if (p in t) return t[p];
      if (p in GL_CONST) return GL_CONST[p];
      if (/^[A-Z][A-Z0-9_]+$/.test(String(p))) return (p === 'MAX_TEXTURE_SIZE' ? 4096 : 1);
      if (p === 'getError') return () => 0;
      if (p === 'getShaderParameter' || p === 'getProgramParameter') return () => true;
      if (p === 'getShaderInfoLog' || p === 'getProgramInfoLog') return () => '';
      if (p === 'getActiveUniform' || p === 'getActiveAttrib') return () => null;
      if (p === 'getUniformLocation') return () => ({ __loc: 1 });
      if (p === 'getAttribLocation') return () => 0;
      if (p === 'getExtension') return () => ({});
      if (/^create[A-Z]/.test(String(p))) return () => ({ __res: true });
      if (p === 'canvas') return null;
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

function makeClassList() {
  const s = new Set();
  return {
    add: (...c) => c.forEach(x => s.add(x)),
    remove: (...c) => c.forEach(x => s.delete(x)),
    toggle: (c, f) => { if (f === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (f) s.add(c); else s.delete(c); },
    contains: (c) => s.has(c), _set: s
  };
}

const els = {};
function makeEl(id) {
  const base = {
    id, className: '', dataset: {}, textContent: '', innerHTML: '',
    value: '', checked: false, hidden: false, disabled: false,
    width: 0, height: 0, clientWidth: 1280, clientHeight: 720,
    offsetWidth: 1280, offsetHeight: 720,
    volume: 1, muted: false, currentTime: 0, duration: 0, paused: true, ended: false,
    src: '', classList: makeClassList()
  };
  const glStub = makeGLStub();
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'style') return (t.style = { setProperty: noop, getPropertyValue: () => '', cssText: '', opacity: '1' });
      if (p === 'getContext') return (ty) => (ty === '2d' ? ctx2d : glStub);
      if (['addEventListener', 'removeEventListener', 'appendChild', 'removeChild',
           'insertBefore', 'remove', 'focus', 'blur', 'click', 'select',
           'setAttribute', 'load', 'attachShadow'].indexOf(p) >= 0) return noop;
      if (p === 'getAttribute') return () => null;
      if (p === 'hasAttribute') return () => false;
      if (p === 'getBoundingClientRect') return () => ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0 });
      if (p === 'querySelector') return () => null;
      if (p === 'querySelectorAll') return () => [];
      if (p === 'getClientRects') return () => [];
      if (p === 'play' || p === 'pause' || p === 'requestFullscreen') return () => Promise.resolve();
      if (p === 'items') return [];
      if (p === 'length') return 0;
      if (p === 'parentElement' || p === 'firstChild' || p === 'lastChild') return null;
      if (p === 'children') return [];
      if (p === 'toString') return () => '[el ' + id + ']';
      return noop;
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}
function getEl(id) { return els[id] || (els[id] = makeEl(id)); }

const rafQueue = [];
const document = {
  documentElement: getEl('documentElement'),
  body: getEl('body'),
  head: getEl('head'),
  createElement: (t) => getEl('<' + t + '>'),
  createTextNode: (t) => ({ textContent: t }),
  getElementById: (id) => getEl(id),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop, removeEventListener: noop,
  createObjectURL: () => 'blob:stub',
  revokeObjectURL: noop,
  hidden: false
};

/* ── shared vm context (window === the global object) ─────────────── */
const context = {
  console,
  performance: (typeof performance !== 'undefined') ? performance : undefined,
  setTimeout, clearTimeout,
  setInterval: (fn, ms) => { clearIntervalStub(); return 0; },   // keep process exitable
  clearInterval: clearIntervalStub,
  localStorage: { _d: {}, getItem(k) { return (k in this._d) ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
  getComputedStyle: () => ({ getPropertyValue: () => '', color: 'rgb(0,229,255)', backgroundColor: 'rgb(2,3,8)', opacity: '1' }),
  document,
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  addEventListener: noop, removeEventListener: noop,
  requestAnimationFrame: (f) => { rafQueue.push(f); return rafQueue.length; },
  cancelAnimationFrame: noop,
  URL: { createObjectURL: () => 'blob:win', revokeObjectURL: noop },
  Blob: (typeof Blob !== 'undefined') ? Blob : undefined,
  HTMLElement: function () {},
  AudioContext: undefined, webkitAudioContext: undefined,
  navigator: { userAgent: 'node-test', maxTouchPoints: 0, language: 'en' },
  location: { href: 'http://localhost/', reload: noop },
  history: { pushState: noop, state: null },
  matchMedia: () => ({ matches: false, addListener: noop, addEventListener: noop }),
  scrollTo: noop
};
function clearIntervalStub() {}
context.window = context;   // window IS the global object, as in the browser
vm.createContext(context);

/* ── run every script in its own scope, sharing the global object ─── */
const errors = [];
for (const s of scripts) {
  try {
    vm.runInContext(s.code, context, { filename: s.filename });
  } catch (e) {
    errors.push(s.filename + ': ' + (e && e.stack || e));
  }
}

/* drive a few rAF frames (the app schedules its render loops) */
function runFrames(n) {
  for (let i = 0; i < n && rafQueue.length; i++) {
    const f = rafQueue.shift();
    try { f.call(context, (context.performance && context.performance.now()) || 0); }
    catch (e) { errors.push('RAF: ' + (e && e.stack || e)); }
  }
}
runFrames(6);
runFrames(6);   // a second burst to catch deferred init

/* ── report ───────────────────────────────────────────────────────── */
const A = context.Aqua;
console.log('=== boot test (' + (process.argv[2] === 'bundle' ? 'bundle' : 'src') + ', ' + scripts.length + ' script scopes) ===');
if (errors.length) {
  console.error('BOOT ERRORS (' + errors.length + '):');
  errors.slice(0, 8).forEach(e => console.error('  ' + String(e).split('\n').slice(0, 3).join(' | ')));
}
if (!A) { console.error('✗ window.Aqua missing'); process.exit(1); }
console.log(A.codename + ' v' + A.version + ' — parts: ' + A.parts.length + ' | failures: ' + A.failures.length);
A.parts.forEach(p => console.log('  ' + (p.ready ? '✓' : '✗') + ' ' + p.name));
if (A.failures.length) console.log('  failed parts: ' + A.failures.join(', '));
const need = ['math', 'gl', 'play', 'audio', 'demo', 'lib', 'input'];
const missing = need.filter(k => !A[k]);
console.log('globals:', need.map(k => (A[k] ? k + '✓' : k + '✗')).join(' '));

/* regression: file-only records must get a blob URL and land in the queue
   (this was the "upload does nothing / songs don't play" bug) */
try {
  const fake = { name: 'signal.mp3', file: { name: 'signal.mp3', size: 12 }, type: 'audio', ext: 'mp3', folder: 'DIRECT' };
  const n = A.play.addTracks([fake], { autoplay: false });
  if (n !== 1 || !fake.url || A.play.list.length < 1) {
    errors.push('addTracks skipped a file-only record (got ' + n + ', url=' + fake.url + ')');
  } else {
    console.log('addTracks file-only: ✓ url=' + fake.url);
  }
} catch (e) {
  errors.push('addTracks: ' + (e && e.stack || e));
}

const ok = errors.length === 0 && A.failures.length === 0 && missing.length === 0;
console.log(ok ? '\nBOOT OK ✓' : '\nBOOT FAILED ✗');
process.exit(ok ? 0 : 1);

'use strict';
/* ═══════════════════════════════════════════════════════════════════
   NEONCORE KERNEL
   The kernel is the only code that lives outside the modular parts.
   Every subsystem (math, GL engine, geometry, scene, UI, audio,
   input, demo-signal) registers itself as a part. Parts initialize
   in registration order; a failing part is isolated and reported
   to the status HUD instead of taking the whole system down.
═══════════════════════════════════════════════════════════════════ */
window.Aqua = {
  version: '3.0.0',
  codename: 'NEONCORE',
  parts: [],
  failures: [],
  domCache: {},
  perf: { fps: 0, frames: 0, last: 0, worst: 0 },

  /* register a subsystem part (name, initFn) */
  addPart: function(name, initFn){
    if(typeof initFn !== 'function'){
      console.error('[Aqua] part "' + name + '" has no init function');
      return;
    }
    this.parts.push({ name: name, init: initFn, ready: false });
  },

  /* cache element lookups */
  el: function(id){
    if(!this.domCache[id]){
      this.domCache[id] = document.getElementById(id);
    }
    return this.domCache[id];
  },

  /* run every registered part, isolating failures */
  runParts: function(){
    var t0 = performance.now();
    for(var i = 0; i < this.parts.length; i++){
      var p = this.parts[i];
      try{
        p.init();
        p.ready = true;
      }catch(err){
        this.failures.push(p.name);
        console.error('[Aqua] part failed: ' + p.name, err);
      }
    }
    console.info('[Aqua] ' + this.codename + ' v' + this.version +
      ' — ' + this.parts.length + ' parts, ' +
      this.failures.length + ' failed, boot ' +
      (performance.now() - t0).toFixed(1) + 'ms');
  },

  /* safe localStorage */
  store: {
    get: function(key, fallback){
      try{
        var raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      }catch(e){ return fallback; }
    },
    set: function(key, value){
      try{ localStorage.setItem(key, JSON.stringify(value)); }catch(e){}
    }
  }
};

/* ── parts are concatenated below this line ─────────────────────── */
/* ═══════════════ PART: p02_core.js ═══════════════ */
/* ═══════════════════════════════════════════════════════════════════
   PART p02 · CORE MATH + CONFIG
   ─────────────────────────────────────────────────────────────────
   §1  Constants & scalars
   §2  Vec3  (3D vector)
   §3  Mat4  (4x4 matrix, column-major / WebGL layout)
   §4  Quat  (quaternion)
   §5  AColor (color math)
   §6  ARand  (seeded RNG)
   §7  EventBus (pub/sub backbone)
   §8  AFormat (display formatting)
   §9  AConfig (palettes · presets · tiers · keybinds)
   §10 Part registration
═══════════════════════════════════════════════════════════════════ */

/* ── §1.1  constants ─────────────────────────────────────────────── */
const TWO_PI    = Math.PI * 2;
const HALF_PI   = Math.PI / 2;
const DEG2RAD   = Math.PI / 180;
const RAD2DEG   = 180 / Math.PI;
const EPSILON   = 1e-6;

const AMath = {
  clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); },
  clamp01(v){ return v < 0 ? 0 : (v > 1 ? 1 : v); },
  lerp(a, b, t){ return a + (b - a) * t; },
  inverseLerp(a, b, v){
    if(a === b) return 0;
    return AMath.clamp01((v - a) / (b - a));
  },
  remap(v, inA, inB, outA, outB){
    return AMath.lerp(outA, outB, AMath.inverseLerp(inA, inB, v));
  },
  smoothstep(edge0, edge1, x){
    const t = AMath.clamp01((x - edge0) / (edge1 - edge0 || 1));
    return t * t * (3 - 2 * t);
  },
  smootherstep(edge0, edge1, x){
    const t = AMath.clamp01((x - edge0) / (edge1 - edge0 || 1));
    return t * t * t * (t * (t * 6 - 15) + 10);
  },
  /* framerate-independent damping (exponential) */
  damp(a, b, lambda, dt){
    return AMath.lerp(a, b, 1 - Math.exp(-lambda * dt));
  },
  pingpong(t){
    t = t % 2;
    return t < 1 ? t : 2 - t;
  },
  fract(v){ return v - Math.floor(v); },
  sign(v){ return v < 0 ? -1 : (v > 0 ? 1 : 0); },
  roundTo(v, step){
    return step === 0 ? v : Math.round(v / step) * step;
  },
  easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); },
  easeInOutCubic(t){
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },
  easeOutBack(t){
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeOutElastic(t){
    const c4 = (TWO_PI) / 3;
    if(t === 0) return 0;
    if(t === 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  randRange(lo, hi){ return lo + Math.random() * (hi - lo); },
  randInt(lo, hi){ return Math.floor(AMath.randRange(lo, hi + 1)); },
  pick(arr){ return arr[Math.floor(Math.random() * arr.length)]; },
  /* short human time: 95 -> 1:35 */
  timeShort(sec){
    if(!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
};

/* ── §1.2  perf counter (used by every render loop) ──────────────── */
Aqua.perf.tick = function(){
  /* read Aqua.perf directly — this method is invoked as Aqua.perf.tick()
     so `this` is the perf object, not Aqua. */
  const p = Aqua.perf;
  const now = performance.now();
  if(p.last === 0){ p.last = now; }
  p.frames++;
  if(now - p.last >= 500){
    p.fps = Math.round(p.frames * 1000 / (now - p.last));
    if(p.fps > p.worst) p.worst = p.fps;
    p.frames = 0;
    p.last = now;
    Aqua.bus && Aqua.bus.emit('perf:tick', p.fps);
  }
};

/* ═══════════════════════════════════════════════════════════════════
   §2  Vec3 — 3D vector
   Column-friendly, mutates in place where sensible (out-arg style),
   with convenience shortcuts that return `this`.
═══════════════════════════════════════════════════════════════════ */
class Vec3 {
  constructor(x = 0, y = 0, z = 0){
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z){
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v){
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone(){
    return new Vec3(this.x, this.y, this.z);
  }

  add(v){
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScaledVec(v, s){
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  sub(v){
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  mul(v){
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    return this;
  }

  mulScalar(s){
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  divScalar(s){
    if(s !== 0){
      const inv = 1 / s;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
    }
    return this;
  }

  negate(){
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v){
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v){
    const ax = this.x, ay = this.y, az = this.z;
    const bx = v.x, by = v.y, bz = v.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  lengthSq(){
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(){
    return Math.sqrt(this.lengthSq());
  }

  distance(v){
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  normalize(){
    const len = this.length();
    if(len > EPSILON){
      this.divScalar(len);
    } else {
      this.set(0, 0, 0);
    }
    return this;
  }

  normalizeSafe(){
    const len = this.length();
    if(len > EPSILON) this.divScalar(len);
    return this;
  }

  lerp(v, t){
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  damp(v, lambda, dt){
    const t = 1 - Math.exp(-lambda * dt);
    return this.lerp(v, t);
  }

  /* apply a 4x4 matrix, with perspective divide */
  applyMatrix4(m){
    const e = m.e;
    const x = this.x, y = this.y, z = this.z;
    let w = e[3] * x + e[7] * y + e[11] * z + e[15];
    w = w || 1;
    this.x = (e[0] * x + e[4] * y + e[8]  * z + e[12]) / w;
    this.y = (e[1] * x + e[5] * y + e[9]  * z + e[13]) / w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
    return this;
  }

  /* rotate/scale only — ignores translation, no divide */
  transformDirection(m){
    const e = m.e;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8]  * z;
    this.y = e[1] * x + e[5] * y + e[9]  * z;
    this.z = e[2] * x + e[6] * y + e[10] * z;
    return this;
  }

  rotateX(rad){
    const c = Math.cos(rad), s = Math.sin(rad);
    const y = this.y, z = this.z;
    this.y = y * c - z * s;
    this.z = y * s + z * c;
    return this;
  }

  rotateY(rad){
    const c = Math.cos(rad), s = Math.sin(rad);
    const x = this.x, z = this.z;
    this.x = x * c + z * s;
    this.z = -x * s + z * c;
    return this;
  }

  rotateZ(rad){
    const c = Math.cos(rad), s = Math.sin(rad);
    const x = this.x, y = this.y;
    this.x = x * c - y * s;
    this.y = x * s + y * c;
    return this;
  }

  /* rotate around an arbitrary axis (right-hand rule) */
  rotateAxis(axis, rad){
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const t = 1 - c;
    const ax = axis.x, ay = axis.y, az = axis.z;
    const x = this.x, y = this.y, z = this.z;
    this.x =
      (t * ax * ax + c)     * x +
      (t * ax * ay - s * az) * y +
      (t * ax * az + s * ay) * z;
    this.y =
      (t * ax * ay + s * az) * x +
      (t * ay * ay + c)     * y +
      (t * ay * az - s * ax) * z;
    this.z =
      (t * ax * az - s * ay) * x +
      (t * ay * az + s * ax) * y +
      (t * az * az + c)     * z;
    return this;
  }

  equals(v){
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  fromArray(a, off = 0){
    this.x = a[off];
    this.y = a[off + 1];
    this.z = a[off + 2];
    return this;
  }

  toArray(out = [], off = 0){
    out[off]     = this.x;
    out[off + 1] = this.y;
    out[off + 2] = this.z;
    return out;
  }

  toString(){
    return `Vec3(${this.x.toFixed(3)}, ${this.y.toFixed(3)}, ${this.z.toFixed(3)})`;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   §3  Mat4 — 4x4 matrix, COLUMN-MAJOR (WebGL native layout)
   e[0..3]  = column 0 (right)
   e[4..7]  = column 1 (up)
   e[8..11] = column 2 (back)
   e[12..15]= column 3 (translation)
   Multiplication convention:  out = a · b  (b applied first).
═══════════════════════════════════════════════════════════════════ */
class Mat4 {
  constructor(){
    this.e = new Float32Array(16);
    this.identity();
  }

  identity(){
    const e = this.e;
    e[0] = 1;  e[1] = 0;  e[2]  = 0;  e[3]  = 0;
    e[4] = 0;  e[5] = 1;  e[6]  = 0;  e[7]  = 0;
    e[8] = 0;  e[9] = 0;  e[10] = 1;  e[11] = 0;
    e[12] = 0; e[13] = 0; e[14] = 0;  e[15] = 1;
    return this;
  }

  copy(m){
    this.e.set(m.e);
    return this;
  }

  clone(){
    return new Mat4().copy(this);
  }

  setFromArray(arr){
    this.e.set(arr);
    return this;
  }

  /* out = this · m   (m is applied first) */
  multiply(m){
    const a = this.e;
    const b = m.e;
    const out = new Float32Array(16);
    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0]  = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[1]  = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[2]  = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[3]  = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4]  = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[5]  = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[6]  = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[7]  = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8]  = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[9]  = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[10] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[11] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[13] = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[14] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[15] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    this.e.set(out);
    return this;
  }

  /* this = m · this   (m applied last) */
  premultiply(m){
    const a = m.e;
    const b = this.e;
    const out = new Float32Array(16);
    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0]  = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[1]  = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[2]  = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[3]  = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4]  = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[5]  = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[6]  = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[7]  = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8]  = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[9]  = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[10] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[11] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
    out[13] = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
    out[14] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
    out[15] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    this.e.set(out);
    return this;
  }

  transpose(){
    const e = this.e;
    let t;
    t = e[1];  e[1]  = e[4];  e[4]  = t;
    t = e[2];  e[2]  = e[8];  e[8]  = t;
    t = e[3];  e[3]  = e[12]; e[12] = t;
    t = e[6];  e[6]  = e[9];  e[9]  = t;
    t = e[7];  e[7]  = e[13]; e[13] = t;
    t = e[11]; e[11] = e[14]; e[14] = t;
    return this;
  }

  determinant(){
    const e = this.e;
    const a00 = e[0],  a01 = e[1],  a02 = e[2],  a03 = e[3];
    const a10 = e[4],  a11 = e[5],  a12 = e[6],  a13 = e[7];
    const a20 = e[8],  a21 = e[9],  a22 = e[10], a23 = e[11];
    const a30 = e[12], a31 = e[13], a32 = e[14], a33 = e[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    return (
      b00 * b11 - b01 * b10 + b02 * b09 +
      b03 * b08 - b04 * b07 + b05 * b06
    );
  }

  invert(){
    const e = this.e;
    const a00 = e[0],  a01 = e[1],  a02 = e[2],  a03 = e[3];
    const a10 = e[4],  a11 = e[5],  a12 = e[6],  a13 = e[7];
    const a20 = e[8],  a21 = e[9],  a22 = e[10], a23 = e[11];
    const a30 = e[12], a31 = e[13], a32 = e[14], a33 = e[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if(!det) return this.identity();
    det = 1.0 / det;
    e[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    e[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    e[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    e[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    e[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    e[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    e[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    e[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    e[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    e[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    e[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    e[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    e[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    e[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    e[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    e[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return this;
  }

  translate(v){
    const e = this.e;
    const x = v.x, y = v.y, z = v.z;
    e[12] = e[0] * x + e[4] * y + e[8]  * z + e[12];
    e[13] = e[1] * x + e[5] * y + e[9]  * z + e[13];
    e[14] = e[2] * x + e[6] * y + e[10] * z + e[14];
    e[15] = e[3] * x + e[7] * y + e[11] * z + e[15];
    return this;
  }

  scale(v){
    const e = this.e;
    const x = v.x, y = v.y, z = v.z;
    e[0] *= x; e[1] *= x; e[2] *= x; e[3]  *= x;
    e[4] *= y; e[5] *= y; e[6] *= y; e[7]  *= y;
    e[8] *= z; e[9] *= z; e[10] *= z; e[11] *= z;
    return this;
  }

  uniformScale(s){
    const e = this.e;
    e[0] *= s; e[1] *= s; e[2]  *= s; e[3]  *= s;
    e[4] *= s; e[5] *= s; e[6]  *= s; e[7]  *= s;
    e[8] *= s; e[9] *= s; e[10] *= s; e[11] *= s;
    return this;
  }

  rotateX(rad){
    const e = this.e;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const a10 = e[4], a11 = e[5], a12 = e[6], a13 = e[7];
    const a20 = e[8], a21 = e[9], a22 = e[10], a23 = e[11];
    e[4]  = a10 * c + a20 * s;
    e[5]  = a11 * c + a21 * s;
    e[6]  = a12 * c + a22 * s;
    e[7]  = a13 * c + a23 * s;
    e[8]  = a20 * c - a10 * s;
    e[9]  = a21 * c - a11 * s;
    e[10] = a22 * c - a12 * s;
    e[11] = a23 * c - a13 * s;
    return this;
  }

  rotateY(rad){
    const e = this.e;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const a00 = e[0], a01 = e[1], a02 = e[2], a03 = e[3];
    const a20 = e[8], a21 = e[9], a22 = e[10], a23 = e[11];
    e[0]  = a00 * c - a20 * s;
    e[1]  = a01 * c - a21 * s;
    e[2]  = a02 * c - a22 * s;
    e[3]  = a03 * c - a23 * s;
    e[8]  = a00 * s + a20 * c;
    e[9]  = a01 * s + a21 * c;
    e[10] = a02 * s + a22 * c;
    e[11] = a03 * s + a23 * c;
    return this;
  }

  rotateZ(rad){
    const e = this.e;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const a00 = e[0], a01 = e[1], a02 = e[2], a03 = e[3];
    const a10 = e[4], a11 = e[5], a12 = e[6], a13 = e[7];
    e[0]  = a00 * c + a10 * s;
    e[1]  = a01 * c + a11 * s;
    e[2]  = a02 * c + a12 * s;
    e[3]  = a03 * c + a13 * s;
    e[4]  = a10 * c - a00 * s;
    e[5]  = a11 * c - a01 * s;
    e[6]  = a12 * c - a02 * s;
    e[7]  = a13 * c - a03 * s;
    return this;
  }

  /* rotate around arbitrary axis through origin */
  rotateAxis(axis, rad){
    const x = axis.x, y = axis.y, z = axis.z;
    const len = Math.sqrt(x * x + y * y + z * z);
    let sx, sy, sz, s, c, t;
    if(Math.abs(len) < EPSILON) return this;
    sx = x / len;
    sy = y / len;
    sz = z / len;
    s = Math.sin(rad);
    c = Math.cos(rad);
    t = 1 - c;
    const e = this.e;
    const a00 = e[0], a01 = e[1], a02 = e[2];
    const a10 = e[4], a11 = e[5], a12 = e[6];
    const a20 = e[8], a21 = e[9], a22 = e[10];
    const b00 = (sx * sx) * t + c;
    const b01 = (sy * sx) * t + sz * s;
    const b02 = (sz * sx) * t - sy * s;
    const b10 = (sx * sy) * t - sz * s;
    const b11 = (sy * sy) * t + c;
    const b12 = (sz * sy) * t + sx * s;
    const b20 = (sx * sz) * t + sy * s;
    const b21 = (sy * sz) * t - sx * s;
    const b22 = (sz * sz) * t + c;
    e[0]  = a00 * b00 + a10 * b01 + a20 * b02;
    e[1]  = a01 * b00 + a11 * b01 + a21 * b02;
    e[2]  = a02 * b00 + a12 * b01 + a22 * b02;
    e[4]  = a00 * b10 + a10 * b11 + a20 * b12;
    e[5]  = a01 * b10 + a11 * b11 + a21 * b12;
    e[6]  = a02 * b10 + a12 * b11 + a22 * b12;
    e[8]  = a00 * b20 + a10 * b21 + a20 * b22;
    e[9]  = a01 * b20 + a11 * b21 + a21 * b22;
    e[10] = a02 * b20 + a12 * b21 + a22 * b22;
    return this;
  }

  /* perspective projection (right-handed, -z forward) */
  perspective(fovyRad, aspect, near, far){
    const e = this.e;
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    e[0] = f / aspect; e[1] = 0; e[2]  = 0;                  e[3]  = 0;
    e[4] = 0;          e[5] = f; e[6]  = 0;                  e[7]  = 0;
    e[8] = 0;          e[9] = 0; e[10] = (far + near) * nf;  e[11] = -1;
    e[12] = 0;         e[13] = 0; e[14] = (2 * far * near) * nf; e[15] = 0;
    return this;
  }

  ortho(left, right, bottom, top, near, far){
    const e = this.e;
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    e[0] = -2 * lr;   e[1] = 0;        e[2]  = 0;        e[3]  = 0;
    e[4] = 0;         e[5] = -2 * bt;  e[6]  = 0;        e[7]  = 0;
    e[8] = 0;         e[9] = 0;        e[10] = 2 * nf;   e[11] = 0;
    e[12] = (left + right) * lr;
    e[13] = (top + bottom) * bt;
    e[14] = (far + near) * nf;
    e[15] = 1;
    return this;
  }

  /* view matrix from eye → center, with up */
  lookAt(eye, center, up){
    const e = this.e;
    let z0 = eye.x - center.x;
    let z1 = eye.y - center.y;
    let z2 = eye.z - center.z;
    let len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
    z0 *= len; z1 *= len; z2 *= len;
    let x0 = up.y * z2 - up.z * z1;
    let x1 = up.z * z0 - up.x * z2;
    let x2 = up.x * z1 - up.y * z0;
    len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    if(!len){ x0 = 0; x1 = 0; x2 = 0; }
    else {
      len = 1 / len;
      x0 *= len; x1 *= len; x2 *= len;
    }
    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;
    e[0] = x0; e[1] = y0; e[2]  = z0; e[3]  = 0;
    e[4] = x1; e[5] = y1; e[6]  = z1; e[7]  = 0;
    e[8] = x2; e[9] = y2; e[10] = z2; e[11] = 0;
    e[12] = -(x0 * eye.x + x1 * eye.y + x2 * eye.z);
    e[13] = -(y0 * eye.x + y1 * eye.y + y2 * eye.z);
    e[14] = -(z0 * eye.x + z1 * eye.y + z2 * eye.z);
    e[15] = 1;
    return this;
  }

  /* model matrix from quaternion rotation + translation + scale */
  fromRotationTranslationScale(q, pos, scl){
    const e = this.e;
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yx = y * x2, yy = y * y2;
    const zx = z * x2, zy = z * y2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scl.x, sy = scl.y, sz = scl.z;
    e[0] = (1 - (yy + zz)) * sx;
    e[1] = (yx + wz) * sx;
    e[2] = (zx - wy) * sx;
    e[3] = 0;
    e[4] = (yx - wz) * sy;
    e[5] = (1 - (xx + zz)) * sy;
    e[6] = (zy + wx) * sy;
    e[7] = 0;
    e[8] = (zx + wy) * sz;
    e[9] = (zy - wx) * sz;
    e[10] = (1 - (xx + yy)) * sz;
    e[11] = 0;
    e[12] = pos.x;
    e[13] = pos.y;
    e[14] = pos.z;
    e[15] = 1;
    return this;
  }

  transformPoint(out, v){
    const e = this.e;
    const x = v.x, y = v.y, z = v.z;
    let w = e[3] * x + e[7] * y + e[11] * z + e[15];
    w = w || 1;
    out.x = (e[0] * x + e[4] * y + e[8]  * z + e[12]) / w;
    out.y = (e[1] * x + e[5] * y + e[9]  * z + e[13]) / w;
    out.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
    return out;
  }

  transformDirection(out, v){
    const e = this.e;
    const x = v.x, y = v.y, z = v.z;
    out.x = e[0] * x + e[4] * y + e[8]  * z;
    out.y = e[1] * x + e[5] * y + e[9]  * z;
    out.z = e[2] * x + e[6] * y + e[10] * z;
    return out;
  }

  /* column accessor (column 0..3) into a Vec3 */
  getColumn(col, out){
    out.x = this.e[col * 4];
    out.y = this.e[col * 4 + 1];
    out.z = this.e[col * 4 + 2];
    return out;
  }

  toString(){
    const e = this.e;
    return 'Mat4[\n  ' +
      e[0].toFixed(2) + ' ' + e[4].toFixed(2) + ' ' + e[8].toFixed(2)  + ' ' + e[12].toFixed(2) + '\n  ' +
      e[1].toFixed(2) + ' ' + e[5].toFixed(2) + ' ' + e[9].toFixed(2)  + ' ' + e[13].toFixed(2) + '\n  ' +
      e[2].toFixed(2) + ' ' + e[6].toFixed(2) + ' ' + e[10].toFixed(2) + ' ' + e[14].toFixed(2) + '\n  ' +
      e[3].toFixed(2) + ' ' + e[7].toFixed(2) + ' ' + e[11].toFixed(2) + ' ' + e[15].toFixed(2) + '\n]';
  }
}

/* ═══════════════════════════════════════════════════════════════════
   §4  Quat — quaternion  (w last, like gl-matrix [x,y,z,w])
═══════════════════════════════════════════════════════════════════ */
class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1){
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  identity(){
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.w = 1;
    return this;
  }

  set(x, y, z, w){
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q){
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  clone(){
    return new Quat(this.x, this.y, this.z, this.w);
  }

  fromAxisAngle(ax, ay, az, rad){
    let x = ax, y = ay, z = az;
    const len = Math.sqrt(x * x + y * y + z * z);
    if(len < EPSILON){
      return this.identity();
    }
    const s = Math.sin(rad / 2) / len;
    this.x = x * s;
    this.y = y * s;
    this.z = z * s;
    this.w = Math.cos(rad / 2);
    return this;
  }

  lengthSq(){
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  length(){
    return Math.sqrt(this.lengthSq());
  }

  normalize(){
    const len = this.length();
    if(len > EPSILON){
      const inv = 1 / len;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      this.w *= inv;
    }
    return this;
  }

  conjugate(){
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(q){
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  /* this = this · q   (q applied first) */
  multiply(q){
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  /* rotate a vector:  out = q · v · q⁻¹   (does not mutate this)
     Standard two-cross formulation, valid for unit quaternions:
       t   = 2 * cross(qv, v)
       v'  = v + w * t + cross(qv, t)                       */
  rotateVec(out, v){
    const qx = this.x, qy = this.y, qz = this.z, qw = this.w;
    const vx = v.x, vy = v.y, vz = v.z;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out.x = vx + qw * tx + (qy * tz - qz * ty);
    out.y = vy + qw * ty + (qz * tx - qx * tz);
    out.z = vz + qw * tz + (qx * ty - qy * tx);
    return out;
  }

  slerp(q, t){
    let ax = this.x, ay = this.y, az = this.z, aw = this.w;
    let bx = q.x, by = q.y, bz = q.z, bw = q.w;
    let cosom = ax * bx + ay * by + az * bz + aw * bw;
    if(cosom < 0){
      cosom = -cosom;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let scale0, scale1;
    if(1 - cosom > EPSILON){
      const omega = Math.acos(AMath.clamp(cosom, -1, 1));
      const sinom = Math.sin(omega);
      scale0 = Math.sin((1 - t) * omega) / sinom;
      scale1 = Math.sin(t * omega) / sinom;
    } else {
      scale0 = 1 - t;
      scale1 = t;
    }
    this.x = ax * scale0 + bx * scale1;
    this.y = ay * scale0 + by * scale1;
    this.z = az * scale0 + bz * scale1;
    this.w = aw * scale0 + bw * scale1;
    return this;
  }

  /* integrate angular velocity over dt (Euler) */
  integrate(axis, speedRadPerSec, dt){
    if(Math.abs(speedRadPerSec) < EPSILON) return this;
    const tmp = new Quat().fromAxisAngle(axis.x, axis.y, axis.z, speedRadPerSec * dt);
    return this.multiply(tmp).normalize();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   §5  AColor — color helpers (hex ⇄ rgb, mix, rgba strings)
═══════════════════════════════════════════════════════════════════ */
const AColor = {
  cache: Object.create(null),

  parse(hex){
    if(this.cache[hex]) return this.cache[hex];
    let h = String(hex).replace('#', '').trim();
    if(h.length === 3){
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    let n = parseInt(h, 16);
    if(isNaN(n)) n = 0x00e5ff;
    const c = {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
      hex: '#' + n.toString(16).padStart(6, '0')
    };
    this.cache[hex] = c;
    return c;
  },

  rgba(hex, a){
    const c = this.parse(hex);
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  },

  /* mix two hex colors, t in [0,1] → hex */
  mixHex(h1, h2, t){
    const a = this.parse(h1);
    const b = this.parse(h2);
    const r = Math.round(AMath.lerp(a.r, b.r, t));
    const g = Math.round(AMath.lerp(a.g, b.g, t));
    const bl = Math.round(AMath.lerp(a.b, b.b, t));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
  },

  mixRgba(h1, h2, t, alpha){
    const a = this.parse(h1);
    const b = this.parse(h2);
    return `rgba(${Math.round(AMath.lerp(a.r, b.r, t))},${Math.round(AMath.lerp(a.g, b.g, t))},${Math.round(AMath.lerp(a.b, b.b, t))},${alpha})`;
  },

  /* relative luminance 0..1 (perceptual) */
  luminance(hex){
    const c = this.parse(hex);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  },

  /* darker / lighter by shifting toward black / white */
  shade(hex, amt){
    const c = this.parse(hex);
    const t = amt < 0 ? 0 : 255;
    const p = Math.abs(amt);
    const r = Math.round(AMath.lerp(c.r, t, p));
    const g = Math.round(AMath.lerp(c.g, t, p));
    const b = Math.round(AMath.lerp(c.b, t, p));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  },

  /* HSL from hex (h 0-360, s/l 0-1) */
  toHsl(hex){
    const c = this.parse(hex);
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if(max !== min){
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch(max){
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return { h, s, l };
  },

  /* hue-shift a hex color by deg (used for per-track palettes) */
  hueShift(hex, deg){
    const hsl = this.toHsl(hex);
    const h = (hsl.h + deg + 360) % 360;
    return AColor.hslToHex(h, hsl.s, hsl.l);
  },

  hslToHex(h, s, l){
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
};

/* ═══════════════════════════════════════════════════════════════════
   §6  ARand — seeded RNG (mulberry32) + hashing
═══════════════════════════════════════════════════════════════════ */
const ARand = {
  /* deterministic PRNG factory */
  mulberry32(seed){
    let a = seed >>> 0;
    return function(){
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  /* stable string → uint32 hash */
  hash(str){
    let h = 2166136261;
    for(let i = 0; i < str.length; i++){
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  },

  /* seeded convenience wrapper */
  seeded(seed){
    const next = this.mulberry32(typeof seed === 'string' ? this.hash(seed) : seed);
    return {
      next: next,
      range(lo, hi){ return lo + next() * (hi - lo); },
      int(lo, hi){ return Math.floor(lo + next() * (hi - lo + 1)); },
      pick(arr){ return arr[Math.floor(next() * arr.length)]; },
      bool(p = 0.5){ return next() < p; },
      gauss(){
        let u = 0, v = 0;
        while(u === 0) u = next();
        while(v === 0) v = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
      }
    };
  }
};

/* ═══════════════════════════════════════════════════════════════════
   §7  EventBus — pub/sub backbone for all subsystems
   Events used across the system:
     theme:change · ui:ripple {x,y} · audio:energy 0..1
     audio:beat {bass} · gl:ready · library:changed
═══════════════════════════════════════════════════════════════════ */
class EventBus {
  constructor(){
    this.handlers = new Map();
  }

  /* subscribe; returns an unsubscribe function */
  on(event, fn, ctx){
    if(typeof fn !== 'function') return () => {};
    if(!this.handlers.has(event)) this.handlers.set(event, []);
    const entry = { fn, ctx: ctx || null, once: false };
    this.handlers.get(event).push(entry);
    return () => this.off(event, fn);
  }

  once(event, fn, ctx){
    if(typeof fn !== 'function') return () => {};
    if(!this.handlers.has(event)) this.handlers.set(event, []);
    const entry = { fn, ctx: ctx || null, once: true };
    this.handlers.get(event).push(entry);
    return () => this.off(event, fn);
  }

  off(event, fn){
    const list = this.handlers.get(event);
    if(!list) return;
    for(let i = list.length - 1; i >= 0; i--){
      if(list[i].fn === fn){
        list.splice(i, 1);
      }
    }
    if(list.length === 0) this.handlers.delete(event);
  }

  emit(event, data){
    const list = this.handlers.get(event);
    if(!list || !list.length) return;
    /* copy — handlers may unsubscribe mid-emit */
    const snapshot = list.slice();
    for(let i = 0; i < snapshot.length; i++){
      const h = snapshot[i];
      try{
        h.fn.call(h.ctx, data);
      }catch(err){
        console.error('[Aqua bus] handler error on "' + event + '"', err);
      }
      if(h.once){
        const idx = list.indexOf(h);
        if(idx !== -1) list.splice(idx, 1);
      }
    }
  }

  clear(){
    this.handlers.clear();
  }

  stats(){
    let n = 0;
    this.handlers.forEach(l => { n += l.length; });
    return n;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   §8  AFormat — display formatting
═══════════════════════════════════════════════════════════════════ */
const AFormat = {
  time(sec){
    if(!isFinite(sec) || sec < 0) return '00:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if(h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  },

  bytes(n){
    if(n == null || isNaN(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while(v >= 1024 && i < units.length - 1){
      v /= 1024;
      i++;
    }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
  },

  hex(n, len = 2){
    return (n & (Math.pow(2, len * 4) - 1)).toString(16).toUpperCase().padStart(len, '0');
  },

  pad2(n){
    return String(n).padStart(2, '0');
  },

  /* "04 / 217" style sequence readout */
  seq(i, total){
    return String(i).padStart(2, '0') + ' / ' + String(total).padStart(3, '0');
  },

  /* clamp text to n chars with ellipsis */
  ellipsis(str, n){
    str = String(str);
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   §9  AConfig — palettes · presets · render tiers · keybinds
═══════════════════════════════════════════════════════════════════ */
const AConfig = {

  /* 12 accent palettes — each applied per-track when Dynamic Colors is on */
  palettes: [
    { id: 'core-cyan',    name: 'CORE CYAN',    a1: '#00e5ff', a2: '#ff2d95', a3: '#7c4dff' },
    { id: 'emerald',      name: 'EMERALD CIRCUIT', a1: '#00ffa3', a2: '#00e5ff', a3: '#0077ff' },
    { id: 'solar',        name: 'SOLAR FLARE',  a1: '#ff9500', a2: '#ff2d55', a3: '#ffd60a' },
    { id: 'viov',         name: 'VIOVERSE',     a1: '#a78bfa', a2: '#7c4dff', a3: '#ff2d95' },
    { id: 'ice',          name: 'ICE BREAKER',  a1: '#67e8f9', a2: '#38bdf8', a3: '#0ea5e9' },
    { id: 'toxin',        name: 'TOXIN',        a1: '#a3e635', a2: '#00ffa3', a3: '#00e5ff' },
    { id: 'crimson',      name: 'CRIMSON GRID', a1: '#ff3b3b', a2: '#ff2d95', a3: '#7c4dff' },
    { id: 'goldwire',     name: 'GOLDWIRE',     a1: '#ffd60a', a2: '#ff9500', a3: '#ff2d55' },
    { id: 'plasma',       name: 'PLASMA',       a1: '#ff2d95', a2: '#ffd60a', a3: '#00e5ff' },
    { id: 'neon-pink',    name: 'NEON PINK',    a1: '#ff5ce1', a2: '#ff2d95', a3: '#a78bfa' },
    { id: 'oxygen',       name: 'OXYGEN',       a1: '#34d399', a2: '#10b981', a3: '#00e5ff' },
    { id: 'ultraviolet',  name: 'ULTRAVIOLET',  a1: '#7c4dff', a2: '#4338ca', a3: '#00e5ff' }
  ],

  /* sound-engine presets (reverb %, room %, decay s, 5 EQ bands dB) */
  presets: {
    normal:     { reverb: 0,  room: 50,  decay: 2,   bass: 0,   lowmid: 0,  mid: 0,   highmid: 0,   treble: 0   },
    reverb:     { reverb: 60, room: 70,  decay: 4,   bass: 0,   lowmid: 0,  mid: 0,   highmid: 0,   treble: 2   },
    cave:       { reverb: 80, room: 90,  decay: 7,   bass: 5,   lowmid: 0,  mid: -3,  highmid: -2,  treble: -4  },
    stadium:    { reverb: 70, room: 85,  decay: 5,   bass: 3,   lowmid: 1,  mid: 0,   highmid: 2,   treble: 3   },
    bathroom:   { reverb: 75, room: 40,  decay: 1.5, bass: -2,  lowmid: 5,  mid: 8,   highmid: 5,   treble: 2   },
    underwater: { reverb: 90, room: 60,  decay: 6,   bass: 8,   lowmid: 3,  mid: -8,  highmid: -12, treble: -15 },
    lofi:       { reverb: 30, room: 30,  decay: 1.5, bass: 6,   lowmid: 3,  mid: -4,  highmid: -6,  treble: -8  },
    concert:    { reverb: 55, room: 75,  decay: 3.5, bass: 4,   lowmid: 2,  mid: 1,   highmid: 3,   treble: 5   }
  },

  /* GPU quality tiers — selected from Core Lab */
  tiers: {
    high: {
      label: 'HIGH',
      dprCap: 2.0,
      stars: 1500,
      particles: 900,
      bloom: 1,
      bloomDiv: 2,
      gridLines: 40,
      antialias: true
    },
    med: {
      label: 'MED',
      dprCap: 1.5,
      stars: 900,
      particles: 500,
      bloom: 1,
      bloomDiv: 4,
      gridLines: 32,
      antialias: true
    },
    low: {
      label: 'LOW',
      dprCap: 1.0,
      stars: 450,
      particles: 240,
      bloom: 0,
      bloomDiv: 4,
      gridLines: 24,
      antialias: false
    }
  },

  /* global keymap (e.code → action id) */
  keybinds: {
    Space:      'toggle-play',
    ArrowRight: 'skip-fwd',
    ArrowLeft:  'skip-back',
    ArrowUp:    'vol-up',
    ArrowDown:  'vol-down',
    KeyN:       'next',
    KeyP:       'prev',
    KeyS:       'shuffle',
    KeyR:       'repeat',
    KeyM:       'mute',
    KeyT:       'theme',
    KeyL:       'lab',
    Slash:      'search'
  },

  /* defaults merged with stored settings */
  settingsDefaults: {
    theme: 'dark',
    dynColor: true,
    autoPlay: true,
    night: false,
    shuffle: false,
    repeat: false,
    volume: 0.8,
    muted: false,
    tier: 'med',
    reverb: 0,
    room: 50,
    decay: 2,
    bass: 0,
    lowmid: 0,
    mid: 0,
    highmid: 0,
    treble: 0,
    pitch: 0,
    speed: 1,
    width: 100
  }
};

/* ═══════════════════════════════════════════════════════════════════
   GLOBAL EXPORTS
   In the single-file bundle the kernel and every part shared one script
   scope, so top-level classes/consts were visible to all of them.  When
   the project is served as modular scripts (one <script> per part),
   each script has its own scope — so we republish the kernel's shared
   building blocks onto the global object to preserve that linkage.
═══════════════════════════════════════════════════════════════════ */
window.Vec3 = Vec3;
window.Mat4 = Mat4;
window.Quat = Quat;
window.AColor = AColor;
window.ARand = ARand;
window.AFormat = AFormat;
window.AMath = AMath;
window.EventBus = EventBus;
window.AConfig = AConfig;
window.TWO_PI = TWO_PI;
window.HALF_PI = HALF_PI;
window.DEG2RAD = DEG2RAD;
window.RAD2DEG = RAD2DEG;
window.EPSILON = EPSILON;

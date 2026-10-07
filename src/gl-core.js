/* ═══════════════════════════════════════════════════════════════════
   PART p03 · GL CORE — WEBGL 3D ENGINE + SHADERS
   ─────────────────────────────────────────────────────────────────
   · WebGL2 (WebGL1 fallback) context with full error-checked
     shader compilation & program/link introspection.
   · GLSL ES 1.00 shaders (portable across both contexts):
       - Nebula background   (domain-warped FBM + star field)
       - Neon grid floor     (perspective anti-aliased grid)
       - Neon solid material (fresnel rim + iridescence)
       - Line glow           (additive wireframe pass)
       - Glow sprites        (additive point particles)
       - Post FX chain       (bright pass → separable blur ×2 →
                              composite w/ bloom, chromatic
                              aberration, vignette, scanlines, grain)
   · Resource wrappers: VAO, buffer, FBO target, ping-pong pair.
   · Owns the single render loop (scene parts register onFrame
     callbacks — never a second rAF).
   · Camera: orbit struct + view/proj/VP matrices each frame.
   · Graceful degradation: if no WebGL, banner + 2D layer stays.
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('gl-core', function initGLCore(){
  'use strict';

  const canvas = Aqua.el('glCanvas');
  if(!canvas) throw new Error('glCanvas missing');

  let gl = null, isGL2 = false, derivExt = null;
  let lost = false;

  /* ═════════════════════════════════════════════════════════════
     1 · CONTEXT
  ═══════════════════════════════════════════════════════════════ */
  function acquireContext(){
    const opts = {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false
    };
    gl = canvas.getContext('webgl2', opts);
    isGL2 = !!gl;
    if(!gl){
      gl = canvas.getContext('webgl', opts) ||
           canvas.getContext('experimental-webgl', opts);
    }
    if(!gl) return false;
    /* derivatives are only needed if a shader uses fwidth; grab it
       opportunistically.  Always present on WebGL2. */
    try{
      derivExt = gl.getExtension('OES_standard_derivatives');
    }catch(e){
      derivExt = null;
    }
    return true;
  }

  function glCheck(label){
    if(!gl) return;
    const err = gl.getError();
    if(err !== gl.NO_ERROR){
      console.error('[Aqua GL] error 0x' + err.toString(16) + ' after: ' + label);
    }
  }

  /* ═════════════════════════════════════════════════════════════
     2 · SHADERS (GLSL ES 1.00, cross-context portable)
  ═══════════════════════════════════════════════════════════════ */

  /* shared prelude: derivatives macro (AA line widths) */
  const NOISE_GLSL = `
    float hash12(vec2 p){
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
        mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }
    float fbm(vec2 p){
      float a = 0.5;
      float r = 0.0;
      for(int i = 0; i < 5; i++){
        r += a * vnoise(p);
        p = p * 2.03 + 11.7;
        a *= 0.5;
      }
      return r;
    }
  `;

  /* ── fullscreen quad (screen-space) ─────────────────────────── */
  const VS_QUAD = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main(){
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  /* ── nebula background ──────────────────────────────────────── */
  const FS_NEBULA = `
    precision mediump float;
    varying vec2 vUv;
    uniform vec2  uRes;
    uniform float uTime;
    uniform float uEnergy;
    uniform vec3  uC1;
    uniform vec3  uC2;
    uniform vec3  uC3;
    ${NOISE_GLSL}
    void main(){
      vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
      float t = uTime * 0.045;

      /* domain-warped nebula */
      vec2 q = vec2(
        fbm(p * 1.9 + vec2(0.0, t)),
        fbm(p * 1.9 + vec2(5.2, -t * 0.8))
      );
      vec2 r = vec2(
        fbm(p * 1.9 + 2.6 * q + vec2(1.7, 9.2) + 0.12 * t),
        fbm(p * 1.9 + 2.6 * q + vec2(8.3, 2.8) - 0.10 * t)
      );
      float f = fbm(p * 1.9 + 2.4 * r);

      /* deep-space vertical base */
      float horizon = smoothstep(-0.95, 0.65, vUv.y);
      vec3 col = mix(vec3(0.003, 0.005, 0.011), vec3(0.010, 0.014, 0.030), horizon);

      /* nebula layers */
      float n1 = smoothstep(0.38, 0.90, f);
      float n2 = smoothstep(0.42, 0.95, length(q) - f * 0.45);
      col += uC3 * n1 * 0.150 * (0.65 + 0.75 * uEnergy);
      col += uC1 * n2 * 0.090 * (0.55 + 0.90 * uEnergy);
      float n3 = smoothstep(0.55, 1.0, fbm(p * 3.1 - r * 1.4 + t * 0.6));
      col += uC2 * n3 * 0.055 * (0.5 + 0.9 * uEnergy);

      /* far star field */
      vec2 sp = p * 42.0;
      vec2 cell = floor(sp);
      float h = hash12(cell);
      vec2 fp = fract(sp) - 0.5;
      float star = smoothstep(0.14, 0.0, length(fp)) * step(0.94, h);
      star *= 0.45 + 0.55 * sin(uTime * (0.8 + h * 3.0) + h * 43.0);
      col += vec3(0.85, 0.92, 1.0) * star * 0.42;

      /* horizon energy wash */
      col += uC1 * 0.045 * uEnergy * smoothstep(0.55, 0.0, abs(vUv.y - 0.42));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ── neon grid floor ────────────────────────────────────────── */
  const VS_FLOOR = `
    precision highp float;
    attribute vec3 aPos;
    uniform mat4 uVP;
    varying vec3 vWorld;
    varying float vDist;
    void main(){
      vWorld = aPos;
      vec4 cp = uVP * vec4(aPos, 1.0);
      vDist = max(cp.w, 0.1);
      gl_Position = cp;
    }
  `;
  const FS_FLOOR = `
    precision highp float;
    varying vec3 vWorld;
    varying float vDist;
    uniform float uTime;
    uniform float uEnergy;
    uniform vec3  uC1;
    uniform vec3  uC2;
    uniform float uLineWidth;
    void main(){
      vec2 g = vWorld.xz;
      vec2 dMin = abs(fract(g) - 0.5);
      vec2 dMaj = abs(fract(g * 0.2) - 0.5);   /* every 5 units */
      float mMin = min(dMin.x, dMin.y);
      float mMaj = min(dMaj.x, dMaj.y);

      /* anti-aliased line width scales with depth */
      float lw = uLineWidth * vDist;
      float lineMin = 1.0 - smoothstep(lw, lw * 2.4, mMin);
      float lineMaj = 1.0 - smoothstep(lw * 1.4, lw * 3.4, mMaj);

      /* distance falloff from center */
      float dist = length(g);
      float fade = exp(-dist * 0.052);

      /* travelling pulse ring */
      float ring = 0.5 + 0.5 * sin(dist * 0.55 - uTime * 2.4);
      float ringGlow = smoothstep(0.72, 1.0, ring) * 0.6;

      vec3 base = vec3(0.006, 0.008, 0.015);
      vec3 col = base;
      col += uC1 * lineMin * 0.34 * fade * (0.55 + 0.95 * uEnergy);
      col += uC1 * lineMaj * 0.85 * fade * (0.60 + 1.10 * uEnergy);
      col += uC2 * lineMaj * ringGlow * fade * (0.4 + 1.2 * uEnergy);
      /* center beacon glow */
      col += uC2 * exp(-dist * dist * 0.028) * (0.28 + 0.55 * uEnergy);
      /* soft edge fade into space */
      float edge = smoothstep(90.0, 40.0, dist);
      col = mix(base * 0.5, col, clamp(edge, 0.0, 1.0));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ── neon solid material ────────────────────────────────────── */
  const VS_SOLID = `
    precision highp float;
    attribute vec3 aPos;
    attribute vec3 aNormal;
    uniform mat4 uModel;
    uniform mat4 uVP;
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main(){
      vNormal = normalize(mat3(uModel) * aNormal);
      vec4 w = uModel * vec4(aPos, 1.0);
      vWorld = w.xyz;
      gl_Position = uVP * w;
    }
  `;
  const FS_SOLID = `
    precision highp float;
    varying vec3 vNormal;
    varying vec3 vWorld;
    uniform vec3  uCamPos;
    uniform vec3  uC1;
    uniform vec3  uC2;
    uniform vec3  uC3;
    uniform float uTime;
    uniform float uEnergy;
    uniform float uEmissive;
    uniform float uWire;
    ${NOISE_GLSL}
    void main(){
      vec3 N = normalize(vNormal);
      vec3 V = normalize(uCamPos - vWorld);
      if(!gl_FrontFacing) N = -N;

      float fres = pow(1.0 - max(dot(N, V), 0.0), 2.4);

      /* two stylised key lights */
      vec3 L1 = normalize(vec3(0.6, 0.9, 0.4));
      vec3 L2 = normalize(vec3(-0.7, 0.25, -0.5));
      float d1 = max(dot(N, L1), 0.0);
      float d2 = max(dot(N, L2), 0.0);

      /* base body: dark brushed metal tinted by accent 3 */
      vec3 base = mix(uC3 * 0.05, uC3 * 0.16, fres);
      vec3 col = base + uC1 * d1 * 0.30 + uC2 * d2 * 0.22;

      /* fresnel rim — the neon signature */
      col += uC1 * fres * (0.55 + 1.0 * uEnergy);

      /* iridescent banding over the rim */
      float band = 0.5 + 0.5 * sin(N.y * 7.0 + uTime * 0.7 + N.x * 3.5);
      col += mix(uC2, uC3, band) * fres * band * (0.22 + 0.55 * uEnergy);

      /* procedural surface shimmer (fine noise) */
      float shim = vnoise(vWorld.xy * 6.0 + vWorld.zx * 4.0 + uTime * 0.25);
      col += uC1 * shim * 0.02 * (0.4 + uEnergy);

      col *= (0.88 + 0.75 * uEmissive);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ── line glow (wireframe overlay) ──────────────────────────── */
  const VS_LINE = `
    precision highp float;
    attribute vec3 aPos;
    uniform mat4 uModel;
    uniform mat4 uVP;
    varying vec3 vWorld;
    void main(){
      vec4 w = uModel * vec4(aPos, 1.0);
      vWorld = w.xyz;
      gl_Position = uVP * w;
    }
  `;
  const FS_LINE = `
    precision highp float;
    varying vec3 vWorld;
    uniform vec3  uColor;
    uniform float uEnergy;
    uniform float uTime;
    void main(){
      float pulse = 0.6 + 0.4 * sin(uTime * 3.0);
      vec3 col = uColor * (0.35 + 0.85 * uEnergy) * pulse;
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ── glow sprite particles ──────────────────────────────────── */
  const VS_SPRITE = `
    precision highp float;
    attribute vec3  aPos;
    attribute float aSize;
    attribute vec3  aColor;
    uniform mat4 uVP;
    uniform mat4 uModel;
    uniform float uPixScale;
    varying vec3 vColor;
    void main(){
      vColor = aColor;
      vec4 cp = uVP * uModel * vec4(aPos, 1.0);
      float w = max(cp.w, 0.1);
      gl_PointSize = clamp(aSize * uPixScale / w, 1.0, 64.0);
      gl_Position = cp;
    }
  `;
  const FS_SPRITE = `
    precision mediump float;
    varying vec3 vColor;
    void main(){
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = length(d);
      float halo = smoothstep(0.5, 0.0, r);
      float core = smoothstep(0.18, 0.0, r);
      vec3 col = vColor * (halo * 0.65 + core * 1.4);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ── post FX ────────────────────────────────────────────────── */
  const FS_BRIGHT = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform float uThresh;
    uniform float uKnee;
    void main(){
      vec3 c = texture2D(uTex, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float w = smoothstep(uThresh, uThresh + uKnee, l);
      gl_FragColor = vec4(c * w, 1.0);
    }
  `;
  const FS_BLUR = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform vec2 uDir;
    void main(){
      vec3 acc = texture2D(uTex, vUv).rgb * 0.227027;
      vec2 o1 = uDir * 1.3846153846;
      vec2 o2 = uDir * 3.2307692308;
      acc += (texture2D(uTex, vUv + o1).rgb + texture2D(uTex, vUv - o1).rgb) * 0.3162162162;
      acc += (texture2D(uTex, vUv + o2).rgb + texture2D(uTex, vUv - o2).rgb) * 0.0702702703;
      gl_FragColor = vec4(acc, 1.0);
    }
  `;
  const FS_COMP = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uScene;
    uniform sampler2D uBloom;
    uniform float uBloomStr;
    uniform float uVig;
    uniform float uScan;
    uniform float uGrain;
    uniform float uCA;
    uniform float uTime;
    ${NOISE_GLSL}
    void main(){
      vec2 uv = vUv;
      vec2 dir = uv - 0.5;
      float d = length(dir);

      /* chromatic aberration (radial RGB split) */
      float ca = uCA * d;
      vec3 col;
      col.r = texture2D(uScene, uv + dir * ca).r;
      col.g = texture2D(uScene, uv).g;
      col.b = texture2D(uScene, uv - dir * ca).b;

      vec3 bloom = texture2D(uBloom, uv).rgb;
      col += bloom * uBloomStr;

      /* vignette */
      col *= 1.0 - uVig * d * d * 1.35;

      /* scanlines (subtle, 2px period) */
      col *= 1.0 - uScan * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159265));

      /* film grain */
      float g = hash12(gl_FragCoord.xy + vec2(fract(uTime) * 61.7, fract(uTime * 1.3) * 123.1));
      col += (g - 0.5) * uGrain;

      /* soft tonemap guard against blowout */
      col = col / (1.0 + max(0.0, col - 1.0) * 0.35);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ═════════════════════════════════════════════════════════════
     3 · PROGRAM / RESOURCE WRAPPERS
  ═══════════════════════════════════════════════════════════════ */
  const programs = {};

  function prep(src){
    if(isGL2 && derivExt){
      return '#extension GL_OES_standard_derivatives : enable\n' + src;
    }
    return src;
  }

  function compileShader(type, src, label){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('shader compile failed (' + label + '): ' + log);
    }
    return s;
  }

  function createProgram(name, vsSrc, fsSrc, attribs){
    const vs = compileShader(gl.VERTEX_SHADER, prep(vsSrc), name + ':vs');
    const fs = compileShader(gl.FRAGMENT_SHADER, prep(fsSrc), name + ':fs');
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    /* pin attribute locations for a stable VAO layout */
    const locs = { aPos: 0, aNormal: 1, aSize: 2, aColor: 3 };
    (attribs || Object.keys(locs)).forEach(a => {
      gl.bindAttribLocation(prog, locs[a] !== undefined ? locs[a] : 99, a);
    });
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
      const log = gl.getProgramInfoLog(prog);
      throw new Error('program link failed (' + name + '): ' + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    /* introspect active uniforms */
    const uni = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for(let i = 0; i < n; i++){
      const info = gl.getActiveUniform(prog, i);
      if(!info) continue;
      const nm = info.name.replace(/\[0\]$/, '');
      uni[nm] = gl.getUniformLocation(prog, info.name);
    }
    const at = {};
    const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
    for(let i = 0; i < na; i++){
      const info = gl.getActiveAttrib(prog, i);
      if(!info) continue;
      at[info.name] = gl.getAttribLocation(prog, info.name);
    }
    const P = { name: name, prog: prog, uni: uni, at: at, use: function(){ gl.useProgram(this.prog); } };
    programs[name] = P;
    return P;
  }

  function makeBuffer(data, target){
    target = target || gl.ARRAY_BUFFER;
    const buf = gl.createBuffer();
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return buf;
  }

  /* specs: {loc, size, data | buffer, divisor?}
     `data`    → fresh STATIC_DRAW buffer from the typed array
     `buffer`  → an existing GL buffer (for DYNAMIC_DRAW streams)   */
  function makeVAO(specs){
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    specs.forEach(s => {
      if(s.buffer){
        gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
      }else{
        gl.bindBuffer(gl.ARRAY_BUFFER, makeBuffer(s.data));
      }
      gl.enableVertexAttribArray(s.loc);
      gl.vertexAttribPointer(s.loc, s.size, gl.FLOAT, false, 0, 0);
      if(s.divisor) gl.vertexAttribDivisor(s.loc, s.divisor);
    });
    gl.bindVertexArray(null);
    return vao;
  }

  function makeTarget(w, h, opts){
    opts = opts || {};
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if(opts.depth !== false){
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      fbo._rb = rb;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const T = { fbo: fbo, tex: tex, w: w, h: h };
    T.delete = function(){
      gl.deleteFramebuffer(T.fbo);
      gl.deleteTexture(T.tex);
      if(T._rb) gl.deleteRenderbuffer(T._rb);
    };
    return T;
  }

  /* ═════════════════════════════════════════════════════════════
     4 · SCENE GRAPH (flat registry; p05 fills it)
  ═══════════════════════════════════════════════════════════════ */
  const objects = [];   /* {name, vao, count, mode, draw(state)} */
  const onFrame = [];   /* (dt, time, state) → mutate/draw prep */

  function addObject(o){
    objects.push(o);
    return o;
  }
  function addObjectDraw(name, vao, count, mode, draw){
    return addObject({ name: name, vao: vao, count: count, mode: mode || gl.TRIANGLES, draw: draw });
  }

  /* ═════════════════════════════════════════════════════════════
     5 · CAMERA
  ═══════════════════════════════════════════════════════════════ */
  const { Vec3, Mat4, AMath } = Aqua.math;
  const camera = {
    yaw: -0.5,
    pitch: -0.14,
    radius: 8.2,
    target: new Vec3(0, 0.55, 0),
    pos: new Vec3(0, 2.4, 8.2),
    fov: 62 * Math.PI / 180,
    near: 0.1,
    far: 220,
    view: new Mat4(),
    proj: new Mat4(),
    vp: new Mat4(),
    /* smoothed values (input writes desired, loop eases actual) */
    dYaw: -0.5,
    dPitch: -0.14,
    dRadius: 8.2,
    update(dt){
      const k = 1 - Math.exp(-dt * 6.0);
      this.yaw += (this.dYaw - this.yaw) * k;
      this.pitch += (this.dPitch - this.pitch) * k;
      this.radius += (this.dRadius - this.radius) * k;
      const cp = Math.cos(this.pitch);
      this.pos.set(
        this.target.x + this.radius * cp * Math.sin(this.yaw),
        this.target.y + this.radius * Math.sin(this.pitch),
        this.target.z + this.radius * cp * Math.cos(this.yaw)
      );
      this.view.lookAt(this.pos, this.target, new Vec3(0, 1, 0));
      this.proj.perspective(this.fov, canvas.clientWidth / Math.max(1, canvas.clientHeight), this.near, this.far);
      /* vp = proj · view  (multiply(m): this = this·m, m applied first) */
      this.vp.copy(this.proj).multiply(this.view);
    }
  };
  camera.update(0.016);

  /* ═════════════════════════════════════════════════════════════
     6 · STATE (colors / energy / fx params)
  ═══════════════════════════════════════════════════════════════ */
  function hexToRgb(hex){
    hex = String(hex).replace('#', '');
    if(hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = parseInt(hex, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const state = {
    time: 0,
    energy: 0,          /* smoothed 0..1 */
    energyRaw: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    colors: { c1: [0, 0.898, 1], c2: [1, 0.176, 0.584], c3: [0.486, 0.302, 1] },
    fx: {
      bloomStr: 1.15,
      vig: 0.42,
      scan: 0.10,
      grain: 0.035,
      ca: 0.012
    },
    playing: false,
    paused: false
  };
  function applyPalette(p){
    state.colors.c1 = hexToRgb(p.a1);
    state.colors.c2 = hexToRgb(p.a2);
    state.colors.c3 = hexToRgb(p.a3);
  }

  /* ═════════════════════════════════════════════════════════════
     7 · RESIZE
  ═══════════════════════════════════════════════════════════════ */
  let sceneT = null, brightT = null, blurA = null, blurB = null;
  function resizeGL(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if(canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    if(sceneT) sceneT.delete();
    if(brightT) brightT.delete();
    if(blurA) blurA.delete();
    if(blurB) blurB.delete();
    sceneT = makeTarget(w, h, { depth: true });
    brightT = makeTarget(w, h, { depth: false });
    blurA = makeTarget(w, h, { depth: false });
    blurB = makeTarget(w, h, { depth: false });
    state.fxW = w;
    state.fxH = h;
    state.pixScale = h / 900.0;
  }

  /* ═════════════════════════════════════════════════════════════
     8 · DRAW PRIMITIVES (used by this part + p05)
  ═══════════════════════════════════════════════════════════════ */
  let quadVAO = null, floorVAO = null;

  function drawQuad(name){
    const P = programs[name];
    if(!P) return;
    P.use();
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 4);
    gl.bindVertexArray(null);
  }

  /* ═════════════════════════════════════════════════════════════
     9 · RENDER LOOP (single owner)
  ═══════════════════════════════════════════════════════════════ */
  let lastT = performance.now();
  let running = false;

  function setCommonUniforms(prog){
    const P = programs[prog];
    if(!P) return;
    const u = P.uni;
    if(u.uTime) gl.uniform1f(u.uTime, state.time);
    if(u.uEnergy) gl.uniform1f(u.uEnergy, state.energy);
    if(u.uC1) gl.uniform3fv(u.uC1, state.colors.c1);
    if(u.uC2) gl.uniform3fv(u.uC2, state.colors.c2);
    if(u.uC3) gl.uniform3fv(u.uC3, state.colors.c3);
  }

  function renderSceneToBuffer(){
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneT.fbo);
    gl.viewport(0, 0, sceneT.w, sceneT.h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(0.002, 0.003, 0.008, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* pass 1 — nebula background (no depth write) */
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    const pn = programs.nebula;
    pn.use();
    gl.uniform2f(pn.uni.uRes, sceneT.w, sceneT.h);
    setCommonUniforms('nebula');
    drawQuad('nebula');
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    /* pass 2 — grid floor (opaque) */
    const pf = programs.floor;
    pf.use();
    gl.uniformMatrix4fv(pf.uni.uVP, false, camera.vp.e);
    gl.uniform1f(pf.uni.uLineWidth, 0.02);
    setCommonUniforms('floor');
    gl.bindVertexArray(floorVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    /* pass 3 — scene objects registered by p05+ */
    for(let i = 0; i < objects.length; i++){
      const o = objects[i];
      if(!o.draw) continue;
      o.draw({
        gl: gl,
        camera: camera,
        state: state,
        programs: programs,
        setCommonUniforms: setCommonUniforms,
        time: state.time,
        dt: frameDT
      });
    }
  }

  function renderPost(){
    /* bright pass */
    gl.bindFramebuffer(gl.FRAMEBUFFER, brightT.fbo);
    gl.viewport(0, 0, brightT.w, brightT.h);
    gl.disable(gl.DEPTH_TEST);
    const pb = programs.bright;
    pb.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
    gl.uniform1i(pb.uni.uTex, 0);
    gl.uniform1f(pb.uni.uThresh, 0.62);
    gl.uniform1f(pb.uni.uKnee, 0.35);
    drawQuad('bright');

    /* blur: 2 separable iterations with 3-buffer rotation.
       buffers are (src, a, b) — all distinct at every step:
         H:  src → a
         V:  a   → b
         rotate: (src, a, b) = (b, src, a)
       after 2 iterations the blurred result lives in `src`.   */
    const pbl = programs.blur;
    pbl.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(pbl.uni.uTex, 0);
    let src = brightT, a = blurA, b = blurB;
    for(let i = 0; i < 2; i++){
      const k = (0.7 + i * 1.7) / src.h;
      /* horizontal */
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(pbl.uni.uDir, k, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
      gl.viewport(0, 0, a.w, a.h);
      drawQuad('blur');
      /* vertical */
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform2f(pbl.uni.uDir, 0, k);
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
      gl.viewport(0, 0, b.w, b.h);
      drawQuad('blur');
      /* rotate roles */
      const t = src;
      src = b;
      b = a;
      a = t;
    }

    /* composite to screen */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const pc = programs.comp;
    pc.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
    gl.uniform1i(pc.uni.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(pc.uni.uBloom, 1);
    gl.uniform1f(pc.uni.uBloomStr, state.fx.bloomStr);
    gl.uniform1f(pc.uni.uVig, state.fx.vig);
    gl.uniform1f(pc.uni.uScan, state.fx.scan);
    gl.uniform1f(pc.uni.uGrain, state.fx.grain);
    gl.uniform1f(pc.uni.uCA, state.fx.ca);
    gl.uniform1f(pc.uni.uTime, state.time);
    drawQuad('comp');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  let frameDT = 0.016;
  function frame(now){
    if(lost){
      lastT = now;
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    frameDT = dt;
    if(!document.hidden){
      state.time += dt;
      /* energy smoothing */
      const ek = 1 - Math.exp(-dt * 10.0);
      state.energy += (state.energyRaw - state.energy) * ek;
      const sk = 1 - Math.exp(-dt * 5.0);
      state.bass += ((state.energyRaw > 0 ? Math.min(1, state.energyRaw * 1.4) : 0) - state.bass) * sk;

      camera.update(dt);

      /* per-frame hooks (camera input, particles, tweening) */
      for(let i = 0; i < onFrame.length; i++){
        try{
          onFrame[i](dt, state.time, state);
        }catch(err){
          console.error('[Aqua GL] onFrame error:', err);
        }
      }

      renderSceneToBuffer();
      renderPost();
      glCheck('frame');
      Aqua.perf.tick();
    }
    requestAnimationFrame(frame);
  }

  /* ═════════════════════════════════════════════════════════════
     10 · CONTEXT LOST / RESTORED
  ═══════════════════════════════════════════════════════════════ */
  function onLost(e){
    e.preventDefault();
    lost = true;
    Aqua.bus.emit('gl:lost');
    console.warn('[Aqua GL] context lost');
  }
  function onRestored(){
    lost = false;
    try{
      initResources();
      resizeGL();
      Aqua.bus.emit('gl:ready');
      console.info('[Aqua GL] context restored');
    }catch(err){
      console.error('[Aqua GL] restore failed:', err);
    }
  }

  /* ═════════════════════════════════════════════════════════════
     11 · INIT
  ═══════════════════════════════════════════════════════════════ */
  let res = 0;
  function initResources(){
    res++;
    /* programs */
    createProgram('nebula', VS_QUAD, FS_NEBULA);
    createProgram('floor', VS_FLOOR, FS_FLOOR, ['aPos']);
    createProgram('solid', VS_SOLID, FS_SOLID, ['aPos', 'aNormal']);
    createProgram('line', VS_LINE, FS_LINE, ['aPos']);
    createProgram('sprite', VS_SPRITE, FS_SPRITE, ['aPos', 'aSize', 'aColor']);
    createProgram('bright', VS_QUAD, FS_BRIGHT);
    createProgram('blur', VS_QUAD, FS_BLUR);
    createProgram('comp', VS_QUAD, FS_COMP);
    glCheck('programs');

    /* fullscreen quad */
    quadVAO = makeVAO([
      { loc: 0, size: 2, data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]) }
    ]);

    /* grid floor: 400×400 quad, 24 units tall over y=0 plane */
    const S = 120;
    floorVAO = makeVAO([
      { loc: 0, size: 3, data: new Float32Array([
        -S, 0, -S,   S, 0, -S,
        -S, 0,  S,   S, 0,  S
      ]) }
    ]);
    glCheck('vaos');
  }

  /* ── boot ───────────────────────────────────────────────────── */
  const ok = acquireContext();
  if(!ok){
    /* graceful degradation — 2D layer keeps the show alive */
    const led = Aqua.el('ledEngine');
    if(led){
      led.classList.remove('warn', 'on');
      led.classList.add('err');
    }
    const se = Aqua.el('statEngine');
    if(se) se.textContent = 'ENGINE: 2D (NO WEBGL)';
    Aqua.showBanner('WebGL unavailable — running 2D fallback mode');
    console.warn('[Aqua GL] no WebGL context — 2D fallback');
    return;
  }

  initResources();
  resizeGL();
  window.addEventListener('resize', resizeGL);
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  /* ── self-test: one clean frame ─────────────────────────────── */
  camera.update(0.016);
  renderSceneToBuffer();
  renderPost();
  const err = gl.getError();
  if(err !== gl.NO_ERROR){
    console.error('[Aqua GL] self-test failed: 0x' + err.toString(16));
    Aqua.showBanner('WebGL self-test failed (0x' + err.toString(16) + ')');
  }

  /* ── hand the stage over: fade the 2D layer, start loop ────── */
  const fx2d = Aqua.el('fx2d');
  if(fx2d){
    fx2d.style.transition = 'opacity 0.9s ease';
    fx2d.style.opacity = '0';
  }
  if(!running){
    running = true;
    lastT = performance.now();
    requestAnimationFrame(frame);
  }
  Aqua.bus.emit('gl:ready');

  /* ── LEDs ───────────────────────────────────────────────────── */
  const led = Aqua.el('ledEngine');
  if(led){
    led.classList.remove('warn', 'err');
    led.classList.add('on');
  }
  const se = Aqua.el('statEngine');
  if(se) se.textContent = 'ENGINE: WEBGL ' + (isGL2 ? '2.0' : '1.0');

  /* ── bus wiring ─────────────────────────────────────────────── */
  Aqua.bus.on('audio:energy', e => { state.energyRaw = AMath.clamp01(e || 0); });
  Aqua.bus.on('audio:bands', b => {
    if(b){
      state.bass = AMath.clamp01(b.bass || 0);
      state.mid = AMath.clamp01(b.mid || 0);
      state.treble = AMath.clamp01(b.treble || 0);
    }
  });
  Aqua.bus.on('palette:change', p => applyPalette(p));
  Aqua.bus.on('audio:playing', p => { state.playing = !!p; });
  Aqua.bus.on('audio:pause', p => { state.paused = !!p; });

  /* initial palette from CSS */
  const cs = getComputedStyle(document.documentElement);
  applyPalette({
    a1: cs.getPropertyValue('--a1').trim() || '#00e5ff',
    a2: cs.getPropertyValue('--a2').trim() || '#ff2d95',
    a3: cs.getPropertyValue('--a3').trim() || '#7c4dff'
  });

  /* ── expose ─────────────────────────────────────────────────── */
  Aqua.gl = {
    gl: gl,
    isWebGL2: isGL2,
    canvas: canvas,
    programs: programs,
    camera: camera,
    state: state,
    addObject: addObject,
    addDraw: addObjectDraw,
    onFrame: onFrame,
    resize: resizeGL,
    makeBuffer: makeBuffer,
    makeVAO: makeVAO,
    makeTarget: makeTarget,
    createProgram: createProgram,
    applyPalette: applyPalette,
    hexToRgb: hexToRgb
  };

  console.info('[Aqua GL] core ready — WebGL ' + (isGL2 ? '2.0' : '1.0') +
    ', ' + Object.keys(programs).length + ' programs, render loop live');
});

/* ═══════════════ PART: p04_geom.js ═══════════════ */

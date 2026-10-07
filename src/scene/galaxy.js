/* ═══════════════════════════════════════════════════════════════════
   src/scene/galaxy.js — BEAT-REACTIVE SPIRAL GALAXY (part: "galaxy")
   ───────────────────────────────────────────────────────────────────
   A large field of GPU point-particles arranged in a tilted spiral
   disc + a surrounding halo.  Every particle's animated position is
   computed in the vertex shader from a small per-particle seed, so the
   whole system is a single draw call with no per-frame CPU upload — it
   stays smooth even with thousands of points.

   NOTE on attribute names: the shared program compiler (gl-core) only
   pins the canonical locations aPos=0 / aNormal=1 / aSize=2 / aColor=3.
   We therefore reuse aPos (loc 0) to carry the per-particle SEED and
   aNormal (loc 1) to carry the per-particle META.  The names are just
   stable location tags; the sizes are set per-VAO below.

   Reactions (driven by the analyser state the other parts publish):
     · uEnergy  → disc brightness, spin-up, size bloom
     · uBass    → the disc "breathes" (radial flare on the downbeats)
     · uMid     → arm swirl tightness
     · uTreble  → the outer halo shimmers and lifts

   Integration:
     · registered on Aqua.gl as a scene object (drawn in pass 3)
     · additive blended, rendered before the bloom pass so it glows
     · a no-op when WebGL is unavailable (the app degrades gracefully)
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('galaxy', function initGalaxy(){
  'use strict';

  const A  = Aqua;
  const G  = A.gl;
  const gl = G && G.gl;
  if(!gl){ return; }   // no WebGL → skip (rest of the app still works)

  const cl  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const TAU = Math.PI * 2;

  /* number of points.  The disc is the visual hero; the halo adds depth.
     6000 is comfortably within budget on any modern GPU/mobile. */
  const N_DISC = 4200;
  const N_HALO = 1600;
  const N = N_DISC + N_HALO;

  /* deterministic RNG (mulberry32) so the galaxy looks the same every
     load — stable across reloads and test runs. */
  function rng(seed){
    let a = (seed >>> 0) || 1;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ─────────────────────────────────────────────────────────────────
     PER-PARTICLE DATA
     aPos    = (angle0, radius0, yBase, speed)     [vec4, loc 0]
     aNormal = (size, colorMix 0..1, phase)        [vec3, loc 1]
     Uploaded once.  The vertex shader animates from here.
  ───────────────────────────────────────────────────────────────── */
  const ARM = 3;                 // spiral arms
  const rnd = rng(1337);

  const seeds = new Float32Array(N * 4);
  const metas = new Float32Array(N * 3);

  for(let i = 0; i < N; i++){
    const halo = i >= N_DISC;
    if(!halo){
      /* ── disc: points scattered along ARM logarithmic spirals ── */
      const arm   = (i % ARM);
      const t     = Math.pow(rnd(), 0.62);          // bias toward the core
      const rad   = 0.25 + t * 3.15;                // 0.25 .. 3.4 units out
      const spread= 0.12 + (1 - t) * 0.55;          // tighter at the core
      const ang   = (arm / ARM) * TAU
                  + t * 5.2                          // spiral winding
                  + (rnd() - 0.5) * spread;
      const y     = (rnd() - 0.5) * (0.12 + (1 - t) * 0.22);
      const speed = 0.05 + (1 - t) * 0.05;          // core rotates faster
      seeds[i*4]   = ang;
      seeds[i*4+1] = rad;
      seeds[i*4+2] = y;
      seeds[i*4+3] = speed;
      metas[i*3]   = 1.2 + rnd() * 2.2;             // point size
      metas[i*3+1] = cl(t * 1.15, 0, 1);            // colour mix (core→rim)
      metas[i*3+2] = rnd() * TAU;                   // phase
    }else{
      /* ── halo: a loose spherical cloud for depth + shimmer ── */
      const rad  = 3.4 + rnd() * 3.2;
      const u    = rnd() * 2 - 1;                   // cos(polar)
      const th   = rnd() * TAU;
      seeds[i*4]   = th;
      seeds[i*4+1] = rad;
      seeds[i*4+2] = u * rad * 0.5;                 // vertical spread
      seeds[i*4+3] = 0.01 + rnd() * 0.02;           // very slow drift
      metas[i*3]   = 0.8 + rnd() * 1.6;
      metas[i*3+1] = 0.55 + rnd() * 0.45;           // brighter mix
      metas[i*3+2] = rnd() * TAU;
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     SHADERS (WebGL1 syntax — compiles on both 1.0 and 2.0 contexts)
  ───────────────────────────────────────────────────────────────── */
  const VS = [
    'precision highp float;',
    'attribute vec4 aPos;',        // (angle0, radius0, yBase, speed)
    'attribute vec3 aNormal;',     // (size, colorMix, phase)
    'uniform mat4  uVP;',
    'uniform float uTime;',
    'uniform float uEnergy;',
    'uniform float uBass;',
    'uniform float uMid;',
    'uniform float uTreble;',
    'uniform float uSize;',
    'uniform vec3  uC1;',
    'uniform vec3  uC2;',
    'uniform vec3  uC3;',
    'varying   vec3  vColor;',
    'varying   float vAlpha;',
    'void main(){',
    '  float spin   = uTime * aPos.w * (0.35 + uEnergy * 0.85);',
    '  float angle  = aPos.x + spin;',
    '  float breath = 1.0 + uBass * 0.55;',
    '  float swell  = 0.85 + 0.30 * sin(aNormal.z + uTime * 1.4);',
    '  float radius = aPos.y * breath * swell;',
    '  vec3 p = vec3(',
    '    cos(angle) * radius,',
    '    aPos.z + sin(uTime * 0.6 + aNormal.z) * (0.18 + uTreble * 0.35),',
    '    sin(angle) * radius',
    '  );',
    '  p.y *= 0.55;',                                 // flatten into a disc
    '  p.xz *= 1.0 - uMid * 0.12;',                   // mid-reactive swirl
    '  vec4 clip = uVP * vec4(p, 1.0);',
    '  gl_Position = clip;',
    '  float dist = max(0.1, clip.w);',
    '  gl_PointSize = clamp(',
    '    (aNormal.x * uSize * (0.7 + uEnergy * 1.1)) * (300.0 / dist),',
    '    1.0, 42.0',
    '  );',
    '  float m = clamp(aNormal.y, 0.0, 1.0);',        // core → rim blend
    '  vec3 cold = uC1;',
    '  vec3 hot  = uC2;',
    '  vec3 midc = uC3;',
    '  vColor = (m < 0.5)',
    '    ? mix(midc, cold, m * 2.0)',
    '    : mix(cold, hot, (m - 0.5) * 2.0);',
    '  vColor += uC1 * (1.0 - m) * 0.35 * (0.4 + uEnergy);',
    '  vAlpha = 0.28 + 0.5 * uEnergy + 0.12 * uTreble;',
    '}'
  ].join('\n');

  const FS = [
    'precision mediump float;',
    'varying vec3  vColor;',
    'varying float vAlpha;',
    'void main(){',
    '  vec2 c = gl_PointCoord - vec2(0.5);',
    '  float d = length(c) * 2.0;',
    '  float a = smoothstep(1.0, 0.0, d);',
    '  a = a * a;',                                    // soft round point
    '  float core = smoothstep(0.5, 0.0, d);',
    '  vec3 col = vColor + vColor * core * 0.8;',      // bright centre
    '  gl_FragColor = vec4(col * a, a * vAlpha);',
    '}'
  ].join('\n');

  /* compile our own program (the built-in 9 are registered by gl-core).
     aPos→0 and aNormal→1 are the pinned locations the VAO binds to. */
  const P = G.createProgram('galaxy', VS, FS, ['aPos', 'aNormal']);
  if(!P){
    console.warn('[Aqua Galaxy] program failed to compile — disabled');
    return;
  }

  const seedBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
  gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const metaBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, metaBuf);
  gl.bufferData(gl.ARRAY_BUFFER, metas, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const vao = G.makeVAO([
    { loc: 0, size: 4, buffer: seedBuf },   // aPos    = seed
    { loc: 1, size: 3, buffer: metaBuf }    // aNormal = meta
  ]);

  /* global size multiplier, tunable at runtime (A.scene.galaxy.set) */
  let sizeMul = 1.0;

  /* ─────────────────────────────────────────────────────────────────
     DRAW — scene object, additive, no depth write (drawn in pass 3)
  ───────────────────────────────────────────────────────────────── */
  G.addObject({
    name: 'galaxy',
    draw: function(ctx){
      const P2 = ctx.programs.galaxy;
      if(!P2) return;
      const st = ctx.state;
      P2.use();
      ctx.gl.uniformMatrix4fv(P2.uni.uVP, false, ctx.camera.vp.e);
      ctx.setCommonUniforms('galaxy');              // uTime/uEnergy/uC1-3
      if(P2.uni.uBass)    ctx.gl.uniform1f(P2.uni.uBass,    st.bass);
      if(P2.uni.uMid)     ctx.gl.uniform1f(P2.uni.uMid,     st.mid);
      if(P2.uni.uTreble)  ctx.gl.uniform1f(P2.uni.uTreble,  st.treble);
      if(P2.uni.uSize)    ctx.gl.uniform1f(P2.uni.uSize, sizeMul);

      ctx.gl.enable(ctx.gl.BLEND);
      ctx.gl.blendFunc(ctx.gl.SRC_ALPHA, ctx.gl.ONE);   // additive
      ctx.gl.depthMask(false);
      ctx.gl.bindVertexArray(vao);
      ctx.gl.drawArrays(ctx.gl.POINTS, 0, N);
      ctx.gl.bindVertexArray(null);
      ctx.gl.depthMask(true);
      ctx.gl.disable(ctx.gl.BLEND);
    }
  });

  /* expose for the scene manager + tests */
  A.scene = A.scene || {};
  A.scene.galaxy = {
    count: N,
    set: function(cfg){
      if(cfg && typeof cfg.size === 'number') sizeMul = cl(cfg.size, 0.3, 3);
    }
  };

  console.info('[Aqua Galaxy] spiral disc online — ' + N + ' gpu points (' +
               N_DISC + ' disc / ' + N_HALO + ' halo)');
});

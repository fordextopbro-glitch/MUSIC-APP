/* ═══════════════════════════════════════════════════════════════════
   PART p04 · GEOMETRY — MESH GENERATORS + 3D SCENE OBJECTS
   ─────────────────────────────────────────────────────────────────
   Generators (all CPU-side, deterministic, zero allocations at run
   time after boot):
     · Torus-knot tube   (parallel-transport frames, true normals)
     · Icosahedron → icosphere (midpoint subdivision, any detail)
     · Ico edge set      (unique edges for wireframe overlays)
     · Unit box          (for the spectrum bar ring)
     · Star field        (point cloud on a far shell)
     · Spark clouds      (point shells that orbit the core)
     · Waveform tube     (ring swept along the audio waveform)
   Scene objects registered on Aqua.gl with per-frame draw calls:
     · knot   — torus knot, audio-pulsing scale, drag-spin inertia
     · wire   — ico cage counter-rotating around the knot
     · bars   — 20 spectrum bars on a ring (20 draw calls, cheap)
     · tube   — live waveform ribbon
     · stars  — slow-rotating far star field
     · sparks — two counter-rotating spark clouds
   The part owns all scene motion (motion state) and exposes
   Aqua.geo for input (p08) + audio (p07) + demo (p09).
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('geometry', function initGeometry(){
  'use strict';

  /* no WebGL → nothing to build (2D fallback carries the show) */
  if(!Aqua.gl || !Aqua.gl.gl) return;

  const G = Aqua.gl;
  const gl = G.gl;
  const { Vec3, Mat4, Quat, ARand, AMath, AColor } = Aqua.math;
  const st = G.state;

  /* audio-driven data buffers (p07 fills these; p09 drives them in
     demo mode; bars/wave read them every frame) */
  const BAR_COUNT = 20;
  const WAVE_STEPS = 48;
  st.bands = st.bands || new Float32Array(BAR_COUNT);
  st.wave = st.wave || new Float32Array(WAVE_STEPS);

  /* ═════════════════════════════════════════════════════════════
     1 · TORSUS-KNOT TUBE
  ═══════════════════════════════════════════════════════════════ */
  function cross3(a, b, out){
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
    return out;
  }
  function dot3(a, b){ return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm3(a, out){
    const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
    out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l;
    return out;
  }

  /* torus knot p/q standing upright (axis = Y).
     p=2, q=3 is the classic trefoil.                            */
  function buildTorusKnot(p, q, R, r, tube, segs, rings){
    const C = new Array(segs);
    const T = new Array(segs);
    const B = new Array(segs);
    const N = new Array(segs);
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];

    for(let i = 0; i < segs; i++){
      const t = (i / segs) * TWO_PI;
      const qt = q * t;
      const rad = R + r * Math.cos(qt);
      C[i] = [
        rad * Math.cos(p * t),
        r * Math.sin(qt),
        rad * Math.sin(p * t)
      ];
    }
    for(let i = 0; i < segs; i++){
      const i0 = (i - 1 + segs) % segs;
      const i1 = (i + 1) % segs;
      a[0] = C[i1][0] - C[i0][0];
      a[1] = C[i1][1] - C[i0][1];
      a[2] = C[i1][2] - C[i0][2];
      norm3(a, T[i] = [0, 0, 0]);
    }
    /* seed a binormal not parallel to T[0] */
    cross3(T[0], [0, 1, 0.37], a);
    if(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] < 1e-8) cross3(T[0], [1, 0, 0], a);
    norm3(a, B[0] = [0, 0, 0]);
    for(let i = 0; i < segs; i++){
      if(i > 0){
        /* parallel transport: project previous binormal onto the
           plane ⟂ T[i], then re-orthonormalise */
        const d = dot3(B[i - 1], T[i]);
        a[0] = B[i - 1][0] - T[i][0] * d;
        a[1] = B[i - 1][1] - T[i][1] * d;
        a[2] = B[i - 1][2] - T[i][2] * d;
        norm3(a, B[i] = [0, 0, 0]);
      }
      cross3(B[i], T[i], c);
      norm3(c, N[i] = [0, 0, 0]);
    }

    const vCount = segs * rings;
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    let vi = 0;
    for(let i = 0; i < segs; i++){
      for(let k = 0; k < rings; k++){
        const th = (k / rings) * TWO_PI;
        const ct = Math.cos(th), sn = Math.sin(th);
        const nx = ct * N[i][0] + sn * B[i][0];
        const ny = ct * N[i][1] + sn * B[i][1];
        const nz = ct * N[i][2] + sn * B[i][2];
        const o = vi * 3;
        pos[o]     = C[i][0] + tube * nx;
        pos[o + 1] = C[i][1] + tube * ny;
        pos[o + 2] = C[i][2] + tube * nz;
        nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
        vi++;
      }
    }
    /* de-indexed triangles */
    const tCount = segs * rings * 6;
    const out = new Float32Array(tCount * 3);
    const on = new Float32Array(tCount * 3);
    let oi = 0;
    const push = (i, k) => {
      const s = ((i % segs) * rings + (k % rings)) * 3;
      out[oi++] = pos[s]; out[oi++] = pos[s + 1]; out[oi++] = pos[s + 2];
      on[oi - 3] = nrm[s]; on[oi - 2] = nrm[s + 1]; on[oi - 1] = nrm[s + 2];
    };
    for(let i = 0; i < segs; i++){
      for(let k = 0; k < rings; k++){
        const i1 = (i + 1) % segs, k1 = (k + 1) % rings;
        /* quad (i,k)-(i1,k)-(i1,k1)-(i,k1) → 2 tris, ccw */
        push(i, k);   push(i1, k);  push(i1, k1);
        push(i, k);   push(i1, k1); push(i, k1);
      }
    }
    return { positions: out, normals: on, count: tCount };
  }

  /* ═════════════════════════════════════════════════════════════
     2 · ICOSAHEDRON / ICOSPHERE
  ═══════════════════════════════════════════════════════════════ */
  const ICO_T = (1 + Math.sqrt(5)) / 2;
  const ICO_BASE_VERTS = [
    [-1,  ICO_T, 0], [1,  ICO_T, 0], [-1, -ICO_T, 0], [1, -ICO_T, 0],
    [0, -1,  ICO_T], [0, 1,  ICO_T], [0, -1, -ICO_T], [0, 1, -ICO_T],
    [ ICO_T, 0, -1], [ ICO_T, 0, 1], [-ICO_T, 0, -1], [-ICO_T, 0, 1]
  ].map(v => norm3(v, [0, 0, 0]));
  const ICO_BASE_FACES = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];

  function icosahedron(detail, radius){
    let verts = ICO_BASE_VERTS.map(v => [v[0], v[1], v[2]]);
    let faces = ICO_BASE_FACES.map(f => f.slice());
    const cache = new Map();
    const mid = (i, j) => {
      const key = i < j ? i * 100000 + j : j * 100000 + i;
      if(cache.has(key)) return cache.get(key);
      const a = verts[i], b = verts[j];
      const m = norm3([
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
        (a[2] + b[2]) / 2
      ], [0, 0, 0]);
      verts.push(m);
      cache.set(key, verts.length - 1);
      return verts.length - 1;
    };
    for(let d = 0; d < detail; d++){
      const nf = [];
      for(let f = 0; f < faces.length; f++){
        const a = faces[f][0], b = faces[f][1], c = faces[f][2];
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        nf.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      }
      faces = nf;
    }
    /* de-indexed + sphere-projected (already unit; scale to radius) */
    const pos = new Float32Array(faces.length * 9);
    const nrm = new Float32Array(faces.length * 9);
    let oi = 0;
    for(let f = 0; f < faces.length; f++){
      for(let k = 0; k < 3; k++){
        const v = verts[faces[f][k]];
        pos[oi] = v[0] * radius; pos[oi + 1] = v[1] * radius; pos[oi + 2] = v[2] * radius;
        nrm[oi] = v[0]; nrm[oi + 1] = v[1]; nrm[oi + 2] = v[2];
        oi += 3;
      }
    }
    return { positions: pos, normals: nrm, count: faces.length * 3 };
  }

  /* unique edges of the (unsubdivided) icosahedron → line vertex
     buffer for the neon cage overlay */
  function icoEdges(radius){
    const seen = new Set();
    const lines = [];
    for(let f = 0; f < ICO_BASE_FACES.length; f++){
      const tri = ICO_BASE_FACES[f];
      for(let k = 0; k < 3; k++){
        const a = tri[k], b = tri[(k + 1) % 3];
        const key = a < b ? a * 64 + b : b * 64 + a;
        if(seen.has(key)) continue;
        seen.add(key);
        const va = ICO_BASE_VERTS[a], vb = ICO_BASE_VERTS[b];
        lines.push(
          va[0] * radius, va[1] * radius, va[2] * radius,
          vb[0] * radius, vb[1] * radius, vb[2] * radius
        );
      }
    }
    return new Float32Array(lines);
  }

  /* ═════════════════════════════════════════════════════════════
     3 · UNIT BOX  (x,z ∈ [-½,½], y ∈ [0,1]) — spectrum bars
  ═══════════════════════════════════════════════════════════════ */
  function unitBox(){
    const F = [
      /* +Y top */   [[-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5], [0, 1, 0]],
      /* -Y bottom */ [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5], [0, -1, 0]],
      /* +X */       [[0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [0.5, 0, 0.5], [1, 0, 0]],
      /* -X */       [[-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5], [-0.5, 0, -0.5], [-1, 0, 0]],
      /* +Z */       [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5], [0, 0, 1]],
      /* -Z */       [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5], [0, 0, -1]]
    ];
    const pos = new Float32Array(36 * 3);
    const nrm = new Float32Array(36 * 3);
    let oi = 0;
    for(let f = 0; f < F.length; f++){
      const q = F[f], n = q[4];
      /* order: 0,1,2 + 0,2,3 */
      const order = [q[0], q[1], q[2], q[0], q[2], q[3]];
      for(let k = 0; k < 6; k++){
        pos[oi] = order[k][0]; pos[oi + 1] = order[k][1]; pos[oi + 2] = order[k][2];
        nrm[oi] = n[0]; nrm[oi + 1] = n[1]; nrm[oi + 2] = n[2];
        oi += 3;
      }
    }
    return { positions: pos, normals: nrm, count: 36 };
  }

  /* ═════════════════════════════════════════════════════════════
     4 · POINT CLOUDS — stars + sparks
  ═══════════════════════════════════════════════════════════════ */
  function starField(count, rMin, rMax){
    const rnd = ARand.seeded('starfield');
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const col = new Float32Array(count * 3);
    const c1 = st.colors.c1, c2 = st.colors.c2;
    for(let i = 0; i < count; i++){
      /* uniform on sphere */
      const u = rnd.next() * 2 - 1;
      const ph = rnd.next() * TWO_PI;
      const s = Math.sqrt(1 - u * u);
      const r = rMin + rnd.next() * (rMax - rMin);
      pos[i * 3]     = r * s * Math.cos(ph);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s * Math.sin(ph);
      const bright = rnd.next();
      size[i] = bright > 0.94 ? rnd.range(150, 420) : rnd.range(14, 70);
      const pick = rnd.next();
      if(pick < 0.78){
        col[i * 3] = 0.82; col[i * 3 + 1] = 0.88; col[i * 3 + 2] = 1.0;
      }else if(pick < 0.93){
        col[i * 3] = c1[0]; col[i * 3 + 1] = c1[1]; col[i * 3 + 2] = c1[2];
      }else{
        col[i * 3] = c2[0]; col[i * 3 + 1] = c2[1]; col[i * 3 + 2] = c2[2];
      }
    }
    return { pos: pos, size: size, col: col, count: count };
  }

  function sparkCloud(count, seed, rMin, rMax, yMin, yMax){
    const rnd = ARand.seeded(seed);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const col = new Float32Array(count * 3);
    const c1 = st.colors.c1, c2 = st.colors.c2;
    for(let i = 0; i < count; i++){
      const u = rnd.next() * 2 - 1;
      const ph = rnd.next() * TWO_PI;
      const s = Math.sqrt(1 - u * u);
      const r = rnd.range(rMin, rMax);
      pos[i * 3]     = r * s * Math.cos(ph);
      pos[i * 3 + 1] = rnd.range(yMin, yMax) + 0.55;
      pos[i * 3 + 2] = r * s * Math.sin(ph);
      size[i] = rnd.range(6, 26);
      const m = rnd.range(0.5, 1.0);
      if(rnd.next() < 0.5){
        col[i * 3] = c1[0] * m; col[i * 3 + 1] = c1[1] * m; col[i * 3 + 2] = c1[2] * m;
      }else{
        col[i * 3] = c2[0] * m; col[i * 3 + 1] = c2[1] * m; col[i * 3 + 2] = c2[2] * m;
      }
    }
    return { pos: pos, size: size, col: col, count: count };
  }

  /* ═════════════════════════════════════════════════════════════
     5 · WAVEFORM TUBE (dynamic)
     ring of RING verts swept along WAVE_STEPS steps; the ring is
     in the Y–Z plane so normals are STATIC, only positions
     re-upload each frame.
  ═══════════════════════════════════════════════════════════════ */
  const TUBE_RING = 8;
  const TUBE_TUBE_R = 0.085;
  const TUBE_SPAN = 4.6;       /* world x extent */
  const TUBE_Y = 2.85;         /* hover height */
  const tubeVerts = WAVE_STEPS * TUBE_RING * 6;
  const tubePos = new Float32Array(tubeVerts * 3);
  const tubeNrm = new Float32Array(tubeVerts * 3);

  /* build static normals once (de-indexed quad layout) */
  (function buildTubeNormals(){
    let oi = 0;
    const n = [0, 0, 0];
    const put = (k) => {
      const th = (k / TUBE_RING) * TWO_PI;
      n[0] = 0; n[1] = Math.cos(th); n[2] = Math.sin(th);
      tubeNrm[oi++] = n[0]; tubeNrm[oi++] = n[1]; tubeNrm[oi++] = n[2];
    };
    for(let i = 0; i < WAVE_STEPS; i++){
      for(let k = 0; k < TUBE_RING; k++){
        const k1 = (k + 1) % TUBE_RING;
        const i1 = Math.min(i + 1, WAVE_STEPS - 1);
        /* tri 1: (i,k) (i+1,k) (i+1,k1) */
        put(k); put(k); put(k1);
        /* tri 2: (i,k) (i+1,k1) (i,k1) */
        put(k); put(k1); put(k1);
      }
    }
    /* (i+1 clamped on the last step — slight normal reuse, invisible) */
  })();

  function updateTubePositions(){
    let oi = 0;
    const px = [0, 0, 0];
    const vert = (i, k) => {
      const th = (k / TUBE_RING) * TWO_PI;
      const x = (i / (WAVE_STEPS - 1) - 0.5) * TUBE_SPAN;
      const y = TUBE_Y + st.wave[i] * 0.95 + TUBE_TUBE_R * Math.cos(th);
      const z = TUBE_TUBE_R * Math.sin(th);
      tubePos[oi++] = x; tubePos[oi++] = y; tubePos[oi++] = z;
    };
    for(let i = 0; i < WAVE_STEPS; i++){
      const i1 = Math.min(i + 1, WAVE_STEPS - 1);
      for(let k = 0; k < TUBE_RING; k++){
        const k1 = (k + 1) % TUBE_RING;
        vert(i, k); vert(i1, k); vert(i1, k1);
        vert(i, k); vert(i1, k1); vert(i, k1);
      }
    }
  }

  /* ═════════════════════════════════════════════════════════════
     6 · BAR SHADER (uniform per-bar transform — no instancing
        extension needed, 20 draw calls is trivial)
  ═══════════════════════════════════════════════════════════════ */
  const VS_BAR = `
    precision highp float;
    attribute vec3 aPos;
    attribute vec3 aNormal;
    uniform mat4 uVP;
    uniform vec4 uInst;    /* xyz = center, w = height */
    uniform float uBarW;
    varying vec3 vNormal;
    varying vec3 vWorld;
    varying float vH;
    void main(){
      vec3 p = vec3(aPos.x * uBarW, aPos.y * uInst.w, aPos.z * uBarW) + uInst.xyz;
      vNormal = aNormal;
      vWorld = p;
      vH = aPos.y;
      gl_Position = uVP * vec4(p, 1.0);
    }
  `;
  const FS_BAR = `
    precision highp float;
    varying vec3 vNormal;
    varying vec3 vWorld;
    varying float vH;
    uniform vec3  uCamPos;
    uniform vec3  uC1;
    uniform vec3  uC2;
    uniform vec3  uC3;
    uniform float uTime;
    uniform float uEnergy;
    void main(){
      vec3 N = normalize(vNormal);
      vec3 V = normalize(uCamPos - vWorld);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 2.0);
      float d1 = max(dot(N, normalize(vec3(0.5, 0.9, 0.35))), 0.0);
      float d2 = max(dot(N, normalize(vec3(-0.6, 0.2, -0.55))), 0.0);

      vec3 base = uC3 * (0.05 + 0.10 * d1);
      vec3 grad = mix(uC1, uC2, vH);
      vec3 col = base + grad * (0.30 + 0.75 * vH) * (0.50 + 0.90 * uEnergy);
      col += uC2 * d2 * 0.18;
      col += uC2 * fres * (0.38 + 0.85 * uEnergy);
      /* hot tip glow */
      col += uC1 * smoothstep(0.82, 1.0, vH) * (0.45 + 1.15 * uEnergy);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ═════════════════════════════════════════════════════════════
     7 · BUILD RESOURCES
  ═══════════════════════════════════════════════════════════════ */
  const knot = buildTorusKnot(2, 3, 0.98, 0.40, 0.155, 300, 18);
  const cage = icosahedron(1, 1.0);
  const edgeBuf = icoEdges(2.05);
  const box = unitBox();
  const stars = starField(1300, 55, 115);
  const sparkA = sparkCloud(300, 'sparks-a', 1.7, 3.2, -0.7, 1.5);
  const sparkB = sparkCloud(260, 'sparks-b', 2.0, 3.6, -0.4, 1.9);

  const knotVAO = G.makeVAO([
    { loc: 0, size: 3, data: knot.positions },
    { loc: 1, size: 3, data: knot.normals }
  ]);
  const cageVAO = G.makeVAO([
    { loc: 0, size: 3, data: cage.positions },
    { loc: 1, size: 3, data: cage.normals }
  ]);
  const edgeVAO = G.makeVAO([
    { loc: 0, size: 3, data: edgeBuf }
  ]);
  const boxVAO = G.makeVAO([
    { loc: 0, size: 3, data: box.positions },
    { loc: 1, size: 3, data: box.normals }
  ]);
  const starVAO = G.makeVAO([
    { loc: 0, size: 3, data: stars.pos },
    { loc: 2, size: 1, data: stars.size },
    { loc: 3, size: 3, data: stars.col }
  ]);
  const sparkAVAO = G.makeVAO([
    { loc: 0, size: 3, data: sparkA.pos },
    { loc: 2, size: 1, data: sparkA.size },
    { loc: 3, size: 3, data: sparkA.col }
  ]);
  const sparkBVAO = G.makeVAO([
    { loc: 0, size: 3, data: sparkB.pos },
    { loc: 2, size: 1, data: sparkB.size },
    { loc: 3, size: 3, data: sparkB.col }
  ]);
  gl.flush();

  const barProg = G.createProgram('bar', VS_BAR, FS_BAR, ['aPos', 'aNormal']);

  /* persistent DYNAMIC_DRAW buffer for the tube (re-uploaded per frame);
     the VAO references it directly via makeVAO's `buffer` option */
  const tubePosBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tubePosBuf);
  gl.bufferData(gl.ARRAY_BUFFER, tubePos.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const tubeVAO = G.makeVAO([
    { loc: 0, size: 3, buffer: tubePosBuf },
    { loc: 1, size: 3, data: tubeNrm }
  ]);

  const uploadTube = () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, tubePosBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, tubePos);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };

  /* ═════════════════════════════════════════════════════════════
     8 · MOTION STATE
  ═══════════════════════════════════════════════════════════════ */
  const motion = {
    spinY: 0.6,
    spinYVel: 0.16,
    spinX: -0.08,
    floatY: 0,
    ringRot: 0,
    cageRot: 0,
    pulse: 1,
    tubeFlow: 0,
    starRot: 0
  };

  const BAR_R = 3.15;
  const BAR_MAX_H = 2.3;
  const BAR_W = 0.17;

  /* scratch matrices/quats — no allocation in the hot path */
  const _m = new Mat4();
  const _m2 = new Quat();   // scratch quat for the X-axis tilt in modelTRS
  const _q = new Quat();
  const _v = new Vec3();
  const _s = new Vec3(1, 1, 1);
  const Y_AXIS = new Vec3(0, 1, 0);
  const X_AXIS = new Vec3(1, 0, 0);
  const ID_M = new Mat4();

  /* all args numeric on purpose — the scratch objects are shared,
     so passing them as parameters would alias */
  function modelTRS(out, rx, ry, px, py, pz, sx, sy, sz){
    _q.fromAxisAngle(Y_AXIS, ry);
    if(rx){
      _m2.fromAxisAngle(X_AXIS, rx);
      _q.multiply(_m2);
    }
    _v.set(px, py, pz);
    _s.set(sx, sy, sz);
    out.fromRotationTranslationScale(_q, _v, _s);
    return out;
  }

  function stepMotion(dt, time){
    motion.spinYVel += ((0.14 + st.energy * 0.55) - motion.spinYVel) * Math.min(1, dt * 2.0);
    motion.spinY += dt * motion.spinYVel;
    motion.ringRot += dt * (0.10 + st.energy * 0.30);
    motion.cageRot -= dt * (0.20 + st.bass * 0.9);
    motion.starRot += dt * 0.004;
    motion.tubeFlow += dt;
    motion.floatY = Math.sin(time * 0.8) * 0.07;
    const target = 1 + st.bass * 0.15;
    motion.pulse += (target - motion.pulse) * Math.min(1, dt * 9.0);
  }

  G.onFrame.push(function(dt, time){
    stepMotion(dt, time);
    updateTubePositions();
    uploadTube();
  });

  /* input hooks (p08 will emit these) */
  Aqua.bus.on('ui:spin', v => {
    motion.spinYVel = AMath.clamp(motion.spinYVel + (v || 0), -4, 4);
  });
  Aqua.bus.on('ui:zoom', v => {
    const cam = G.camera;
    cam.dRadius = AMath.clamp(cam.dRadius + (v || 0), 4.2, 16);
  });

  /* ═════════════════════════════════════════════════════════════
     9 · DRAW CALLS (registered in painter's order)
  ═══════════════════════════════════════════════════════════════ */

  /* ── stars: far, additive, no depth write ──────────────────── */
  G.addObject({
    name: 'stars',
    vao: starVAO,
    count: stars.count,
    mode: gl.POINTS,
    draw(ctx){
      const P = ctx.programs.sprite;
      P.use();
      gl.uniformMatrix4fv(P.uni.uVP, false, ctx.camera.vp.e);
      _q.fromAxisAngle(Y_AXIS, motion.starRot);
      _m.fromRotationTranslationScale(_q, _v.set(0, 0, 0), _s);
      gl.uniformMatrix4fv(P.uni.uModel, false, _m.e);
      gl.uniform1f(P.uni.uPixScale, ctx.state.pixScale || 1);
      ctx.setCommonUniforms('sprite');
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(starVAO);
      gl.drawArrays(gl.POINTS, 0, stars.count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
  });

  /* ── spark clouds: two counter-rotating shells ─────────────── */
  function sparkDraw(vao, count, dir, seed){
    return {
      name: 'sparks' + seed,
      vao: vao,
      count: count,
      mode: gl.POINTS,
      draw(ctx){
        const P = ctx.programs.sprite;
        P.use();
        gl.uniformMatrix4fv(P.uni.uVP, false, ctx.camera.vp.e);
        _q.fromAxisAngle(Y_AXIS, dir * ctx.time * (0.16 + st.energy * 0.1));
        const sp = 1 + st.bass * 0.05;
        _v.set(0, 0.55, 0);
        _s.set(sp, sp, sp);
        _m.fromRotationTranslationScale(_q, _v, _s);
        gl.uniformMatrix4fv(P.uni.uModel, false, _m.e);
        _s.set(1, 1, 1);
        gl.uniform1f(P.uni.uPixScale, ctx.state.pixScale || 1);
        ctx.setCommonUniforms('sprite');
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
    };
  }
  G.addObject(sparkDraw(sparkAVAO, sparkA.count, 1, 'A'));
  G.addObject(sparkDraw(sparkBVAO, sparkB.count, -1, 'B'));

  /* ── spectrum bars: 20 axis-aligned neon columns on a ring ── */
  G.addObject({
    name: 'bars',
    vao: boxVAO,
    count: 36,
    mode: gl.TRIANGLES,
    draw(ctx){
      const P = barProg;
      P.use();
      gl.uniformMatrix4fv(P.uni.uVP, false, ctx.camera.vp.e);
      gl.uniform1f(P.uni.uBarW, BAR_W);
      gl.uniform3fv(P.uni.uCamPos, [ctx.camera.pos.x, ctx.camera.pos.y, ctx.camera.pos.z]);
      ctx.setCommonUniforms('bar');
      gl.depthMask(true);
      gl.bindVertexArray(boxVAO);
      const bands = st.bands;
      for(let i = 0; i < BAR_COUNT; i++){
        const a = (i / BAR_COUNT) * TWO_PI + motion.ringRot;
        const cx = BAR_R * Math.cos(a);
        const cz = BAR_R * Math.sin(a);
        const h = 0.05 + Math.max(0.02, bands[i]) * BAR_MAX_H;
        if(P.uni.uInst) gl.uniform4f(P.uni.uInst, cx, 0, cz, h);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      }
      gl.bindVertexArray(null);
    }
  });

  /* ── waveform tube ─────────────────────────────────────────── */
  G.addObject({
    name: 'tube',
    vao: tubeVAO,
    count: tubeVerts,
    mode: gl.TRIANGLES,
    draw(ctx){
      const P = ctx.programs.solid;
      P.use();
      gl.uniformMatrix4fv(P.uni.uVP, false, ctx.camera.vp.e);
      gl.uniformMatrix4fv(P.uni.uModel, false, ID_M.e);
      gl.uniform3fv(P.uni.uCamPos, [ctx.camera.pos.x, ctx.camera.pos.y, ctx.camera.pos.z]);
      if(P.uni.uEmissive) gl.uniform1f(P.uni.uEmissive, 0.35 + st.energy * 0.5);
      ctx.setCommonUniforms('solid');
      gl.bindVertexArray(tubeVAO);
      gl.drawArrays(gl.TRIANGLES, 0, tubeVerts);
      gl.bindVertexArray(null);
    }
  });

  /* ── torus knot core ───────────────────────────────────────── */
  G.addObject({
    name: 'knot',
    vao: knotVAO,
    count: knot.count,
    mode: gl.TRIANGLES,
    draw(ctx){
      const P = ctx.programs.solid;
      P.use();
      gl.uniformMatrix4fv(P.uni.uVP, false, ctx.camera.vp.e);
      const kp = motion.pulse * 1.05;
      modelTRS(_m, motion.spinX, motion.spinY, 0, 0.55 + motion.floatY, 0, kp, kp, kp);
      gl.uniformMatrix4fv(P.uni.uModel, false, _m.e);
      gl.uniform3fv(P.uni.uCamPos, [ctx.camera.pos.x, ctx.camera.pos.y, ctx.camera.pos.z]);
      if(P.uni.uEmissive) gl.uniform1f(P.uni.uEmissive, st.playing ? 0.55 : 0.25);
      ctx.setCommonUniforms('solid');
      gl.bindVertexArray(knotVAO);
      gl.drawArrays(gl.TRIANGLES, 0, knot.count);
      gl.bindVertexArray(null);
    }
  });

  /* ── ico cage (neon wireframe) ─────────────────────────────── */
  G.addObject({
    name: 'cage',
    vao: edgeVAO,
    count: edgeBuf.length / 3,
    mode: gl.LINES,
    draw(ctx){
      const P = ctx.programs.line;
      P.use();
      gl.uniformMatrix4fv(P.uni.uVP, false, ctx.camera.vp.e);
      _q.fromAxisAngle(Y_AXIS, motion.cageRot);
      const cs = 1 + st.bass * 0.30;
      _v.set(0, 0.55 + motion.floatY, 0);
      _s.set(cs, cs, cs);
      _m.fromRotationTranslationScale(_q, _v, _s);
      _s.set(1, 1, 1);
      gl.uniformMatrix4fv(P.uni.uModel, false, _m.e);
      gl.uniform3fv(P.uni.uColor, st.colors.c2);
      ctx.setCommonUniforms('line');
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(edgeVAO);
      gl.drawArrays(gl.LINES, 0, edgeBuf.length / 3);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
  });

  /* ═════════════════════════════════════════════════════════════
     10 · EXPOSE
  ═══════════════════════════════════════════════════════════════ */
  Aqua.geo = {
    motion: motion,
    bands: st.bands,
    wave: st.wave,
    knot: knot,
    barCount: BAR_COUNT,
    waveSteps: WAVE_STEPS,
    /* feed a synthesized band level (used by demo + UI presets) */
    setBand(i, v){ st.bands[i] = AMath.clamp01(v); },
    setWave(i, v){ st.wave[i] = AMath.clamp(v, -1, 1); }
  };

  console.info('[Aqua Geo] ' + knot.count + ' knot verts, ' +
    cage.count + ' cage verts, ' + BAR_COUNT + ' bars, ' +
    stars.count + ' stars, ' + (sparkA.count + sparkB.count) + ' sparks');
});

/* ═══════════════ PART: p06_play.js ═══════════════ */

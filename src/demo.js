/* ═══════════════════════════════════════════════════════════════════
   p09 · DEMO — procedural demo-signal generator
   ───────────────────────────────────────────────────────────────────
   When the user hits play with an empty library (or the DEMO button,
   or G on the keyboard), the system must still do something impressive
   instead of beeping an error.  This part synthesises a small "demo
   set" of original electronic tracks entirely in JavaScript — no
   assets — encodes them to WAV, drops them into the queue and plays.

     §1  Local helpers (note math, scales, clamps, rng)
     §2  DSP primitives (oscillators, ADSR, one-pole LP, noise)
     §3  Instruments (kick, snare, hat, clap, bass, lead, pad, arp,
         shimmer, sub)
     §4  Sequencer data (keys, chord progressions, per-style patterns)
     §5  Track renderers (neon / pulse / deep / ambient / glitch)
     §6  WAV encoder (16-bit PCM stereo)
     §7  Set builder + generate(autoplay) + internal wiring

   Everything renders into a stereo Float32 sample buffer, then to a
   16-bit WAV blob.  The resulting record carries a `_demo` marker so
   repeated generation replaces the previous set rather than stacking.
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('demo', function initDemo(){
  'use strict';

  const A    = Aqua;
  const Q    = A.play;
  const bus  = A.bus;
  const M    = A.math.AMath;
  const cl   = (v, lo, hi) => (M && M.clamp) ? M.clamp(v, lo, hi) : Math.max(lo, Math.min(hi, v));
  const TAU  = Math.PI * 2;
  const SR   = 44100;

  /* a tiny deterministic RNG (mulberry32) so a track is reproducible
     for a given seed but different across tracks */
  function makeRng(seed){
    let a = (seed >>> 0) || 1;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ───────────────────────────────────────────────────────────────
     §1 · NOTE MATH + SCALES
  ─────────────────────────────────────────────────────────────── */

  /* MIDI note number → frequency (Hz) */
  function mtof(m){ return 440 * Math.pow(2, (m - 69) / 12); }

  /* named scale intervals in semitones (from the root) */
  const SCALES = {
    minor:       [0, 2, 3, 5, 7, 8, 10],
    naturalMinor:[0, 2, 3, 5, 7, 8, 10],
    major:       [0, 2, 4, 5, 7, 9, 11],
    dorian:      [0, 2, 3, 5, 7, 9, 10],
    phrygian:    [0, 1, 3, 5, 7, 8, 10],
    harmonicMinor:[0, 2, 3, 5, 7, 8, 11],
    pentMinor:   [0, 3, 5, 7, 10],
    pentMajor:   [0, 2, 4, 7, 9],
    lydian:      [0, 2, 4, 6, 7, 9, 11],
    wholeTone:   [0, 2, 4, 6, 8, 10]
  };

  /* build a full diatonic note set for a root + scale name, spanning
     `octaves` octaves, as an array of MIDI numbers ascending */
  function scaleNotes(rootMidi, scaleName, octaves){
    const scale = SCALES[scaleName] || SCALES.naturalMinor;
    const out = [];
    for(let o = 0; o < octaves; o++){
      for(let i = 0; i < scale.length; i++){
        out.push(rootMidi + scale[i] + o * 12);
      }
    }
    return out;
  }

  /* ───────────────────────────────────────────────────────────────
     §2 · DSP PRIMITIVES
  ─────────────────────────────────────────────────────────────────── */

  /* one-pole lowpass, in-place on an array segment */
  function onePoleLP(state, x, k){
    state.v += (x - state.v) * k;
    return state.v;
  }

  /* linear ADSR.  Returns the gain at `t` seconds after the note
     started.  a,d,s,r are in seconds; sustain is 0..1. */
  function adsr(t, a, d, s, r, total){
    if(t < 0) return 0;
    if(t < a) return t / a;
    if(t < a + d) return 1 - (t - a) / d * (1 - s);
    const relEnd = total - r;
    if(t < relEnd) return s;
    if(t < total) return s * (1 - (t - relEnd) / r);
    return 0;
  }

  /* a band-limited-ish saw via additive harmonics (cheap + good) */
  function sawPhase(ph){
    /* Fourier saw, 8 partials, normalised */
    let s = 0;
    for(let n = 1; n <= 8; n++){
      s += (Math.sin(ph * TAU * n) / n) * ((n % 2) ? 1 : -1) * ((1 - n / 16));
    }
    return s * 0.6;
  }
  function squarePhase(ph){
    return (ph % 1 < 0.5) ? 1 : -1;
  }
  function pulsePhase(ph, duty){
    return (ph % 1 < duty) ? 1 : -1;
  }

  /* white noise (deterministic from a rng) */
  function noise(rng){ return rng() * 2 - 1; }

  /* ───────────────────────────────────────────────────────────────
     §3 · INSTRUMENTS
     Each writes samples into `buf` starting at index `start`, over
     `n` samples, mixing (+=) so voices can layer.  `buf` is a
     Float32Array of length n*2 (interleaved L/R).
  ─────────────────────────────────────────────────────────────────── */

  /* KICK — a fast pitch-swept sine with a click transient.  */
  function voiceKick(buf, start, n, rng, opts){
    opts = opts || {};
    const vol  = opts.vol  != null ? opts.vol  : 0.9;
    const f0   = opts.f0   != null ? opts.f0   : 130;
    const f1   = opts.f1   != null ? opts.f1   : 42;
    const dur  = opts.dur  != null ? opts.dur  : 0.32;
    const samples = Math.min(n, Math.floor(dur * SR));
    let phase = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      const k = i / samples;
      const f = f0 + (f1 - f0) * (1 - Math.exp(-t * 22));
      phase += f / SR;
      const env = Math.exp(-t * 11) * (1 - Math.exp(-t * 90));
      const click = (i < 4) ? (0.5 - i * 0.12) : 0;
      const s = (Math.sin(phase * TAU) * env + click) * vol;
      buf[start + i*2]     += s;
      buf[start + i*2 + 1] += s;
    }
  }

  /* SUB — a sine that hugs the kick an octave down, for weight. */
  function voiceSub(buf, start, n, rng, opts){
    opts = opts || {};
    const vol  = opts.vol != null ? opts.vol : 0.5;
    const f    = opts.f   != null ? opts.f   : 55;
    const dur  = opts.dur != null ? opts.dur : 0.30;
    const samples = Math.min(n, Math.floor(dur * SR));
    let phase = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      phase += f / SR;
      const env = Math.exp(-t * 6) * (1 - Math.exp(-t * 200));
      const s = Math.sin(phase * TAU) * env * vol;
      buf[start + i*2]     += s;
      buf[start + i*2 + 1] += s;
    }
  }

  /* SNARE — a noise burst through a highpass-ish envelope + a tone. */
  function voiceSnare(buf, start, n, rng, opts){
    opts = opts || {};
    const vol  = opts.vol != null ? opts.vol : 0.5;
    const dur  = opts.dur != null ? opts.dur : 0.18;
    const samples = Math.min(n, Math.floor(dur * SR));
    let body = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      const env = Math.exp(-t * 22) * (1 - Math.exp(-t * 400));
      const nz = noise(rng);
      body = onePoleLP({ v: body }, nz, 0.35);
      const tone = Math.sin(TAU * 190 * t) * Math.exp(-t * 40);
      const s = (nz * 0.6 + body * 0.5 + tone * 0.5) * env * vol;
      buf[start + i*2]     += s;
      buf[start + i*2 + 1] += s;
    }
  }

  /* HAT — short metallic noise (closed) or a longer tail (open). */
  function voiceHat(buf, start, n, rng, opts){
    opts = opts || {};
    const vol   = opts.vol   != null ? opts.vol   : 0.32;
    const open  = !!opts.open;
    const dur   = opts.dur   != null ? opts.dur   : (open ? 0.24 : 0.05);
    const samples = Math.min(n, Math.floor(dur * SR));
    let hp = 0;
    let prev = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      const nz = noise(rng);
      hp = nz - prev;      // crude highpass (first difference)
      prev = nz;
      const env = Math.exp(-t * (open ? 9 : 60));
      const s = hp * env * vol;
      buf[start + i*2]     += s * 0.9;
      buf[start + i*2 + 1] += s * 1.0;   // hats slightly right
    }
  }

  /* CLAP — three short noise bursts (the "clap" double/triple). */
  function voiceClap(buf, start, n, rng, opts){
    opts = opts || {};
    const vol = opts.vol != null ? opts.vol : 0.4;
    const bursts = [0, 0.012, 0.024];
    for(let b = 0; b < bursts.length; b++){
      const dur = 0.09;
      const samples = Math.floor(dur * SR);
      const off = Math.floor(bursts[b] * SR);
      let hp = 0, prev = 0;
      for(let i = 0; i < samples; i++){
        const idx = start + off + i;
        if(idx + 1 >= n) break;
        const t = i / SR;
        const nz = noise(rng);
        hp = nz - prev; prev = nz;
        const env = Math.exp(-t * 26);
        const s = hp * env * vol * (1 - b * 0.25);
        buf[idx*2]     += s;
        buf[idx*2 + 1] += s;
      }
    }
  }

  /* BASS — a filtered saw through a one-pole LP, tracking the root. */
  function voiceBass(buf, start, n, rng, opts){
    opts = opts || {};
    const midi = opts.midi != null ? opts.midi : 36;
    const vol  = opts.vol  != null ? opts.vol  : 0.42;
    const f    = mtof(midi);
    const dur  = opts.dur  != null ? opts.dur  : 0.22;
    const cut  = opts.cut  != null ? opts.cut  : 700;
    const samples = Math.min(n, Math.floor(dur * SR));
    let phase = 0;
    let lp  = { v: 0 };
    let prev = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      phase += f / SR;
      const saw = sawPhase(phase);
      let x = saw;
      x = onePoleLP(lp, x, cl((cut / f) * 0.12, 0.02, 0.9));
      const sub = Math.sin(TAU * f / 2 * t) * 0.5;
      const env = cl(adsr(t, 0.005, 0.06, 0.7, 0.08, dur), 0, 1);
      const s = (x * 0.8 + sub) * env * vol;
      buf[start + i*2]     += s;
      buf[start + i*2 + 1] += s;
    }
  }

  /* LEAD — a mono synth (pulsed saw or square) with a bit of stereo
     width, filter movement, and optional echo.  */
  function voiceLead(buf, start, n, rng, opts){
    opts = opts || {};
    const midi  = opts.midi  != null ? opts.midi  : 60;
    const vol   = opts.vol   != null ? opts.vol   : 0.3;
    const f     = mtof(midi);
    const dur   = opts.dur   != null ? opts.dur   : 0.3;
    const type  = opts.type  || 'saw';
    const cut   = opts.cut   != null ? opts.cut   : 2400;
    const w     = opts.width != null ? opts.width : 0.25;   // stereo
    const echo  = opts.echo  != null ? opts.echo  : 0.22;
    const samples = Math.min(n, Math.floor(dur * SR));
    let phase = 0;
    let lp = { v: 0 };
    const delayL = new Float32Array(64);
    const delayR = new Float32Array(64);
    let di = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      phase += f / SR;
      let raw;
      if(type === 'square')      raw = squarePhase(phase);
      else if(type === 'pulse')  raw = pulsePhase(phase, 0.4);
      else                       raw = sawPhase(phase);
      // a slow filter wobble for movement
      const wob = 0.7 + 0.3 * Math.sin(TAU * 3 * t);
      let x = onePoleLP(lp, raw, cl((cut * wob / f) * 0.06, 0.03, 0.9));
      const env = cl(adsr(t, 0.01, 0.08, 0.8, 0.1, dur), 0, 1);
      const dry = x * env * vol;
      // delayed feedback-ish (short comb for space)
      delayL[di] = dry * 0.5; delayR[di] = dry * 0.5;
      const fbL = delayL[(di + 24) & 63] * echo;
      const fbR = delayR[(di + 32) & 63] * echo;
      const l = dry + fbR;
      const r = dry + fbL;
      buf[start + i*2]     += l;
      buf[start + i*2 + 1] += r;
      di = (di + 1) & 63;
    }
  }

  /* PAD — a lush detuned stack of partials, slow attack, stereo wide. */
  function voicePad(buf, start, n, rng, opts){
    opts = opts || {};
    const midis = opts.midis || [60, 63, 67];
    const vol   = opts.vol   != null ? opts.vol   : 0.16;
    const dur   = opts.dur   != null ? opts.dur   : 2.0;
    const cut   = opts.cut   != null ? opts.cut   : 1600;
    const width = opts.width != null ? opts.width : 0.5;
    const samples = Math.min(n, Math.floor(dur * SR));
    const freqs = midis.map(mtof);
    const phase = new Array(freqs.length).fill(0);
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      const env = cl(adsr(t, 0.4, 0.3, 0.8, Math.max(0.4, dur * 0.4), dur), 0, 1);
      let l = 0, r = 0;
      for(let v = 0; v < freqs.length; v++){
        const f = freqs[v];
        phase[v] += f / SR;
        const detune = 1 + (rng() - 0.5) * 0.0004;
        const tone = Math.sin(phase[v] * TAU) * 0.6
                   + Math.sin(phase[v] * 2 * TAU) * 0.18
                   + Math.sin(phase[v] * 3 * TAU) * 0.06;
        const pan = 0.5 + 0.5 * Math.sin(TAU * 0.1 * t + v);
        l += tone * (1 - pan * width) * detune;
        r += tone * (1 - (1 - pan) * width) * detune;
      }
      const g = env * vol;
      buf[start + i*2]     += l * g;
      buf[start + i*2 + 1] += r * g;
    }
  }

  /* ARP — a fast arpeggiated square/pulse over a chord. */
  function voiceArp(buf, start, n, rng, opts){
    opts = opts || {};
    const midis = opts.midis || [60, 64, 67, 72];
    const vol   = opts.vol   != null ? opts.vol   : 0.2;
    const dur   = opts.dur   != null ? opts.dur   : 0.1;
    const rate  = opts.rate  || 8;       // notes per second
    const cut   = opts.cut   != null ? opts.cut   : 3000;
    const total = Math.floor(dur * rate);
    const samples = Math.min(n, Math.floor(dur * SR));
    const perNote = Math.floor(SR / rate);
    let noteIndex = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      if(Math.floor(t * rate) !== noteIndex){
        noteIndex = Math.floor(t * rate);
      }
      const mi = midis[noteIndex % midis.length];
      const f = mtof(mi);
      const nt = (i % perNote) / SR;
      const env = Math.exp(-nt * 8);
      const ph = t * f;
      const tone = pulsePhase(ph, 0.35) * 0.7 + Math.sin(ph * TAU) * 0.3;
      const s = tone * env * vol;
      buf[start + i*2]     += s;
      buf[start + i*2 + 1] += s;
    }
  }

  /* SHIMMER — a high, airy sine with slow attack (sparkle layer). */
  function voiceShimmer(buf, start, n, rng, opts){
    opts = opts || {};
    const midi = opts.midi != null ? opts.midi : 88;
    const vol  = opts.vol  != null ? opts.vol  : 0.1;
    const f    = mtof(midi) * 2;
    const dur  = opts.dur  != null ? opts.dur  : 1.6;
    const samples = Math.min(n, Math.floor(dur * SR));
    let phase = 0;
    for(let i = 0; i < samples; i++){
      const t = i / SR;
      phase += f / SR;
      const env = cl(adsr(t, 0.3, 0.2, 0.6, 0.5, dur), 0, 1);
      const vib = 1 + 0.004 * Math.sin(TAU * 5 * t);
      const s = Math.sin(phase * TAU * (vib)) * env * vol;
      buf[start + i*2]     += s * 0.8;
      buf[start + i*2 + 1] += s;
    }
  }

  /* ───────────────────────────────────────────────────────────────
     §4 · SEQUENCER DATA
  ─────────────────────────────────────────────────────────────────── */

  /* A 16-step pattern is an array of 0/1 (or a value for velocity).
     We define patterns for the rhythmic voices. */
  const STEP = 16;   // 16 steps = 1 bar of 16th notes

  function seq(arr){
    // pad / normalise to 16 steps
    const out = [];
    for(let i = 0; i < STEP; i++){
      out.push(arr[i] || 0);
    }
    return out;
  }

  /* common chord progressions as arrays of scale degrees (root
     position).  degree 0 = tonic.  We'll map them to triads. */
  const PROGRESSIONS = {
    i_vii_vi_iv:  [0, 6, 5, 4],   // Am F E D  (i-vii-vi-IV in minor)
    i_vi_iii_vii: [0, 5, 2, 6],   // i-vi-iii-vii
    i_iii_vi_vii: [0, 2, 5, 6],
    i_iv_v_vii:   [0, 3, 4, 6],
    i_v_iii_vi:   [0, 4, 2, 5],
    i_ii_v_vii:   [0, 1, 4, 6],
    i_v_ii_vii:   [0, 4, 1, 6],
    i_iv_i_vii:   [0, 3, 0, 6]
  };

  /* build a triad (root, third, fifth) in MIDI for a given root +
     degree within the scale.  Returns [m1, m2, m3]. */
  function triad(rootMidi, degree, scaleName){
    const scale = SCALES[scaleName] || SCALES.naturalMinor;
    const root = rootMidi + degree * 2;   // skip a 2nd, go to 3rd-ish
    const base = rootMidi + scale[degree % scale.length] +
                 Math.floor(degree / scale.length) * 12;
    const third = rootMidi + scale[(degree + 2) % scale.length] +
                 Math.floor((degree + 2) / scale.length) * 12;
    const fifth = rootMidi + scale[(degree + 4) % scale.length] +
                 Math.floor((degree + 4) / scale.length) * 12;
    return [base, third, fifth];
  }

  /* ───────────────────────────────────────────────────────────────
     §5 · TRACK RENDERERS
     Each takes (spec) and returns { samples: Float32Array(interleaved),
     seconds: number }.  spec carries seed/style-specific knobs.
  ─────────────────────────────────────────────────────────────────── */

  function renderFrame(bars, bpm, step){
    // step = 16th note
    const secPer16 = 60 / bpm / 4;
    const totalSec = bars * STEP * secPer16;
    return { secPer16: secPer16, totalSec: totalSec };
  }

  function newBuffer(totalSec){
    const n = Math.ceil(totalSec * SR) + SR;   // +1s tail for releases
    return { buf: new Float32Array(n * 2), n: n, totalSec: totalSec };
  }

  function place(buf, n, bar, stepIdx){
    // absolute sample index for bar (0-based) & 16th step
    const secPer16 = buf.secPer16;
    return Math.floor((bar * STEP + stepIdx) * secPer16 * SR);
  }

  /* NEON — bright, fast, synthwave: four-on-the-floor kick, off hats,
     driving bass, plucky lead, arps, pads on chord changes. */
  function renderNeon(spec){
    const rng = makeRng(spec.seed);
    const rootMidi = spec.root;
    const bars = spec.bars;
    const bpm  = spec.bpm;
    const scaleName = spec.scale;
    const frame = renderFrame(bars, bpm, 4);
    const B = newBuffer(frame.totalSec + 1.2);
    const scale = scaleNotes(rootMidi, scaleName, 3);
    const prog = PROGRESSIONS[spec.progression] || PROGRESSIONS.i_vii_vi_iv;

    const kickP  = seq([1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]);
    const clapP  = seq([0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0]);
    const hatP   = seq([1,0,1,0, 1,0,1,0, 1,0,1,1, 1,0,1,0]);
    const bassP  = seq([1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,1]);
    const leadP  = seq([0,0,1,0, 0,1,0,0, 0,0,1,0, 0,1,0,1]);

    for(let bar = 0; bar < bars; bar++){
      const degree = prog[bar % prog.length];
      const chord  = triad(rootMidi, degree, scaleName);
      // pad over each bar
      const padIdx = place(B, B.n, bar, 0);
      voicePad(B.buf, padIdx, B.n - padIdx, rng, {
        midis: chord, vol: 0.14, dur: frame.secPer16 * STEP, cut: 1500
      });
      // bass root
      const bassRoot = rootMidi - 12 + scale[degree % scale.length];
      for(let s = 0; s < STEP; s++){
        const idx = place(B, B.n, bar, s);
        if(kickP[s]){
          voiceKick(B.buf, idx, B.n - idx, rng, { vol: 0.95, f0: 135, f1: 44, dur: 0.3 });
          voiceSub(B.buf, idx, B.n - idx, rng, { vol: 0.4, f: mtof(bassRoot - 12), dur: 0.28 });
        }
        if(clapP[s]) voiceClap(B.buf, idx, B.n - idx, rng, { vol: 0.4 });
        if(hatP[s])  voiceHat(B.buf, idx, B.n - idx, rng, { vol: 0.3, open: (s === 14) });
        if(bassP[s]) voiceBass(B.buf, idx, B.n - idx, rng, {
          midi: bassRoot, vol: 0.4, dur: frame.secPer16 * 2.2, cut: 750
        });
        if(leadP[s]){
          const note = scale[(bar * 2 + s) % scale.length] + 12;
          voiceLead(B.buf, idx, B.n - idx, rng, {
            midi: note, vol: 0.26, type: 'saw', dur: frame.secPer16 * 1.8,
            cut: 2600, width: 0.3, echo: 0.25
          });
        }
      }
    }
    return B;
  }

  /* PULSE — driving 128bpm techno: rolling hats, punchy kicks, a
     repetitive acid bass, minimal melody, lots of sub. */
  function renderPulse(spec){
    const rng = makeRng(spec.seed);
    const rootMidi = spec.root;
    const bars = spec.bars;
    const bpm  = spec.bpm;
    const scaleName = spec.scale;
    const frame = renderFrame(bars, bpm, 4);
    const B = newBuffer(frame.totalSec + 1.2);
    const scale = scaleNotes(rootMidi, scaleName, 3);
    const prog = PROGRESSIONS[spec.progression] || PROGRESSIONS.i_iv_v_vii;

    const kickP = seq([1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]);
    const snareP= seq([0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0]);
    const hatP  = seq([1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1]);
    const openP = seq([0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]);
    const bassP = seq([1,1,0,1, 1,0,1,1, 1,1,0,1, 1,0,1,1]);

    for(let bar = 0; bar < bars; bar++){
      const degree = prog[bar % prog.length];
      const bassRoot = rootMidi - 12 + scale[degree % scale.length];
      for(let s = 0; s < STEP; s++){
        const idx = place(B, B.n, bar, s);
        if(kickP[s]){
          voiceKick(B.buf, idx, B.n - idx, rng, { vol: 0.98, f0: 150, f1: 48, dur: 0.26 });
          voiceSub(B.buf, idx, B.n - idx, rng, { vol: 0.5, f: mtof(bassRoot - 12), dur: 0.24 });
        }
        if(snareP[s]) voiceSnare(B.buf, idx, B.n - idx, rng, { vol: 0.42, dur: 0.16 });
        if(hatP[s])  voiceHat(B.buf, idx, B.n - idx, rng, { vol: 0.26 });
        if(openP[s]) voiceHat(B.buf, idx, B.n - idx, rng, { vol: 0.3, open: true, dur: 0.3 });
        if(bassP[s]){
          const n2 = scale[(bar * 3 + s) % scale.length];
          voiceBass(B.buf, idx, B.n - idx, rng, {
            midi: bassRoot + (n2 % 2 ? 0 : 0), vol: 0.36, dur: frame.secPer16 * 1.6, cut: 900
          });
        }
      }
      // a sparse lead every other bar
      if(bar % 2 === 1){
        const chord = triad(rootMidi, degree, scaleName);
        const idx = place(B, B.n, bar, 4);
        voiceLead(B.buf, idx, B.n - idx, rng, {
          midi: chord[2] + 12, vol: 0.22, type: 'square', dur: frame.secPer16 * 8,
          cut: 2000, width: 0.35, echo: 0.3
        });
        const aIdx = place(B, B.n, bar, 0);
        voiceArp(B.buf, aIdx, B.n - aIdx, rng, {
          midis: chord.map(x => x + 12), vol: 0.18, dur: frame.secPer16 * STEP,
          rate: 16, cut: 3200
        });
      }
    }
    return B;
  }

  /* DEEP — deep house: swung-ish kick, soulful bass, warm pads, a
     gentle vocal-ish lead, claps on 2 & 4, lots of air. */
  function renderDeep(spec){
    const rng = makeRng(spec.seed);
    const rootMidi = spec.root;
    const bars = spec.bars;
    const bpm  = spec.bpm;
    const scaleName = spec.scale;
    const frame = renderFrame(bars, bpm, 4);
    const B = newBuffer(frame.totalSec + 1.2);
    const scale = scaleNotes(rootMidi, scaleName, 3);
    const prog = PROGRESSIONS[spec.progression] || PROGRESSIONS.i_iii_vi_vii;

    const kickP = seq([1,0,0,0, 0,0,1,0, 0,0,1,0, 1,0,0,0]);
    const clapP = seq([0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0]);
    const hatP  = seq([0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,1]);
    const bassP = seq([1,0,0,0, 0,0,1,0, 0,0,0,0, 0,1,0,0]);
    const leadP = seq([0,0,0,1, 0,0,0,0, 0,0,1,0, 0,0,0,0]);

    for(let bar = 0; bar < bars; bar++){
      const degree = prog[bar % prog.length];
      const chord  = triad(rootMidi, degree, scaleName);
      const padIdx = place(B, B.n, bar, 0);
      voicePad(B.buf, padIdx, B.n - padIdx, rng, {
        midis: chord, vol: 0.16, dur: frame.secPer16 * STEP, cut: 1300, width: 0.6
      });
      const bassRoot = rootMidi - 12 + scale[degree % scale.length];
      for(let s = 0; s < STEP; s++){
        const idx = place(B, B.n, bar, s);
        if(kickP[s]) voiceKick(B.buf, idx, B.n - idx, rng, { vol: 0.85, f0: 120, f1: 40, dur: 0.34 });
        if(clapP[s]) voiceClap(B.buf, idx, B.n - idx, rng, { vol: 0.35 });
        if(hatP[s])  voiceHat(B.buf, idx, B.n - idx, rng, { vol: 0.24, open: (s === 12) });
        if(bassP[s]) voiceBass(B.buf, idx, B.n - idx, rng, {
          midi: bassRoot, vol: 0.4, dur: frame.secPer16 * 3, cut: 600
        });
        if(leadP[s]){
          const note = scale[(bar + s * 3) % scale.length] + 12;
          voiceLead(B.buf, idx, B.n - idx, rng, {
            midi: note, vol: 0.24, type: 'pulse', dur: frame.secPer16 * 3,
            cut: 1800, width: 0.4, echo: 0.35
          });
          voiceShimmer(B.buf, idx, B.n - idx, rng, { midi: note + 12, vol: 0.08, dur: 1.4 });
        }
      }
    }
    return B;
  }

  /* AMBIENT — no drums: evolving pads, slow melodies, shimmer, a
     sparse sub pulse.  The gentlest of the set. */
  function renderAmbient(spec){
    const rng = makeRng(spec.seed);
    const rootMidi = spec.root;
    const bars = spec.bars;
    const bpm  = spec.bpm;
    const scaleName = spec.scale;
    const frame = renderFrame(bars, bpm, 4);
    const B = newBuffer(frame.totalSec + 2.0);
    const scale = scaleNotes(rootMidi, scaleName, 3);
    const prog = PROGRESSIONS[spec.progression] || PROGRESSIONS.i_iv_v_vii;

    const subP = seq([1,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]);
    const leadP= seq([0,0,0,1, 0,0,1,0, 0,0,0,0, 1,0,0,0]);

    for(let bar = 0; bar < bars; bar++){
      const degree = prog[bar % prog.length];
      const chord  = triad(rootMidi, degree, scaleName);
      const padIdx = place(B, B.n, bar, 0);
      voicePad(B.buf, padIdx, B.n - padIdx, rng, {
        midis: chord, vol: 0.2, dur: frame.secPer16 * STEP * 1.1, cut: 1100, width: 0.7
      });
      const bassRoot = rootMidi - 12 + scale[degree % scale.length];
      for(let s = 0; s < STEP; s++){
        const idx = place(B, B.n, bar, s);
        if(subP[s]) voiceSub(B.buf, idx, B.n - idx, rng, { vol: 0.4, f: mtof(bassRoot), dur: 1.2 });
        if(leadP[s]){
          const note = scale[(bar * 2 + s) % scale.length] + 12;
          voiceLead(B.buf, idx, B.n - idx, rng, {
            midi: note, vol: 0.2, type: 'saw', dur: frame.secPer16 * 4,
            cut: 1600, width: 0.5, echo: 0.45
          });
          voiceShimmer(B.buf, idx, B.n - idx, rng, { midi: note + 24, vol: 0.07, dur: 1.8 });
        }
      }
    }
    return B;
  }

  /* GLITCH — experimental: chopped, bit-crushed feel, stutters,
     broken hats, a detuned bass, and off-grid accents. */
  function renderGlitch(spec){
    const rng = makeRng(spec.seed);
    const rootMidi = spec.root;
    const bars = spec.bars;
    const bpm  = spec.bpm;
    const scaleName = spec.scale;
    const frame = renderFrame(bars, bpm, 4);
    const B = newBuffer(frame.totalSec + 1.2);
    const scale = scaleNotes(rootMidi, scaleName, 3);
    const prog = PROGRESSIONS[spec.progression] || PROGRESSIONS.i_v_ii_vii;

    for(let bar = 0; bar < bars; bar++){
      const degree = prog[bar % prog.length];
      const chord  = triad(rootMidi, degree, scaleName);
      const bassRoot = rootMidi - 12 + scale[degree % scale.length];
      // kick: syncopated + occasional double
      const kicks = [0, 7, 10];
      if(bar % 2 === 1) kicks.push(13);
      kicks.forEach(s => {
        const idx = place(B, B.n, bar, s);
        voiceKick(B.buf, idx, B.n - idx, rng, { vol: 0.9, f0: 110, f1: 40, dur: 0.3 });
        voiceSub(B.buf, idx, B.n - idx, rng, { vol: 0.45, f: mtof(bassRoot - 12), dur: 0.26 });
      });
      // broken hats — random short bursts
      for(let s = 0; s < STEP; s++){
        if(rng() < 0.5){
          const idx = place(B, B.n, bar, s);
          voiceHat(B.buf, idx, B.n - idx, rng, { vol: 0.2 + rng() * 0.15, open: rng() < 0.1 });
        }
      }
      // stuttering lead
      if(rng() < 0.85){
        const note = scale[Math.floor(rng() * scale.length)] + 12;
        const idx = place(B, B.n, bar, Math.floor(rng() * STEP));
        voiceLead(B.buf, idx, B.n - idx, rng, {
          midi: note, vol: 0.22, type: 'square', dur: frame.secPer16 * 1.2,
          cut: 2400, width: 0.5, echo: 0.4
        });
      }
      // arps
      if(bar % 2 === 0){
        const idx = place(B, B.n, bar, 0);
        voiceArp(B.buf, idx, B.n - idx, rng, {
          midis: chord.map(x => x + 12), vol: 0.16, dur: frame.secPer16 * STEP,
          rate: 16, cut: 3600
        });
      }
      // pad (soft)
      const padIdx = place(B, B.n, bar, 0);
      voicePad(B.buf, padIdx, B.n - padIdx, rng, {
        midis: chord, vol: 0.1, dur: frame.secPer16 * STEP, cut: 1400, width: 0.6
      });
    }
    return B;
  }

  /* ───────────────────────────────────────────────────────────────
     §6 · WAV ENCODER — 16-bit PCM stereo
  ─────────────────────────────────────────────────────────────────── */

  function interleaveToWav(samples, seconds){
    // samples = Float32Array (interleaved, length = seconds*SR*2)
    // trim to exactly `seconds`
    const nFrames = Math.floor(seconds * SR);
    const bytesPerSample = 2;
    const numChannels = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = SR * blockAlign;
    const dataSize = nFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buffer);

    function wstr(o, s){ for(let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    function w32(o, v){ dv.setUint32(o, v, true); }
    function w16(o, v){ dv.setUint16(o, v, true); }

    wstr(0, 'RIFF');
    w32(4, 36 + dataSize);
    wstr(8, 'WAVE');
    wstr(12, 'fmt ');
    w32(16, 16);                 // fmt chunk size
    w16(20, 1);                  // PCM
    w16(22, numChannels);
    w32(24, SR);
    w32(28, byteRate);
    w16(32, blockAlign);
    w16(34, 8 * bytesPerSample); // 16 bits
    wstr(36, 'data');
    w32(40, dataSize);

    let o = 44;
    for(let i = 0; i < nFrames; i++){
      const l = cl(samples[i*2],     -1, 1);
      const r = cl(samples[i*2 + 1], -1, 1);
      dv.setInt16(o,     Math.round(l * 32767), true); o += 2;
      dv.setInt16(o,     Math.round(r * 32767), true); o += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /* peak-normalise a buffer to a target peak, in place */
  function normalise(samples, target){
    let peak = 0;
    for(let i = 0; i < samples.length; i++){
      const a = Math.abs(samples[i]);
      if(a > peak) peak = a;
    }
    if(peak < 1e-6) return 0;
    const g = target / peak;
    for(let i = 0; i < samples.length; i++){
      samples[i] *= g;
    }
    return peak;
  }

  /* ───────────────────────────────────────────────────────────────
     §7 · SET BUILDER + generate(autoplay)
  ─────────────────────────────────────────────────────────────────── */

  /* A "demo set" = one track per style.  Each gets a distinct key,
     tempo, scale and seed so the set feels varied. */
  const SET = [
    { style: 'neon',    name: 'NEONCITY 01',  root: 45, scale: 'naturalMinor', bpm: 118, bars: 16, progression: 'i_vii_vi_iv',   seed: 101 },
    { style: 'pulse',   name: 'PULSEGRID 02', root: 41, scale: 'phrygian',     bpm: 126, bars: 16, progression: 'i_iv_v_vii',    seed: 202 },
    { style: 'deep',    name: 'DEEPDRIFT 03', root: 48, scale: 'dorian',       bpm: 122, bars: 16, progression: 'i_iii_vi_vii',  seed: 303 },
    { style: 'ambient', name: 'AETHER 04',    root: 50, scale: 'lydian',       bpm: 74,  bars: 12, progression: 'i_iv_v_vii',    seed: 404 },
    { style: 'glitch',  name: 'DATADECAY 05', root: 43, scale: 'harmonicMinor',bpm: 132, bars: 14, progression: 'i_v_ii_vii',    seed: 505 }
  ];

  const RENDERERS = {
    neon: renderNeon, pulse: renderPulse, deep: renderDeep,
    ambient: renderAmbient, glitch: renderGlitch
  };

  let generated = 0;   // running id for a unique folder name

  /* render one set entry → a record with a WAV blob URL */
  function buildEntry(entry){
    const renderer = RENDERERS[entry.style];
    const t0 = performance.now();
    const frame = renderer(entry);
    normalise(frame.buf, 0.86);
    // trim the tail by using the intended length
    const seconds = frame.totalSec;
    const wav = interleaveToWav(frame.buf, seconds);
    const url = URL.createObjectURL(wav);
    const ms = Math.round(performance.now() - t0);
    const rec = {
      name: entry.name,
      ext: 'wav',
      kind: 'audio',
      isVideo: false,
      src: url,
      blob: wav,
      size: wav.size,
      folder: 'DEMO SIGNAL',
      dir: 'DEMO',
      _demo: true,
      _ms: ms
    };
    return rec;
  }

  /* remove any previously generated demo records from the queue */
  function clearDemo(){
    if(!Q.list) return;
    for(let i = Q.list.length - 1; i >= 0; i--){
      if(Q.list[i]._demo){
        const r = Q.list[i];
        if(r.url) try{ URL.revokeObjectURL(r.url); }catch(_){}
        if(r.src) try{ URL.revokeObjectURL(r.src); }catch(_){}
        Q.list.splice(i, 1);
      }
    }
  }

  /* the public API.  Called by p06 (empty-queue toggle + demo button)
     and by the keyboard (G).  `autoplay` starts playing immediately. */
  function generate(autoplay){
    autoplay = autoplay !== false;
    const t0 = performance.now();
    A.toast('Synthesising demo set…', '◈');

    /* render synchronously in small chunks so we can update the toast
       and never block the frame for too long.  The set is short
       enough to render fast, but we still yield between tracks. */
    const records = [];
    let i = 0;
    function step(){
      if(i >= SET.length){
        finish(records, t0);
        return;
      }
      const entry = SET[i];
      A.toast('Rendering ' + (i + 1) + '/' + SET.length + ' — ' + entry.name, '◈');
      const rec = buildEntry(entry);
      records.push(rec);
      i++;
      // yield to the event loop so the UI stays responsive
      if(window.requestAnimationFrame){
        requestAnimationFrame(step);
      }else{
        setTimeout(step, 0);
      }
    }
    step();
  }

  function finish(records, t0){
    clearDemo();
    /* insert the demo set.  If the queue was empty, it becomes the
       whole queue; otherwise it's appended. */
    if(Q.list && Q.addTracks){
      Q.addTracks(records, { autoplay: false });
    }
    const totalMs = Math.round(performance.now() - t0);
    generated++;
    A.toast('DEMO SET READY — ' + records.length + ' tracks · ' + totalMs + 'ms', '◈', 3500);

    if(autoplay){
      /* play the first demo track (index 0 after addTracks keeps
         index at its previous value, so find the first demo) */
      const idx = Q.list.findIndex(r => r._demo);
      if(idx >= 0){
        Q.index = idx;
        const au = A.audio;
        try{ if(au && au.build) au.build(); }catch(err){
          A.showBanner('AUDIO ENGINE OFFLINE', 4000); return;
        }
        try{ if(au && au.resume) au.resume(); }catch(_){}
        Q.play();
      }
    }
    /* refresh the library (p07) so the demo tracks appear there */
    bus.emit('lib:added', { count: records.length, demo: true });
  }

  /* expose for p06 + p08 */
  A.demo = {
    generate: generate,
    clear: clearDemo,
    set: SET
  };

  console.info('[Aqua Demo] procedural synthesiser online — ' + SET.length + ' tracks (' +
               Object.keys(RENDERERS).join('/') + ')');
});

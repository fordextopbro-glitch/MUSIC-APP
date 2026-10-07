/* ═══════════════════════════════════════════════════════════════════
   PART p06 · PLAYBACK — WEB AUDIO ENGINE + TRANSPORT
   ─────────────────────────────────────────────────────────────────
   · Persistent Web Audio graph (created ONCE on first gesture):
       element(s) → [GranPitch worklet] → 5-band EQ →
       dry/wet → convolver (procedural IR) → mix →
       analyser → master → destination
     MediaElementSource is never recreated (standing rule).
   · GranPitch: WSOLA granular pitch shifter (tempo-neutral) +
     fractional resample + stereo width, running in an
     AudioWorklet.  Pure-JS core is unit-testable in Node.
     Fallback when worklets are unavailable: coupled
     playbackRate mode (pitch follows speed, width off).
   · 8 space presets (reverb/room/decay + 5 EQ bands) applied
     live; procedural stereo impulse responses cached.
   · Track queue + transport: play / pause / next / prev /
     seek / shuffle / repeat(off|all|one) / volume / mute.
     Video files route through the theater fullscreen.
   · Analysis rAF: 20 log-spaced bands + waveform + RMS energy
     → Aqua.gl.state (3D reactor) + pod canvases + readouts.
   · Media Session API metadata + action handlers.
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('playback', function initPlayback(){
  'use strict';

  const { AFormat, AMath, ARand } = Aqua.math;

  const el = {
    audio:    Aqua.el('audioPlayer'),
    video:    Aqua.el('videoPlayer'),
    dive:     Aqua.el('dive'),
    dock:     Aqua.el('dock'),
    dockFill: Aqua.el('dockFill'),
    dockTitle:el_('dockTitle'),
    dockSub:  el_('dockSub'),
    dockOpen: el_('dockOpen'),
    dShuffle: el_('dShuffle'),
    dPrev:    el_('dPrev'),
    dBack:    el_('dBack'),
    dPlay:    el_('dPlay'),
    dFwd:     el_('dFwd'),
    dNext:    el_('dNext'),
    dRepeat:  el_('dRepeat'),
    dMute:    el_('dMute'),
    dockVol:  el_('dockVol'),
    pod:      el_('pod'),
    podOpen:  el_('podOpenBtn'),
    podClose: el_('podClose'),
    podTitle: el_('podTitle'),
    podType:  el_('podType'),
    podExt:   el_('podExt'),
    podFolder:el_('podFolder'),
    podSeq:   el_('podSeq'),
    spectrum: el_('spectrumCanvas'),
    specBpm:  el_('specBpm'),
    wave:     el_('waveCanvas'),
    waveDb:   el_('waveDb'),
    seek:     el_('seek'),
    seekCur:  el_('seekCur'),
    seekTot:  el_('seekTot'),
    pShuffle: el_('pShuffle'),
    pPrev:    el_('pPrev'),
    pBack:    el_('pBack'),
    pPlay:    el_('pPlay'),
    pFwd:     el_('pFwd'),
    pNext:    el_('pNext'),
    pRepeat:  el_('pRepeat'),
    theater:  el_('theater'),
    theaterTitle: el_('theaterTitle'),
    theaterClose: el_('theaterClose'),
    theaterFrame: document.querySelector('.theater-frame'),
    specEngine: el_('specEngine'),
    demoBtn:  el_('demoBtn'),
    ledAudio: el_('ledAudio'),
    statAudio:el_('statAudio')
  };
  function el_(id){ return Aqua.el(id); }

  if(!el.audio) throw new Error('audioPlayer element missing');

  /* ═════════════════════════════════════════════════════════════
     §0 · GRANULAR PITCH SHIFTER (pure DSP — shared with worklet)
     Tempo-neutral pitch shift:
       WSOLA frames extracted at hop H/P, placed at hop H
       → content rate 1/P (pitch unchanged, tempo 1/P)
       then fractional resample with step P
       → net: tempo 1, pitch ×P
  ═══════════════════════════════════════════════════════════════ */
  const GRAN_PITCH_SRC = `/*__GRAN_START__*/
class GranPitch {
  constructor(sr){
    this.sr = sr || 48000;
    this.P = 1;
    this.H = 256;              /* output hop (WSOLA domain) */
    this.N = 1024;             /* frame length */
    this.hIn = this.H;         /* input hop = H / P          */
    this.searchWin = 192;
    this.cap = 16384;
    this.inL = new Float32Array(this.cap);
    this.inR = new Float32Array(this.cap);
    this.inHead = 0;
    this.inTotal = 0;          /* samples ever pushed        */
    this.wsL = new Float32Array(this.cap);
    this.wsR = new Float32Array(this.cap);
    this.wsTotal = 0;          /* WSOLA-domain samples ever written */
    this.frameIdx = 0;
    this.lastOffL = 0;
    this.lastOffR = 0;
    this.rdL = 0;              /* fractional resample read pointers */
    this.rdR = 0;
    this.rdTotal = 0;
    this.zeroHead = 0;         /* slots before this abs position are cleared */
    this.hann = new Float32Array(this.N);
    for(let i = 0; i < this.N; i++){
      this.hann[i] = 0.5 - 0.5 * Math.cos(6.28318530718 * i / (this.N - 1));
    }
    this.searchBuf = new Float32Array(this.N);
    this.gain = 1 / this._colaSum();
  }

  setPitch(p){
    p = Math.max(0.25, Math.min(4, p || 1));
    if(Math.abs(p - this.P) < 1e-4) return;
    this.P = p;
    this.hIn = this.H / p;
    /* gain is independent of pitch (output hop is fixed at H) */
  }

  /* Overlap-add constant of the Hann window at the fixed output hop H.
     Frames are placed every H samples on the WSOLA stream, so the
     synthesis overlap is always N/H.  Divide each frame by this sum
     to make a constant reconstruct to unity. */
  _colaSum(){
    const N = this.N, hop = this.H;
    const maxM = Math.ceil(N / hop) + 2;
    let worst = 0;
    for(let k = 0; k < N; k += 8){
      let sum = 0;
      for(let m = -maxM; m <= maxM; m++){
        const d = k - m * hop;
        if(d >= 0 && d < N) sum += this.hann[d];
      }
      if(sum > worst) worst = sum;
    }
    return worst > 1e-6 ? worst : 1;
  }

  push(inL, inR, n){
    const cap = this.cap;
    const head = this.inHead;
    if(head + n <= cap){
      this.inL.set(inL.subarray(0, n), head);
      if(inR) this.inR.set(inR.subarray(0, n), head);
      else this.inR.set(inL.subarray(0, n), head);
    }else{
      const first = cap - head;
      this.inL.set(inL.subarray(0, first), head);
      if(inR) this.inR.set(inR.subarray(0, first), head);
      else this.inR.set(inL.subarray(0, first), head);
      const rest = n - first;
      this.inL.set(inL.subarray(first), 0);
      if(inR) this.inR.set(inR.subarray(first), 0);
      else this.inR.set(inL.subarray(first), 0);
    }
    this.inHead = (head + n) % cap;
    this.inTotal += n;
    /* frames are generated lazily in read(), driven by the read head —
       see read().  push() only stores input. */
  }

  /* ring read with wrap: value at absolute sample (abs) */
  _getL(abs){
    const cap = this.cap;
    let idx = Math.floor(abs) % cap;
    if(idx < 0) idx += cap;
    return this.inL[idx];
  }
  _getR(abs){
    const cap = this.cap;
    let idx = Math.floor(abs) % cap;
    if(idx < 0) idx += cap;
    return this.inR[idx];
  }

  /* SAD between input[s..s+N) and reference (also input, at refStart) */
  _search(s, refStart){
    const N = this.N, W = this.searchWin;
    const ib = this.searchBuf;
    for(let k = 0; k < N; k++) ib[k] = this._getL(refStart + k);
    let best = 0, bestE = Infinity;
    /* coarse */
    for(let d = -W; d <= W; d += 8){
      const s0 = s + d;
      let e = 0;
      for(let k = 0; k < N; k += 2){
        const v = this._getL(s0 + k) - ib[k];
        e += v < 0 ? -v : v;
      }
      if(e < bestE){ bestE = e; best = d; }
    }
    /* fine */
    const lo = best - 8, hi = best + 8;
    for(let d = lo; d <= hi; d++){
      if(d < -W || d > W) continue;
      const s0 = s + d;
      let e = 0;
      for(let k = 0; k < N; k++){
        const v = this._getL(s0 + k) - ib[k];
        e += v < 0 ? -v : v;
      }
      if(e < bestE){ bestE = e; best = d; }
    }
    return best;
  }

  _addFrame(s, outPos, isL){
    const N = this.N, cap = this.cap;
    const g = this.gain;
    const src = isL ? this.inL : this.inR;
    const dst = isL ? this.wsL : this.wsR;
    /* s may be fractional — integer start + fractional crossfade
       into the previous sample */
    let sInt = Math.floor(s);
    const frac = s - sInt;
    for(let k = 0; k < N; k++){
      let v;
      if(k === 0 && frac > 0){
        v = src[(sInt - 1 + cap) % cap] * frac + src[sInt % cap] * (1 - frac);
      }else{
        v = src[(sInt + k) % cap];
      }
      const o = outPos + k;
      const oi = o % cap;
      dst[oi] += v * this.hann[k] * g;
    }
  }

  _genFrame(){
    const i = this.frameIdx;
    const outPos = i * this.H;
    const sIdeal = i * this.hIn;
    /* reference = input at the ideal position; candidates shift it */
    const refStart = Math.round(sIdeal);
    /* candidate window centred on the ideal position (symmetric) */
    let offL = this._search(sIdeal, refStart);
    let offR = this._search(sIdeal, refStart);
    /* continuity: offsets should not jump wildly between frames */
    const maxJump = this.searchWin * 0.5;
    if(offL - this.lastOffL >  maxJump) offL = this.lastOffL + Math.floor(maxJump);
    if(offL - this.lastOffL < -maxJump) offL = this.lastOffL - Math.floor(maxJump);
    if(offR - this.lastOffR >  maxJump) offR = this.lastOffR + Math.floor(maxJump);
    if(offR - this.lastOffR < -maxJump) offR = this.lastOffR - Math.floor(maxJump);
    this.lastOffL = offL;
    this.lastOffR = offR;
    this._addFrame(sIdeal + offL, outPos, true);
    this._addFrame(sIdeal + offR, outPos, false);
    const written = outPos + this.N;
    if(written > this.wsTotal) this.wsTotal = written;
    this.frameIdx++;
  }

  /* resample the WSOLA stream (step = P) into the output block.
     Pointers are absolute WSOLA-domain positions, always ≥ 0.     */
  read(outL, outR, n){
    if(!outR) outR = outL;
    const cap = this.cap;
    const P = this.P;
    let rdL = this.rdL, rdR = this.rdR, rdTotal = this.rdTotal;
    /* fixed startup latency: hold the read a full 4096 input samples
       behind the input.  This both delays the output and gives the
       read-driven frame generation ~1000 samples of headroom, so the
       read never starves in steady state (no sawtooth, no repeats). */
    const maxRead = P * (this.inTotal - 4096);
    if(maxRead <= 0){
      for(let i = 0; i < n; i++){
        outL[i] = 0;
        if(outR !== outL) outR[i] = 0;
      }
      return;
    }
    if(rdL > maxRead){ rdL = maxRead; rdR = maxRead; rdTotal = maxRead; }
    /* generate WSOLA frames driven by the READ head (steady), bounded
       by input availability.  A frame at outPos=k needs input up to
       k/P + searchWin + N. */
    const genLimit = Math.min(
      rdL + this.N + this.searchWin + this.H,
      P * (this.inTotal - this.searchWin - this.N - 8)
    );
    while(this.frameIdx * this.H < genLimit){
      this._genFrame();
    }
    /* finalized frontier = last generated outPos (a frame at outPos=k
       contributes hann[0]=0 at k, so positions ≤ lastOutPos are final) */
    const avail = (this.frameIdx - 1) * this.H;
    for(let i = 0; i < n; i++){
      if(rdL >= avail || avail <= 0){
        /* no final data yet — emit silence and hold (wait for the
           generator to catch up; it is driven by this read head) */
        outL[i] = 0;
        if(outR !== outL) outR[i] = 0;
        continue;
      }
      const fl = Math.floor(rdL);
      const fr = rdL - fl;
      const l0 = this.wsL[fl % cap];
      const l1 = this.wsL[(fl + 1) % cap];
      outL[i] = l0 + (l1 - l0) * fr;
      if(outR === outL){
        rdR = rdL;
      }else{
        const frR = Math.floor(rdR);
        const frf = rdR - frR;
        const r0 = this.wsR[frR % cap];
        const r1 = this.wsR[(frR + 1) % cap];
        outR[i] = r0 + (r1 - r0) * frf;
        rdR += P;
      }
      rdL += P;
      rdTotal++;
    }
    this.rdL = rdL;
    this.rdR = rdR;
    this.rdTotal = rdTotal;

    /* clear ring slots the read head has passed.  A position X is
       final once the write head passes X (all its contributing frames
       have outPos ≤ X and are generated) and the read head passes X
       (it will never be read again, and no future frame writes ≤ X).
       Without this, a later lap's frames would accumulate on top of
       already-consumed values.  Zero strictly before the current
       read position so the in-flight interpolation slot stays intact. */
    let zt = Math.min(Math.floor(rdL), Math.floor(rdR));
    if(zt > this.zeroHead){
      if(zt - this.zeroHead > cap){
        /* jumped more than a full lap (restart / long stall) —
           clear the whole ring in one bounded pass */
        this.wsL.fill(0);
        this.wsR.fill(0);
      }else{
        for(let z = this.zeroHead; z < zt; z++){
          this.wsL[z % cap] = 0;
          this.wsR[z % cap] = 0;
        }
      }
      this.zeroHead = zt;
    }
  }
}
/*__GRAN_END__*/`;

  /* worklet tail: the processor around the shared DSP core */
  const WORKLET_TAIL = `
class NeonFXProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.w = 1;
    try{
      this.shL = new GranPitch(sampleRate);
      this.shR = new GranPitch(sampleRate);
      this.port.onmessage = (e) => {
        const d = e.data;
        if(d.type === "pitch"){
          this.shL.setPitch(d.v);
          this.shR.setPitch(d.v);
        }else if(d.type === "width"){
          this.w = d.v;
        }
      };
    }catch(err){
      this.dead = true;
      try{ this.port.postMessage({ type: "fail", err: String(err && err.message || err) }); }catch(_){}
    }
  }
  process(inputs, outputs){
    const out = outputs[0];
    const n = out[0].length;
    if(this.dead){
      const inp = inputs[0];
      if(inp && inp[0]){
        out[0].set(inp[0]);
        if(out[1]) out[1].set(inp.length > 1 ? inp[1] : inp[0]);
      }
      return true;
    }
    const inp = inputs[0];
    if(!inp || !inp[0]){
      out[0].fill(0);
      if(out[1]) out[1].fill(0);
      return true;
    }
    const inL = inp[0];
    const inR = inp.length > 1 ? inp[1] : inp[0];
    const m = inL.length;
    this.shL.push(inL, inR, m);
    this.shR.push(inR, null, m);
    this.shL.read(out[0], out.length > 1 ? out[1] : out[0], n);
    this.shR.read(out.length > 1 ? out[1] : out[0], null, n);
    if(this.w < 0.999 && out.length > 1){
      const l = out[0], r = out[1];
      for(let i = 0; i < n; i++){
        const mid = (l[i] + r[i]) * 0.5;
        const side = (l[i] - r[i]) * 0.5 * this.w;
        l[i] = mid + side;
        r[i] = mid - side;
      }
    }
    return true;
  }
}
registerProcessor("neonfx", NeonFXProcessor);
`;

  /* ═════════════════════════════════════════════════════════════
     §1 · GRAPH STATE
  ═══════════════════════════════════════════════════════════════ */
  const S = Aqua.settings;
  let ctx = null;
  let built = false;
  let fxMode = 'none';        /* 'worklet' | 'coupled' */
  let nodes = null;           /* {srcA, srcV, fx, eq[5], dry, conv, wet, mix, analyser, master} */
  let workletNode = null;
  let irCache = null;         /* {key, buffer} */
  let playBlocked = false;    /* autoplay policy blocked media.play() */

  function ensureCtx(){
    if(ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return false;
    try{
      ctx = new AC({ latencyHint: 'interactive' });
    }catch(e){
      ctx = null;
      return false;
    }
    return true;
  }

  function buildGraph(){
    if(built) return;
    if(!ensureCtx()) throw new Error('AudioContext unavailable');

    const srcA = ctx.createMediaElementSource(el.audio);
    let srcV = null;
    try{
      srcV = ctx.createMediaElementSource(el.video);
    }catch(e){
      srcV = null; /* video element may reject if unused — ok */
    }

    /* EQ chain */
    const mk = (type, freq, gain, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = freq;
      b.gain.value = gain;
      if(q != null) b.Q.value = q;
      return b;
    };
    const eq = [
      mk('lowshelf', 110, S.bass),
      mk('peaking', 340, S.lowmid, 0.9),
      mk('peaking', 1200, S.mid, 0.9),
      mk('peaking', 4200, S.highmid, 0.9),
      mk('highshelf', 10000, S.treble)
    ];

    /* Hub always feeds the EQ so audio is never silent while FX boots.
       Pitch worklet (if available) is spliced in later. */
    const hub = ctx.createGain();
    hub.gain.value = 1;
    srcA.connect(hub);
    if(srcV) srcV.connect(hub);
    hub.connect(eq[0]);
    fxMode = 'coupled';
    workletNode = null;

    if(ctx.audioWorklet){
      const src = GRAN_PITCH_SRC + WORKLET_TAIL;
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      ctx.audioWorklet.addModule(url).then(() => {
        try{ URL.revokeObjectURL(url); }catch(_){}
        if(!nodes) return;
        const node = new AudioWorkletNode(ctx, 'neonfx', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });
        node.port.postMessage({ type: 'pitch', v: 1 });
        node.port.postMessage({ type: 'width', v: S.width / 100 });
        try{ hub.disconnect(eq[0]); }catch(_){}
        hub.connect(node);
        node.connect(eq[0]);
        workletNode = node;
        fxMode = 'worklet';
        applySpeedPitch();
        applyWidth();
      }).catch(() => {
        fxMode = 'coupled';
        try{ hub.disconnect(); }catch(_){}
        try{ hub.connect(eq[0]); }catch(_){}
        applySpeedPitch();
      });
    }

    /* reverb send/return */
    let prev = eq[4];
    for(let i = 1; i < 5; i++){
      eq[i - 1].connect(eq[i]);
    }
    const dry = ctx.createGain();
    const conv = ctx.createConvolver();
    const wet = ctx.createGain();
    const mix = ctx.createGain();
    prev.connect(dry);
    prev.connect(conv);
    conv.connect(wet);
    dry.connect(mix);
    wet.connect(mix);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    const master = ctx.createGain();
    master.gain.value = S.muted ? 0 : S.volume;

    mix.connect(analyser);
    analyser.connect(master);
    master.connect(ctx.destination);

    nodes = {
      srcA: srcA,
      srcV: srcV,
      hub: hub,
      eq: eq,
      dry: dry,
      conv: conv,
      wet: wet,
      mix: mix,
      analyser: analyser,
      master: master
    };
    built = true;
    Aqua.flags.audioReady = true;

    applyReverb();
    applySpeedPitch();
    applyVolume();

    if(el.specEngine){
      el.specEngine.textContent = (Aqua.gl && Aqua.gl.isWebGL2 ? 'WEBGL2' :
        (Aqua.gl ? 'WEBGL1' : '2D')) + ' · WEB AUDIO';
    }
    console.info('[Aqua Play] graph built — ' +
      (fxMode === 'worklet' ? 'worklet FX' : 'coupled FX') +
      ', ' + (srcV ? 'audio+video' : 'audio') + ' sources');
  }

  /* resume on user gesture (autoplay policy) */
  function resumeCtx(){
    if(ctx && ctx.state === 'suspended'){
      ctx.resume().catch(() => {});
    }
  }

  /* ═════════════════════════════════════════════════════════════
     §2 · PROCEDURAL IMPULSE RESPONSES (reverb)
  ═══════════════════════════════════════════════════════════════ */
  function makeIR(decay, room){
    const sr = ctx.sampleRate;
    const seconds = Math.max(0.15, decay * (0.7 + (room / 100) * 1.3));
    const len = Math.max(sr * 0.15, Math.floor(seconds * sr));
    const ir = ctx.createBuffer(2, len, sr);
    const rnd = ARand.seeded('ir-' + Math.round(decay * 10) + '-' + Math.round(room));
    /* one-pole lowpass alpha: big room → darker */
    const alpha = 0.55 - (room / 100) * 0.42;
    for(let ch = 0; ch < 2; ch++){
      const d = ir.getChannelData(ch);
      let lp = 0;
      for(let i = 0; i < len; i++){
        const env = Math.pow(1 - i / len, 2.3);
        const x = (rnd.next() * 2 - 1) * 0.65;
        lp += alpha * (x - lp);
        d[i] = lp * env;
      }
    }
    return ir;
  }

  function applyReverb(){
    if(!built || !nodes) return;
    const reverb = S.reverb;        /* 0..100 wet amount */
    const wet = (reverb / 100) * 0.55;
    const t = 0.02;
    const now = ctx.currentTime;
    nodes.wet.gain.setTargetAtTime(wet, now, t);
    nodes.dry.gain.setTargetAtTime(1 - wet * 0.8, now, t);
    if(reverb > 0.5){
      const key = S.decay.toFixed(1) + '|' + Math.round(S.room / 5) * 5;
      if(!irCache || irCache.key !== key){
        irCache = { key: key, buffer: makeIR(S.decay, S.room) };
      }
      nodes.conv.buffer = irCache.buffer;
    }else if(irCache){
      nodes.conv.buffer = null;
      irCache = null;
    }
  }

  /* ═════════════════════════════════════════════════════════════
     §3 · SPEED / PITCH / WIDTH
  ═══════════════════════════════════════════════════════════════ */
  function applySpeedPitch(){
    const speed = AMath.clamp(S.speed, 0.5, 2);
    const pitchRatio = Math.pow(2, AMath.clamp(S.pitch, -12, 12) / 12);
    if(fxMode === 'worklet' && workletNode){
      /* speed via element rate; pitch via worklet (tempo-neutral) */
      try{ el.audio.playbackRate = speed; }catch(_){}
      try{ if(el.video && !el.video.paused) el.video.playbackRate = speed; }catch(_){}
      try{
        workletNode.port.postMessage({ type: 'pitch', v: pitchRatio });
      }catch(_){}
    }else{
      /* coupled: one resample stage — pitch follows speed */
      const rate = AMath.clamp(speed * pitchRatio, 0.25, 4);
      try{ el.audio.playbackRate = rate; }catch(_){}
      try{ el.video.playbackRate = rate; }catch(_){}
    }
  }

  function applyWidth(){
    if(fxMode === 'worklet' && workletNode){
      try{
        workletNode.port.postMessage({ type: 'width', v: AMath.clamp01(S.width / 100) });
      }catch(_){}
    }
  }

  function applyEQ(){
    if(!built) return;
    const now = ctx.currentTime;
    const vals = [S.bass, S.lowmid, S.mid, S.highmid, S.treble];
    for(let i = 0; i < 5; i++){
      nodes.eq[i].gain.setTargetAtTime(vals[i], now, 0.02);
    }
  }

  function applyVolume(){
    const v = S.muted ? 0 : AMath.clamp01(S.volume);
    /* Once the graph owns the output, keep element volume at 1 so we
       don't square-attenuate (element * master).  Before the graph
       exists the element is the only output. */
    if(built){
      el.audio.volume = 1;
      el.audio.muted = false;
      try{ el.video.volume = 1; el.video.muted = false; }catch(_){}
      nodes.master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    }else{
      el.audio.volume = v;
      el.audio.muted = !!S.muted;
      try{ el.video.volume = v; el.video.muted = !!S.muted; }catch(_){}
    }
  }

  /* ═════════════════════════════════════════════════════════════
     §4 · QUEUE + TRANSPORT
  ═══════════════════════════════════════════════════════════════ */
  const Q = {
    list: [],
    index: -1,
    shuffle: !!S.shuffle,
    repeat: S.repeat === 'all' ? 'all' : (S.repeat === 'one' ? 'one' : null),
    state: 'idle',          /* idle | playing | paused */

    get current(){ return this.index >= 0 ? this.list[this.index] : null; },
    get duration(){
      const t = this.current;
      if(!t) return 0;
      const media = t.type === 'video' ? el.video : el.audio;
      const d = media.duration;
      return isFinite(d) && d > 0 ? d : (t.duration || 0);
    },
    get time(){
      const t = this.current;
      if(!t) return 0;
      const media = t.type === 'video' ? el.video : el.audio;
      return media.currentTime || 0;
    },

    addTracks(tracks, opts){
      opts = opts || {};
      let added = 0;
      for(let i = 0; i < tracks.length; i++){
        const t = tracks[i];
        if(!t) continue;
        if(!t.url){
          if(t.src) t.url = t.src;
          else if(t.file) t.url = URL.createObjectURL(t.file);
          else if(t.blob) t.url = URL.createObjectURL(t.blob);
        }
        if(!t.url) continue;
        if(!t.type){
          t.type = (t.isVideo || t.kind === 'video') ? 'video' : 'audio';
        }
        this.list.push(t);
        added++;
      }
      if(added){
        Aqua.bus.emit('queue:changed', this.list.length);
        showDock();
        hideDive();
        if(this.index < 0 && (opts.autoplay !== false)){
          this.play(0);
        }else{
          if(this.index < 0) this.index = 0;
          updateDockMeta();
          updatePod(this.current);
        }
      }
      return added;
    },

    play(i){
      if(!this.list.length) return;
      if(i == null || i === true || i === false || isNaN(i)){
        i = this.index >= 0 ? this.index : 0;
      }
      i = i | 0;
      if(i < 0 || i >= this.list.length) return;
      try{
        buildGraph();
      }catch(err){
        Aqua.showBanner('AUDIO ENGINE OFFLINE: ' + (err && err.message || 'AudioContext unavailable'), 5000);
        Aqua.toast('Web Audio unavailable in this browser', '⚠');
        return;
      }
      resumeCtx();
      this.index = i;
      const t = this.list[i];
      const url = t.url || t.src;
      if(!url){
        Aqua.toast('Track has no audio source', '⚠');
        return;
      }
      t.url = url;
      hideDive();
      showDock();
      const media = t.type === 'video' ? el.video : el.audio;
      const other = t.type === 'video' ? el.audio : el.video;
      try{ other.pause(); }catch(_){}
      if(t.type === 'video'){
        openTheater(t);
      }else{
        closeTheater(true);
      }
      try{ media.pause(); }catch(_){}
      media.src = url;
      try{ media.currentTime = 0; }catch(_){}
      applySpeedPitch();
      const start = () => {
        const p = media.play();
        if(p && p.catch){
          p.catch(err => {
            if(err && err.name === 'AbortError') return;
            if(err && err.name === 'NotAllowedError'){
              playBlocked = true;
              this.state = 'paused';
              syncTransportUI();
              Aqua.toast('Hit ▶ to start audio', '▶');
              return;
            }
            Aqua.toast('Playback blocked or codec unsupported', '⚠');
            Aqua.showBanner('PLAYBACK ERROR: ' + (err && err.name || 'unknown'));
            this.state = 'idle';
            syncTransportUI();
          });
        }
      };
      if(ctx && ctx.state === 'suspended'){
        ctx.resume().then(start).catch(start);
      }else{
        start();
      }
      this.state = 'playing';
      updatePod(t);
      updateDockMeta();
      syncTransportUI();
      Aqua.bus.emit('audio:playing', true);
      Aqua.bus.emit('audio:track', t);
      mediaMetadata(t);
      setLed(true);
    },

    pause(){
      const t = this.current;
      if(!t) return;
      const media = t.type === 'video' ? el.video : el.audio;
      media.pause();
      this.state = 'paused';
      syncTransportUI();
      Aqua.bus.emit('audio:pause', true);
      mediaState();
    },

    toggle(){
      if(this.state === 'playing') this.pause();
      else if(this.state === 'paused' && this.current){
        const media = this.current.type === 'video' ? el.video : el.audio;
        resumeCtx();
        const p = media.play();
        if(p && p.catch) p.catch(() => {});
        this.state = 'playing';
        syncTransportUI();
        Aqua.bus.emit('audio:playing', true);
        setLed(true);
        mediaState();
      }else{
        if(this.list.length) this.play(this.index >= 0 ? this.index : 0);
        else if(Aqua.demo && Aqua.demo.generate){
          Aqua.demo.generate(true);
        }else{
          Aqua.toast('Load some tracks first — or hit DEMO SIGNAL', '◈');
        }
      }
    },

    next(auto){
      if(!this.list.length) return;
      let ni;
      if(this.shuffle && this.list.length > 1){
        do{ ni = Math.floor(Math.random() * this.list.length); }while(ni === this.index);
      }else{
        ni = this.index + 1;
        if(ni >= this.list.length){
          if(this.repeat === 'all' || !auto) ni = 0;
          else return this.stop();
        }
      }
      this.play(ni);
    },

    prev(){
      if(!this.list.length) return;
      if(this.index < 0){ this.play(0); return; }
      const cur = this.current;
      const media = (cur && cur.type === 'video') ? el.video : el.audio;
      if(media && media.currentTime > 3){
        media.currentTime = 0;
        return;
      }
      let pi = this.index - 1;
      if(pi < 0) pi = this.list.length - 1;
      this.play(pi);
    },

    skip(delta){
      const t = this.current;
      if(!t) return;
      const media = t.type === 'video' ? el.video : el.audio;
      media.currentTime = AMath.clamp(
        media.currentTime + delta, 0, Math.max(0, this.duration - 0.05)
      );
    },

    seek(t){
      const tr = this.current;
      if(!tr) return;
      const media = tr.type === 'video' ? el.video : el.audio;
      if(isFinite(media.duration) && media.duration > 0){
        media.currentTime = AMath.clamp(t, 0, media.duration);
      }
    },

    stop(){
      const t = this.current;
      if(t){
        const media = t.type === 'video' ? el.video : el.audio;
        media.pause();
        media.currentTime = 0;
      }
      this.state = 'idle';
      syncTransportUI();
      setLed(false);
      mediaState();
    },

    setShuffle(on){
      this.shuffle = !!on;
      S.shuffle = this.shuffle;
      Aqua.saveSettings();
      syncTransportUI();
    },

    cycleRepeat(){
      this.repeat = this.repeat === null ? 'all' : (this.repeat === 'all' ? 'one' : null);
      S.repeat = this.repeat || false;
      Aqua.saveSettings();
      syncTransportUI();
    },

    onEnded(){
      if(this.repeat === 'one'){
        const t = this.current;
        const media = t.type === 'video' ? el.video : el.audio;
        media.currentTime = 0;
        const p = media.play();
        if(p && p.catch) p.catch(() => {});
        return;
      }
      this.next(true);
    }
  };

  /* ═════════════════════════════════════════════════════════════
     §5 · POD / DOCK METADATA
  ═══════════════════════════════════════════════════════════════ */
  function updatePod(t){
    if(!t) return;
    if(el.podTitle) el.podTitle.textContent = t.name || '—';
    if(el.podType) el.podType.textContent = t.type === 'video' ? 'VIDEO' : 'AUDIO';
    if(el.podExt) el.podExt.textContent = (t.ext || '?').toUpperCase();
    if(el.podFolder) el.podFolder.textContent = t.folder || 'DROP SOURCE';
    if(el.podSeq) el.podSeq.textContent = (Q.index + 1) + ' / ' + Q.list.length;
  }

  function updateDockMeta(){
    const t = Q.current;
    if(el.dockTitle){
      el.dockTitle.textContent = t ? t.name : 'NO TRACK LOADED';
    }
    if(el.dockSub){
      el.dockSub.textContent = t
        ? (Q.state === 'playing' ? 'SIGNAL LIVE · ' + (t.ext || '').toUpperCase()
           : Q.state === 'paused' ? 'SIGNAL HELD' : 'READY · ' + (t.ext || '').toUpperCase())
        : 'AWAITING INPUT SIGNAL';
    }
  }

  function hideDive(){
    if(el.dive) el.dive.classList.remove('on');
  }

  function showDock(){
    if(el.dock) el.dock.classList.add('show');
  }

  function unlockAudio(){
    try{ if(!built) buildGraph(); }catch(_){}
    resumeCtx();
    playBlocked = false;
  }

  function setLed(playing){
    if(el.ledAudio){
      el.ledAudio.classList.remove('on', 'warn', 'err');
      if(playing) el.ledAudio.classList.add('on');
    }
    if(el.statAudio){
      el.statAudio.textContent = playing ? 'AUDIO: LIVE' : 'AUDIO: IDLE';
    }
  }

  /* ═════════════════════════════════════════════════════════════
     §6 · TRANSPORT UI
  ═══════════════════════════════════════════════════════════════ */
  function setPlayIcons(playing){
    const icons = [el.dPlay, el.pPlay];
    for(let i = 0; i < icons.length; i++){
      const b = icons[i];
      if(!b) continue;
      b.textContent = playing ? '❚❚' : '▶';
      b.classList.toggle('on', playing);
    }
  }

  function syncTransportUI(){
    setPlayIcons(Q.state === 'playing');
    const shs = [el.dShuffle, el.pShuffle];
    for(let i = 0; i < shs.length; i++){
      if(shs[i]) shs[i].classList.toggle('on', Q.shuffle);
    }
    const reps = [el.dRepeat, el.pRepeat];
    for(let i = 0; i < reps.length; i++){
      const b = reps[i];
      if(!b) continue;
      b.classList.toggle('on', Q.repeat !== null);
      b.title = Q.repeat === 'one' ? 'Repeat: one (R)' :
        Q.repeat === 'all' ? 'Repeat: all (R)' : 'Repeat: off (R)';
    }
    const muted = S.muted;
    if(el.dMute){
      el.dMute.textContent = muted ? '🔇' : '🔊';
      el.dMute.classList.toggle('on', muted);
    }
    updateDockMeta();
    mediaState();
  }

  let seeking = false;

  function wireButton(node, fn){
    if(!node) return;
    node.addEventListener('click', e => {
      e.stopPropagation();
      try{
        buildGraph();
      }catch(err){
        Aqua.showBanner('AUDIO ENGINE OFFLINE: ' + (err && err.message || 'AudioContext unavailable'), 5000);
        Aqua.toast('Web Audio unavailable in this browser', '⚠');
        return;
      }
      resumeCtx();
      fn();
    });
  }

  function wireTransport(){
    wireButton(el.dPlay, () => Q.toggle());
    wireButton(el.pPlay, () => Q.toggle());
    wireButton(el.dNext, () => Q.next(false));
    wireButton(el.pNext, () => Q.next(false));
    wireButton(el.dPrev, () => Q.prev());
    wireButton(el.pPrev, () => Q.prev());
    wireButton(el.dBack, () => Q.skip(-10));
    wireButton(el.pBack, () => Q.skip(-10));
    wireButton(el.dFwd, () => Q.skip(10));
    wireButton(el.pFwd, () => Q.skip(10));
    wireButton(el.dShuffle, () => Q.setShuffle(!Q.shuffle));
    wireButton(el.pShuffle, () => Q.setShuffle(!Q.shuffle));
    wireButton(el.dRepeat, () => Q.cycleRepeat());
    wireButton(el.pRepeat, () => Q.cycleRepeat());
    wireButton(el.dMute, () => {
      S.muted = !S.muted;
      Aqua.saveSettings();
      applyVolume();
      syncTransportUI();
    });

    if(el.dockVol){
      el.dockVol.value = S.volume;
      el.dockVol.addEventListener('input', () => {
        S.volume = AMath.clamp01(parseFloat(el.dockVol.value) || 0);
        if(S.volume > 0 && S.muted){
          S.muted = false;
          Aqua.saveSettings();
        }
        Aqua.saveSettings();
        applyVolume();
        syncTransportUI();
      });
    }

    if(el.seek){
      el.seek.addEventListener('pointerdown', () => { seeking = true; });
      window.addEventListener('pointerup', () => { seeking = false; });
      el.seek.addEventListener('input', () => {
        const d = Q.duration;
        if(d > 0) Q.seek((el.seek.value / 1000) * d);
      });
    }

    const dockProg = Aqua.el('dockProg');
    if(dockProg){
      const seekFromEvent = (e) => {
        const d = Q.duration;
        if(!(d > 0)) return;
        const rect = dockProg.getBoundingClientRect();
        const frac = AMath.clamp01((e.clientX - rect.left) / (rect.width || 1));
        Q.seek(frac * d);
      };
      dockProg.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        seeking = true;
        seekFromEvent(e);
        const move = (ev) => seekFromEvent(ev);
        const up = () => {
          seeking = false;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

    if(el.dockOpen){
      el.dockOpen.addEventListener('click', () => {
        if(el.pod) el.pod.classList.add('open');
      });
    }
    if(el.podOpen){
      el.podOpen.addEventListener('click', () => {
        if(el.pod) el.pod.classList.add('open');
      });
    }
    if(el.podClose){
      el.podClose.addEventListener('click', () => {
        if(el.pod) el.pod.classList.remove('open');
      });
    }
  }

  /* ═════════════════════════════════════════════════════════════
     §7 · MEDIA ELEMENT EVENTS
  ═══════════════════════════════════════════════════════════════ */
  function wireMediaEvents(){
    const onMedia = (media, isVideo) => {
      media.addEventListener('play', () => {
        Q.state = 'playing';
        syncTransportUI();
        Aqua.bus.emit('audio:playing', true);
        setLed(true);
        mediaState();
      });
      media.addEventListener('pause', () => {
        if(Q.state === 'playing'){
          Q.state = 'paused';
          syncTransportUI();
          Aqua.bus.emit('audio:pause', true);
          setLed(false);
          mediaState();
        }
      });
      media.addEventListener('ended', () => Q.onEnded());
      media.addEventListener('loadedmetadata', () => {
        const t = Q.current;
        if(t && (isVideo ? t.type === 'video' : t.type !== 'video')){
          t.duration = media.duration;
          if(el.seekTot) el.seekTot.textContent = AFormat.time(Q.duration);
        }
      });
      media.addEventListener('timeupdate', () => {
        /* keep seek/time fresh even when the analysis loop is idle */
        updateTimeUI();
      });
      media.addEventListener('error', () => {
        const t = Q.current;
        if(!t) return;
        const isThis = (isVideo && t.type === 'video') || (!isVideo && t.type !== 'video');
        if(!isThis) return;
        Aqua.toast('Decode failed: ' + t.name, '⚠');
        if(Q.state === 'playing') Q.next(true);
      });
    };
    onMedia(el.audio, false);
    onMedia(el.video, true);
  }

  /* ═════════════════════════════════════════════════════════════
     §8 · THEATER (video fullscreen)
  ═══════════════════════════════════════════════════════════════ */
  function openTheater(t){
    if(!el.theater) return;
    if(el.theaterTitle) el.theaterTitle.textContent = t.name || 'VIDEO';
    el.theater.classList.add('open');
  }
  function closeTheater(silent){
    if(!el.theater) return;
    el.theater.classList.remove('open');
    try{ el.video.pause(); }catch(_){}
    if(!silent){
      /* return focus to stage */
    }
  }
  function wireTheater(){
    if(el.theaterClose){
      el.theaterClose.addEventListener('click', () => closeTheater(false));
    }
    if(el.theaterFrame){
      el.theaterFrame.addEventListener('dblclick', () => {
        if(el.video.requestFullscreen){
          el.video.requestFullscreen().catch(() => {});
        }
      });
    }
    if(el.theater){
      el.theater.addEventListener('dblclick', e => {
        if(e.target === el.theater && el.video.requestFullscreen){
          el.video.requestFullscreen().catch(() => {});
        }
      });
    }
  }

  /* ═════════════════════════════════════════════════════════════
     §9 · MEDIA SESSION
  ═══════════════════════════════════════════════════════════════ */
  function mediaMetadata(t){
    if(typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try{
      const md = new MediaMetadata({
        title: t.name || 'NEONCORE',
        artist: 'NEONCORE REACTOR',
        album: t.folder || 'LOCAL SIGNAL'
      });
      navigator.mediaSession.metadata = md;
    }catch(_){}
  }
  function mediaState(){
    if(typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try{
      navigator.mediaSession.playbackState =
        Q.state === 'playing' ? 'playing' :
        Q.state === 'paused' ? 'paused' : 'none';
      if(Q.duration > 0){
        navigator.mediaSession.setPositionState({
          duration: Q.duration,
          playbackRate: 1,
          position: Math.min(Q.time, Q.duration)
        });
      }
    }catch(_){}
  }
  function wireMediaSession(){
    if(typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try{
      ms.setActionHandler('play', () => { buildGraph(); Q.toggle(); });
      ms.setActionHandler('pause', () => Q.pause());
      ms.setActionHandler('previoustrack', () => Q.prev());
      ms.setActionHandler('nexttrack', () => Q.next(false));
      ms.setActionHandler('seekbackward', d => Q.skip(-(d && d.seekOffset || 10)));
      ms.setActionHandler('seekforward', d => Q.skip(d && d.seekOffset || 10));
      ms.setActionHandler('seekto', d => {
        if(d && isFinite(d.seekTime)) Q.seek(d.seekTime);
      });
    }catch(_){}
  }

  /* ═════════════════════════════════════════════════════════════
     §10 · ANALYSIS LOOP — feeds the 3D reactor + pod canvases
  ═══════════════════════════════════════════════════════════════ */
  const BAND_COUNT = 20;
  const WAVE_POINTS = 48;
  const freqData = new Uint8Array(1024);
  const timeData = new Float32Array(2048);
  const bandBuf = new Float32Array(BAND_COUNT);
  const waveBuf = new Float32Array(WAVE_POINTS);
  let decaying = 0;

  /* log-spaced band edges: 40 Hz → 16 kHz */
  const bandEdges = (function(){
    const e = [];
    const f0 = 40, f1 = 16000;
    for(let i = 0; i <= BAND_COUNT; i++){
      e.push(f0 * Math.pow(f1 / f0, i / BAND_COUNT));
    }
    return e;
  })();

  function analyse(){
    if(!built || !nodes) return;
    const A = nodes.analyser;
    const sr = ctx.sampleRate;
    const binHz = sr / A.fftSize;

    if(Q.state === 'playing'){
      A.getByteFrequencyData(freqData);
      A.getFloatTimeDomainData(timeData);
      decaying = 0;

      /* 20 log bands */
      for(let b = 0; b < BAND_COUNT; b++){
        const lo = Math.max(0, Math.floor(bandEdges[b] / binHz));
        const hi = Math.min(1023, Math.max(lo + 1, Math.floor(bandEdges[b + 1] / binHz)));
        let sum = 0;
        for(let i = lo; i < hi; i++) sum += freqData[i];
        let v = sum / (hi - lo) / 255;
        bandBuf[b] = Math.pow(v, 1.35);
      }

      /* waveform (48 signed pts, min/max averaged, across 2048 samples) */
      const stride = Math.floor(timeData.length / WAVE_POINTS);
      for(let i = 0; i < WAVE_POINTS; i++){
        let lo = 0, hi = 0;
        const base = i * stride;
        for(let k = 0; k < stride; k++){
          const v = timeData[base + k];
          if(v < lo) lo = v;
          if(v > hi) hi = v;
        }
        waveBuf[i] = (lo + hi) * 0.5;
      }
      /* fixed-reference scaling + soft clip (quiet stays quiet) */
      for(let i = 0; i < WAVE_POINTS; i++){
        let v = waveBuf[i] / 0.32;
        if(v > 1) v = 1;
        else if(v < -1) v = -1;
        waveBuf[i] = v;
      }

      /* energy = RMS */
      let rms = 0;
      for(let i = 0; i < timeData.length; i += 4){
        rms += timeData[i] * timeData[i];
      }
      rms = Math.sqrt(rms / (timeData.length / 4));
    }else{
      /* graceful decay so the scene settles instead of snapping */
      decaying += 1;
      const k = Math.max(0, 1 - decaying / 30);
      for(let b = 0; b < BAND_COUNT; b++) bandBuf[b] *= k;
      for(let i = 0; i < WAVE_POINTS; i++) waveBuf[i] *= k;
    }

    /* push into the GL state (3D reactor reads these) */
    if(Aqua.gl && Aqua.gl.state){
      const st = Aqua.gl.state;
      st.bands.set(bandBuf);
      if(st.wave) st.wave.set(waveBuf.subarray(0, Math.min(WAVE_POINTS, st.wave.length)));
      /* energy from low-mid band mass */
      let e = 0;
      for(let b = 0; b < 8; b++) e += bandBuf[b];
      e = AMath.clamp01(e / 8 * 1.5);
      st.energyRaw = e;
      st.bass = AMath.clamp01((bandBuf[0] + bandBuf[1] + bandBuf[2] + bandBuf[3]) / 4 * 1.6);
      st.mid = AMath.clamp01((bandBuf[7] + bandBuf[8] + bandBuf[9] + bandBuf[10]) / 4 * 1.6);
      st.treble = AMath.clamp01((bandBuf[15] + bandBuf[16] + bandBuf[17] + bandBuf[18]) / 4 * 2.0);
      Aqua.bus.emit('audio:energy', e);
      Aqua.bus.emit('audio:bands', {
        bass: st.bass, mid: st.mid, treble: st.treble
      });
    }

    drawPodCanvases();
    updateTimeUI();
  }

  /* ── pod canvases (2D neon) ─────────────────────────────────── */
  function themeColors(){
    if(!themeColors._t || performance.now() - themeColors._t > 2000){
      const cs = getComputedStyle(document.documentElement);
      themeColors._t = performance.now();
      themeColors._c = {
        a1: cs.getPropertyValue('--a1').trim() || '#00e5ff',
        a2: cs.getPropertyValue('--a2').trim() || '#ff2d95',
        a3: cs.getPropertyValue('--a3').trim() || '#7c4dff'
      };
    }
    return themeColors._c;
  }

  function drawPodCanvases(){
    const podOpen = el.pod && el.pod.classList.contains('open');
    if(!podOpen) return;

    /* spectrum */
    if(el.spectrum){
      const c = el.spectrum;
      const x = c.getContext('2d');
      const W = c.width, H = c.height;
      const col = themeColors();
      x.clearRect(0, 0, W, H);
      const bw = W / BAND_COUNT;
      for(let b = 0; b < BAND_COUNT; b++){
        const v = bandBuf[b];
        const h = Math.max(2, v * (H - 6));
        const g = x.createLinearGradient(0, H - h, 0, H);
        g.addColorStop(0, col.a2);
        g.addColorStop(1, col.a1);
        x.fillStyle = g;
        x.globalAlpha = 0.35 + v * 0.65;
        x.fillRect(b * bw + 2, H - h, bw - 4, h);
        x.globalAlpha = 1;
      }
      /* centroid readout */
      if(Q.state === 'playing'){
        let num = 0, den = 0;
        const binHz = (ctx.sampleRate / nodes.analyser.fftSize);
        for(let i = 1; i < 512; i++){
          num += i * freqData[i];
          den += freqData[i];
        }
        const hz = den > 0 ? (num / den) * binHz : 0;
        if(el.specBpm) el.specBpm.textContent = hz > 0 ? Math.round(hz) + ' Hz' : '--Hz';
      }
    }

    /* waveform (signed, glowing line + center guide) */
    if(el.wave){
      const c = el.wave;
      const x = c.getContext('2d');
      const W = c.width, H = c.height;
      const col = themeColors();
      x.clearRect(0, 0, W, H);
      /* center guide */
      x.strokeStyle = col.a1;
      x.globalAlpha = 0.12;
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(0, H / 2);
      x.lineTo(W, H / 2);
      x.stroke();
      /* waveform line */
      x.globalAlpha = 0.95;
      x.lineWidth = 1.6;
      x.strokeStyle = col.a2;
      x.shadowColor = col.a2;
      x.shadowBlur = 6;
      x.beginPath();
      for(let i = 0; i < WAVE_POINTS; i++){
        const px = (i / (WAVE_POINTS - 1)) * W;
        const py = H / 2 + waveBuf[i] * (H / 2 - 3);
        if(i === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
      }
      x.stroke();
      x.shadowBlur = 0;
      x.globalAlpha = 1;
      /* dB readout */
      let rms = 0;
      for(let i = 0; i < WAVE_POINTS; i++) rms += waveBuf[i] * waveBuf[i];
      rms = Math.sqrt(rms / WAVE_POINTS);
      if(el.waveDb){
        el.waveDb.textContent = rms > 0.01 ? (20 * Math.log10(rms)).toFixed(1) + ' dB' : '-∞ dB';
      }
    }
  }

  function updateTimeUI(){
    const d = Q.duration;
    const t = Q.time;
    if(el.seekTot) el.seekTot.textContent = AFormat.time(d);
    if(el.seekCur) el.seekCur.textContent = AFormat.time(t);
    if(el.seek && !seeking){
      el.seek.value = d > 0 ? (t / d) * 1000 : 0;
    }
    if(el.dockFill){
      el.dockFill.style.width = d > 0 ? (t / d * 100).toFixed(2) + '%' : '0%';
    }
  }

  function analysisLoop(){
    requestAnimationFrame(analysisLoop);
    if(document.hidden) return;
    if(Q.state === 'playing' || decaying < 30){
      analyse();
    }
  }

  /* ═════════════════════════════════════════════════════════════
     §11 · BOOT
  ═══════════════════════════════════════════════════════════════ */
  wireTransport();
  wireMediaEvents();
  wireTheater();
  wireMediaSession();

  /* volume from settings (element-level, no ctx needed) */
  el.audio.volume = S.muted ? 0 : S.volume;
  try{ el.audio.preload = 'auto'; el.audio.setAttribute('playsinline', ''); }catch(_){}
  try{ if(el.video){ el.video.preload = 'metadata'; el.video.setAttribute('playsinline', ''); } }catch(_){}

  /* first gesture wakes AudioContext (autoplay policy) */
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => {
    window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
  });

  /* dock is the transport — slide it in so play is always reachable */
  requestAnimationFrame(() => showDock());

  syncTransportUI();
  requestAnimationFrame(analysisLoop);

  /* demo button (p09 implements the generator) */
  if(el.demoBtn){
    el.demoBtn.addEventListener('click', () => {
      try{
        if(Aqua.demo && Aqua.demo.generate){
          Aqua.demo.generate(true);
        }else{
          Aqua.toast('Demo generator offline', '⚠');
        }
      }catch(err){
        Aqua.showBanner('DEMO GENERATOR: ' + (err && err.message || 'failed'), 5000);
      }
    });
  }

  /* expose */
  Aqua.play = Q;
  Aqua.audio = {
    build: buildGraph,
    resume: resumeCtx,
    applyEQ: applyEQ,
    applyReverb: applyReverb,
    applySpeedPitch: applySpeedPitch,
    applyWidth: applyWidth,
    applyVolume: applyVolume,
    fxMode: () => fxMode,
    get ctx(){ return ctx; },
    get nodes(){ return nodes; },
    bandCount: BAND_COUNT,
    wavePoints: WAVE_POINTS
  };

  console.info('[Aqua Play] transport live — queue/shuffle/repeat/media-session wired');
});

/* ═══════════════ PART: p07_lib.js ═══════════════ */

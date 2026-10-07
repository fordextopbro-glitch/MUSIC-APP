/* ═══════════════════════════════════════════════════════════════════
   p07 · LIBRARY + CORE LAB
   ───────────────────────────────────────────────────────────────────
   This part owns every piece of UI that is *not* the transport buttons
   (which p06 wires) and *not* the theme/FPS/LEDs (which p02b wires).

   Responsibilities
     §1  Local helpers (html escape, icon pickers, small math glue)
     §2  Track model + file/folder import → Aqua.play.addTracks
     §3  Library list rendering (rows, now-playing, hover, thumb)
     §4  Search filtering (subscribes to the 'search:input' bus event
         that p02b emits — it does NOT re-bind the input)
     §5  Folder filter chips
     §6  Drag & drop import (window-wide, with a live drop veil)
     §7  File / folder <input> wiring + dive-screen buttons
     §8  Panel open/close (library, lab, library collapse)
     §9  Core Lab — presets grid (8)
     §10 Core Lab — reverb matrix (mix / room / decay)
     §11 Core Lab — 5-band equalizer
     §12 Core Lab — motion & space (pitch / speed / width)
     §13 Core Lab — system switches (night / dynamic / auto)
     §14 Core Lab — GPU render tier
     §15 Core Lab — live signal meters
     §16 HUD — stage readouts (now-tracking metadata)
     §17 HUD — dock progress fill + seek-bar position sync
     §18 Boot restore (re-hydrate every control from Aqua.settings)

   Contract with the rest of the kernel:
     · reads  Aqua.play, Aqua.audio, Aqua.settings, Aqua.saveSettings,
              Aqua.config, Aqua.bus, Aqua.el, Aqua.toast, Aqua.math
     · writes Aqua.lib   (the library controller, used by p08/p09)
     · emits  'lib:select', 'lib:removed', 'lab:applied'
═══════════════════════════════════════════════════════════════════ */
Aqua.addPart('library-lab', function initLibraryLab(){
  'use strict';

  const A    = Aqua;
  const el   = A.el.bind(A);
  const bus  = A.bus;
  const S    = A.settings;
  const Q    = A.play;
  if(!Q || !Q.list){
    console.error('[Aqua Lib] playback queue missing — library cannot bind');
    return;
  }
  const CFG  = A.config;
  const FMT  = A.math.AFormat;
  const M    = A.math.AMath;
  const R    = A.math.ARand;

  /* ───────────────────────────────────────────────────────────────
     §1 · LOCAL HELPERS
  ─────────────────────────────────────────────────────────────── */

  /* escape a string for safe insertion into innerHTML.  Track names
     come from the file system and can contain anything, so every
     user-controlled string passes through this before it touches
     the DOM. */
  function esc(str){
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* strip the extension from a file name */
  function baseName(name){
    const i = String(name).lastIndexOf('.');
    return i > 0 ? String(name).slice(0, i) : String(name);
  }

  /* classify a file as audio / video / unknown from its mime+ext */
  function classify(file){
    const mime = (file.type || '').toLowerCase();
    const ext  = (file.name.split('.').pop() || '').toLowerCase();
    if(mime.indexOf('video') === 0)          return { type: 'video', ext };
    if(mime.indexOf('audio') === 0)          return { type: 'audio', ext };
    if(ext === 'mp4' || ext === 'webm' || ext === 'mov' || ext === 'm4v') return { type: 'video', ext };
    if(ext === 'mp3' || ext === 'flac' || ext === 'ogg' || ext === 'oga' ||
       ext === 'wav' || ext === 'wave' || ext === 'm4a' || ext === 'aac' ||
       ext === 'opus' || ext === 'webm' || ext === 'aiff' || ext === 'aif' ||
       ext === 'wma' || ext === 'mp2' || ext === 'weba') return { type: 'audio', ext };
    return null;
  }

  /* a small glyph set so rows read as a HUD, not a file manager */
  function typeIcon(t){
    return t.type === 'video' ? '▞' : '♪';
  }

  /* the accent the library uses for the active row + now-playing —
     pulled from the live palette so Dynamic Colors stays coherent */
  function accent(){
    const c = (A.gl && A.gl.state && A.gl.state.colors) || null;
    if(c && c[0]) return c[0];
    const pal = A.config.palettes[0];
    return pal.a1;
  }

  /* clamp a number to [lo, hi] (falls back to AMath.clamp) */
  function cl(v, lo, hi){
    return (M && M.clamp) ? M.clamp(v, lo, hi) : Math.max(lo, Math.min(hi, v));
  }

  /* ───────────────────────────────────────────────────────────────
     §2 · TRACK MODEL + IMPORT
  ─────────────────────────────────────────────────────────────── */

  /* The library keeps its own ordered list of *display* records.
     Aqua.play.list holds the transport's list (same objects, in the
     same order) — we never fork the two.  A display record:

       {
         id      : number        // stable row id
         file    : File
         name    : string        // file name (with ext)
         base    : string        // file name (no ext)
         ext     : string        // lower-cased
         type    : 'audio'|'video'
         folder  : string        // top-level folder, or 'DIRECT'
         size    : number        // bytes
         duration: number|null   // seconds, filled in lazily
         url     : string        // object URL (set by Aqua.play)
         _row    : Element|null  // cached row element
       } */

  const LIB = {
    rows: [],          // display records, in queue order
    nextId: 1,
    filter: '',        // active search text (lower-cased)
    folder: 'ALL',     // active folder chip
    dirty: false       // list needs re-render
  };

  /* turn a File into a display record (no object URL yet) */
  function makeRecord(file, folder){
    const c = classify(file);
    if(!c) return null;
    return {
      id: LIB.nextId++,
      file: file,
      name: file.name,
      base: baseName(file.name),
      ext: c.ext,
      type: c.type,
      folder: folder || 'DIRECT',
      size: file.size || 0,
      duration: null,
      url: null,
      _row: null
    };
  }

  /* derive a folder label from a File's webkitRelativePath.
     "My Music/Pop/song.mp3" → "My Music" */
  function folderOf(file){
    const rp = file.webkitRelativePath || file.relativePath || '';
    if(rp){
      const parts = rp.split('/');
      if(parts.length > 2) return parts[0];
    }
    return 'DIRECT';
  }

  /* the payload passed to Aqua.play.addTracks — it only needs
     { name, file, type, ext, folder }; Aqua.play adds the url. */
  function toTransportRecord(rec){
    return {
      name: rec.name,
      file: rec.file,
      type: rec.type,
      ext: rec.ext,
      folder: rec.folder
    };
  }

  /* import a batch of File objects (from an <input> or a drop).
     · skips files the engine can't classify
     · de-duplicates against what is already queued (same name+size)
     · appends the survivors to Aqua.play (which owns the object URL)
     · reflects the result in the library list + chips + count */
  function importFiles(fileList, opts){
    opts = opts || {};
    const files = Array.prototype.slice.call(fileList || []);
    if(!files.length) return 0;

    /* de-dup key set built from the current queue */
    const seen = new Set();
    for(let i = 0; i < Q.list.length; i++){
      const t = Q.list[i];
      const f = t.file;
      seen.add((t.name || '') + '|' + (f ? f.size : 0));
    }

    const addedRecs = [];
    for(let i = 0; i < files.length; i++){
      const file = files[i];
      if(!file || !file.name) continue;
      const rec = makeRecord(file, opts.folder || folderOf(file));
      if(!rec) continue;                       // unsupported type
      const key = rec.name + '|' + rec.size;
      if(seen.has(key)) continue;              // already queued
      seen.add(key);
      LIB.rows.push(rec);
      addedRecs.push(rec);
    }

    if(addedRecs.length){
      /* pass the same objects so addTracks can stamp url onto the
         display records (queueIndex matches by file reference). */
      try{
        Q.addTracks(addedRecs, { autoplay: opts.autoplay !== false });
      }catch(err){
        A.showBanner('IMPORT: ' + (err && err.message || err), 4000);
      }
      const dock = el('dock');
      if(dock) dock.classList.add('show');
      const dive = el('dive');
      if(dive) dive.classList.remove('on');
      LIB.dirty = true;
      bus.emit('lib:added', addedRecs.length);
      A.toast('+' + addedRecs.length + ' signal' + (addedRecs.length === 1 ? '' : 's') + ' synced', '⬡');
    }else{
      if(files.length){
        A.toast('No new audio/video files to sync', '·');
      }
    }
    renderChips();
    renderList();
    updateCount();
    return addedRecs.length;
  }

  /* remove a queue index (and its display record + object URL) */
  function removeFromQueue(index){
    if(index < 0 || index >= Q.list.length) return;
    const t = Q.list[index];
    if(!t) return;
    if(t.url && t.url.indexOf('blob:') === 0){
      try{ URL.revokeObjectURL(t.url); }catch(_){}
    }
    Q.list.splice(index, 1);
    /* drop the matching display record (match by file reference) */
    for(let i = LIB.rows.length - 1; i >= 0; i--){
      if(LIB.rows[i].file === t.file){ LIB.rows.splice(i, 1); break; }
    }
    if(Q.index >= Q.list.length) Q.index = Q.list.length - 1;
    if(Q.index < 0 && Q.list.length) Q.index = 0;
    LIB.dirty = true;
    bus.emit('lib:removed', index);
    bus.emit('queue:changed', Q.list.length);
    renderChips();
    renderList();
    updateCount();
    A.toast('Signal dropped', '⌫');
  }

  /* clear the entire library + queue */
  function clearQueue(){
    for(let i = Q.list.length - 1; i >= 0; i--){
      removeFromQueue(i);
    }
    LIB.filter = '';
    LIB.folder = 'ALL';
    const si = el('searchInput');
    if(si) si.value = '';
    const sc = el('searchCount');
    if(sc) sc.style.display = 'none';
    A.toast('Library purged', '⌫');
  }

  /* lazily probe a track's duration with a detached probe element so
     the list can show lengths without disturbing the live player */
  function probeDuration(rec, cb){
    if(typeof cb !== 'function') cb = function(){};
    if(rec.duration != null){ cb(rec.duration); return; }
    if(!rec.url){
      const idx = queueIndex(rec);
      if(idx >= 0 && Q.list[idx] && Q.list[idx].url) rec.url = Q.list[idx].url;
    }
    if(!rec.url){ cb(null); return; }
    const probe = document.createElement(rec.type === 'video' ? 'video' : 'audio');
    probe.preload = 'metadata';
    let done = false;
    function finish(d){
      if(done) return;
      done = true;
      rec.duration = d;
      if(d != null && rec._row){
        const dur = rec._row.querySelector('.lr-dur');
        if(dur) dur.textContent = FMT.time(d);
      }
      cb(d);
      try{ probe.src = ''; }catch(_){}
    }
    probe.addEventListener('loadedmetadata', () => {
      finish(isFinite(probe.duration) ? probe.duration : null);
    });
    probe.addEventListener('error', () => finish(null));
    probe.src = rec.url;
  }

  /* ───────────────────────────────────────────────────────────────
     §3 · LIBRARY LIST RENDERING
  ─────────────────────────────────────────────────────────────── */

  const listEl = () => el('libList');

  /* true if a record passes the active search + folder filter */
  function matches(rec){
    if(LIB.folder !== 'ALL' && rec.folder !== LIB.folder) return false;
    if(LIB.filter){
      const hay = (rec.name + ' ' + rec.folder + ' ' + rec.ext).toLowerCase();
      if(hay.indexOf(LIB.filter) < 0) return false;
    }
    return true;
  }

  /* build one row element for a record (memoised on rec._row).
     The markup matches the .lib-row design already in the CSS:
       <span class="lr-idx">01</span>
       <span class="lr-ico">♪</span>
       <div class="lr-body">
         <div class="lr-name">Title</div>
         <div class="lr-meta">FOLDER · EXT · 3:45</div>
       </div>
       <div class="lr-eq"><i></i><i></i><i></i></div>
       <button class="lr-play">▶</button> */
  function rowFor(rec){
    if(rec._row && rec._row.isConnected) return rec._row;

    const row = document.createElement('div');
    row.className = 'lib-row' + (rec.type === 'video' ? ' video' : '');
    row.dataset.id = rec.id;
    row.tabIndex = 0;

    row.innerHTML =
      '<span class="lr-idx">··</span>' +
      '<span class="lr-ico">' + typeIcon(rec) + '</span>' +
      '<div class="lr-body">' +
        '<div class="lr-name">' + esc(rec.base) + '</div>' +
        '<div class="lr-meta">' + esc(rec.folder) + ' · ' +
          esc((rec.ext || '?').toUpperCase()) + ' · <span class="lr-dur">··:··</span></div>' +
      '</div>' +
      '<div class="lr-eq"><i></i><i></i><i></i></div>' +
      '<button class="lr-play" title="Play">▶</button>';

    /* click = play this track (by its position in the queue) */
    row.addEventListener('click', (e) => {
      playRecord(rec);
    });
    /* double-click a video = open the theater (fullscreen) */
    row.addEventListener('dblclick', () => {
      const idx = queueIndex(rec);
      if(idx >= 0 && rec.type === 'video'){
        try{ A.audio && A.audio.build && A.audio.build(); }catch(_){}
        Q.play(idx);
      }
    });
    /* keyboard: enter plays, delete removes */
    row.addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){ e.preventDefault(); playRecord(rec); }
      else if(e.key === 'Delete' || e.key === 'Backspace'){
        e.preventDefault();
        const idx = queueIndex(rec);
        if(idx >= 0) removeFromQueue(idx);
      }
    });
    /* context menu: right-click removes the row */
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = queueIndex(rec);
      if(idx >= 0) removeFromQueue(idx);
    });

    rec._row = row;
    return row;
  }

  /* the transport index of a display record (-1 if absent) */
  function queueIndex(rec){
    for(let i = 0; i < Q.list.length; i++){
      if(Q.list[i].file === rec.file) return i;
    }
    return -1;
  }

  /* play a record by finding its queue position */
  function playRecord(rec){
    const idx = queueIndex(rec);
    if(idx < 0) return;
    try{ A.audio && A.audio.build && A.audio.build(); }catch(_){}
    Q.play(idx);
    bus.emit('lib:select', idx);
  }

  /* the full re-render of the list.  Rebuilds only when dirty or when
     the filter/now-playing changes; otherwise it patches in place so
     the DOM stays quiet while the 3D scene is at 60fps. */
  function renderList(){
    const list = listEl();
    if(!list) return;

    /* drop the "empty" placeholder if we have rows */
    if(LIB.rows.length){
      const empty = list.querySelector('.lib-empty');
      if(empty) empty.remove();
    }

    /* append missing rows in queue order (preserving the DOM order) */
    let prevTail = list.firstChild;
    const visible = LIB.rows.filter(matches);
    const present = new Set();

    /* remove rows that are filtered out or deleted */
    const children = Array.prototype.slice.call(list.children);
    for(let i = 0; i < children.length; i++){
      const c = children[i];
      if(!c.dataset || !c.dataset.id) continue;
      const id = parseInt(c.dataset.id, 10);
      const rec = recordById(id);
      if(!rec || !matches(rec)){
        list.removeChild(c);
        if(rec) rec._row = null;
      }else{
        present.add(id);
      }
    }

    /* insert/append rows not yet present, in order */
    let anchor = list.firstChild;
    for(let i = 0; i < visible.length; i++){
      const rec = visible[i];
      if(present.has(rec.id)){
        anchor = anchor && anchor.nextElementSibling ? anchor.nextElementSibling : anchor;
        continue;
      }
      const row = rowFor(rec);
      list.insertBefore(row, anchor);
      probeDuration(rec, null);
    }

    patchListMeta();
  }

  function recordById(id){
    for(let i = 0; i < LIB.rows.length; i++){
      if(LIB.rows[i].id === id) return LIB.rows[i];
    }
    return null;
  }

  /* update the per-row index + the now-playing highlight (the .active
     class drives the CSS accent bar + the animated EQ bars).  We patch
     in place so the DOM stays quiet while the 3D scene runs. */
  function patchListMeta(){
    const list = listEl();
    if(!list) return;
    const now = Q.index;

    const rows = list.querySelectorAll('.lib-row');
    let shown = 0;
    for(let i = 0; i < rows.length; i++){
      const row = rows[i];
      const id = parseInt(row.dataset.id, 10);
      const rec = recordById(id);
      if(!rec) continue;
      const qidx = queueIndex(rec);
      shown++;
      const idx = row.querySelector('.lr-idx');
      if(idx){
        idx.textContent = (qidx >= 0) ? FMT.pad2(qidx + 1) : '··';
      }
      const isNow = (qidx === now);
      row.classList.toggle('active', isNow);
    }
    return shown;
  }

  /* show the "no signal" placeholder when the (filtered) list is empty */
  function updateEmptyState(){
    const list = listEl();
    if(!list) return;
    const hasAny = LIB.rows.length > 0;
    const shown = list.querySelectorAll('.lib-row').length;
    let empty = list.querySelector('.lib-empty');
    if(!hasAny && !shown){
      if(!empty){
        empty = document.createElement('div');
        empty.className = 'lib-empty';
        empty.innerHTML =
          '<span class="big">⬡</span>' +
          (LIB.filter
            ? 'NO MATCH FOR SCAN<br>ADJUST THE FILTER'
            : 'NO SIGNAL DETECTED<br>OPEN A FOLDER TO SYNC');
        list.appendChild(empty);
      }
    }else if(empty){
      empty.remove();
    }
  }

  /* the "N TKS" counter in the library header */
  function updateCount(){
    const c = el('libCount');
    if(!c) return;
    const n = Q.list.length;
    c.textContent = n + ' TKS';
  }

  /* ───────────────────────────────────────────────────────────────
     §4 · SEARCH FILTERING  (bus-driven — p02b binds the input)
  ─────────────────────────────────────────────────────────────── */

  function onSearch(q){
    LIB.filter = (q || '').toLowerCase();
    const cnt = el('searchCount');
    if(cnt){
      if(LIB.filter){
        const n = LIB.rows.filter(matches).length;
        cnt.textContent = n;
        cnt.style.display = 'flex';
      }else{
        cnt.style.display = 'none';
      }
    }
    LIB.dirty = true;
    renderList();
    updateEmptyState();
  }

  /* ───────────────────────────────────────────────────────────────
     §5 · FOLDER FILTER CHIPS
  ─────────────────────────────────────────────────────────────── */

  function renderChips(){
    const wrap = el('libChips');
    if(!wrap) return;
    wrap.innerHTML = '';

    /* collect the distinct folders present in the queue, by count */
    const folders = {};
    for(let i = 0; i < LIB.rows.length; i++){
      const f = LIB.rows[i].folder;
      folders[f] = (folders[f] || 0) + 1;
    }
    const keys = Object.keys(folders).sort();

    /* the "ALL" chip is always first */
    wrap.appendChild(chip('ALL', 'ALL SIGNALS', Q.list.length, LIB.folder === 'ALL'));

    for(let i = 0; i < keys.length; i++){
      wrap.appendChild(chip(keys[i], keys[i], folders[keys[i]], LIB.folder === keys[i]));
    }
  }

  function chip(id, label, count, active){
    const b = document.createElement('button');
    b.className = 'chip' + (active ? ' active' : '');
    b.dataset.folder = id;
    b.title = label + ' (' + count + ')';
    b.innerHTML =
      esc(A.math.AFormat.ellipsis(label, 16)) +
      '<span class="c-n">' + count + '</span>';
    b.addEventListener('click', () => {
      LIB.folder = (LIB.folder === id) ? 'ALL' : id;
      renderChips();
      renderList();
      updateEmptyState();
    });
    return b;
  }

  /* ───────────────────────────────────────────────────────────────
     §6 · DRAG & DROP IMPORT
  ─────────────────────────────────────────────────────────────── */

  /* A full-window drop veil so the user always has a target, plus the
     dive-screen dropzone which lights up while a drag is live. */
  let dropDepth = 0;
  let dropVeil = null;

  function ensureVeil(){
    if(dropVeil) return dropVeil;
    dropVeil = document.createElement('div');
    dropVeil.className = 'drop-veil';
    dropVeil.innerHTML =
      '<div class="dv-inner">' +
        '<span class="dv-ico">⇩</span>' +
        '<span class="dv-t">RELEASE TO SYNC</span>' +
        '<span class="dv-s">audio + video · mp3 flac ogg wav mp4</span>' +
      '</div>';
    document.body.appendChild(dropVeil);
    return dropVeil;
  }

  function veilOn(){
    ensureVeil();
    dropVeil.classList.add('on');
    const dz = el('dropzone');
    if(dz) dz.classList.add('hot');
  }
  function veilOff(){
    if(dropVeil) dropVeil.classList.remove('on');
    const dz = el('dropzone');
    if(dz) dz.classList.remove('hot');
  }

  /* pull File objects out of a DataTransfer, walking any dropped
     directories with the modern webkitGetAsEntry API (falling back to
     the flat items list where entry APIs are absent). */
  function filesFromDataTransfer(dt, cb){
    const out = [];
    const items = dt && dt.items ? dt.items : null;
    const entries = (items && items[0] && items[0].webkitGetAsEntry) ? readEntries(dt) : null;
    if(entries){
      let pending = entries.length;
      if(!pending){ cb(out); return; }
      for(let i = 0; i < entries.length; i++){
        walkEntry(entries[i], '', (files) => {
          for(let j = 0; j < files.length; j++) out.push(files[j]);
          pending--;
          if(pending === 0) cb(out);
        });
      }
    }else if(dt && dt.files){
      for(let i = 0; i < dt.files.length; i++) out.push(dt.files[i]);
      cb(out);
    }else{
      cb(out);
    }
  }

  function readEntries(dt){
    const entries = [];
    const items = dt.items;
    for(let i = 0; i < items.length; i++){
      try{
        const e = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
        if(e) entries.push(e);
      }catch(_){}
    }
    return entries;
  }

  /* recursively read a FileSystemEntry into a flat File[] (folders
     contribute their children, prefixed with the folder path) */
  function walkEntry(entry, path, cb){
    if(!entry){ cb([]); return; }
    if(entry.isFile){
      entry.file((f) => {
        cb([f]);
      }, () => cb([]));
    }else if(entry.isDirectory){
      const reader = entry.createReader();
      const collected = [];
      let done = false;
      function finish(){
        if(done) return;
        done = true;
        cb(collected);
      }
      function readBatch(){
        reader.readEntries((batch) => {
          if(!batch.length){ finish(); return; }
          let pending = batch.length;
          for(let i = 0; i < batch.length; i++){
            const childPath = path ? (path + '/' + batch[i].name) : batch[i].name;
            walkEntry(batch[i], childPath, (files) => {
              for(let j = 0; j < files.length; j++) collected.push(files[j]);
              pending--;
              if(pending === 0) readBatch();
            });
          }
        }, () => finish());
      }
      readBatch();
    }else{
      cb([]);
    }
  }

  function wireDrop(){
    const windowDrag = (e) => {
      e.preventDefault();
      if(e.dataTransfer){
        try{ e.dataTransfer.dropEffect = 'copy'; }catch(_){}
      }
    };
    window.addEventListener('dragenter', (e) => {
      windowDrag(e);
      if(hasFiles(e)){
        dropDepth++;
        veilOn();
      }
    });
    window.addEventListener('dragover', (e) => {
      windowDrag(e);
    });
    window.addEventListener('dragleave', (e) => {
      if(!hasFiles(e)) return;
      dropDepth--;
      if(dropDepth <= 0){
        dropDepth = 0;
        veilOff();
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropDepth = 0;
      veilOff();
      if(!e.dataTransfer) return;
      filesFromDataTransfer(e.dataTransfer, (files) => {
        if(files.length) importFiles(files, { autoplay: true });
        else A.toast('Nothing droppable in that payload', '·');
      });
    });
  }

  function hasFiles(e){
    const dt = e && e.dataTransfer;
    if(!dt || !dt.types) return false;
    for(let i = 0; i < dt.types.length; i++){
      if(dt.types[i] === 'Files') return true;
    }
    return false;
  }

  /* ───────────────────────────────────────────────────────────────
     §7 · FILE / FOLDER <input> + DIVE BUTTONS
  ─────────────────────────────────────────────────────────────── */

  function wireInputs(){
    const fileInput = el('fileInput');
    const folderInput = el('folderInput');

    if(fileInput){
      fileInput.addEventListener('change', () => {
        importFiles(fileInput.files, { autoplay: true });
        fileInput.value = '';   // allow re-picking the same file
      });
    }
    if(folderInput){
      folderInput.addEventListener('change', () => {
        importFiles(folderInput.files, { autoplay: true });
        folderInput.value = '';
      });
    }

    const openFiles  = () => { try{ if(fileInput) fileInput.click(); }catch(_){} };
    const openFolder = () => {
      try{
        if(folderInput && ('webkitdirectory' in folderInput || folderInput.hasAttribute('webkitdirectory'))){
          folderInput.click();
        }else{
          openFiles();
        }
      }catch(_){ openFiles(); }
    };

    bind('btnAddFiles', openFiles);
    bind('btnAddFolder', openFolder);
    bind('btnFiles', openFiles);       // dive screen
    bind('btnFolder', openFolder);     // dive screen

    const dz = el('dropzone');
    if(dz){
      dz.style.cursor = 'pointer';
      dz.addEventListener('click', (e) => {
        e.preventDefault();
        openFiles();
      });
    }
  }

  function bind(id, fn){
    const n = el(id);
    if(n) n.addEventListener('click', (e) => { e.preventDefault(); fn(); });
  }

  /* ───────────────────────────────────────────────────────────────
     §8 · PANEL OPEN / CLOSE
  ─────────────────────────────────────────────────────────────── */

  function toggleLib(){
    const p = el('libPanel');
    if(p) p.classList.toggle('open');
  }
  function setLab(open){
    const p = el('labPanel');
    if(!p) return;
    if(open === undefined) open = !p.classList.contains('open');
    p.classList.toggle('open', open);
  }

  function wirePanels(){
    bind('btnLib', toggleLib);
    const libCollapse = el('libCollapse');
    if(libCollapse){
      libCollapse.addEventListener('click', () => {
        const p = el('libPanel');
        if(p) p.classList.toggle('collapsed');
      });
    }
    const btnLab = el('btnLab');
    if(btnLab){
      btnLab.addEventListener('click', () => setLab());
    }
    const labClose = el('labClose');
    if(labClose){
      labClose.addEventListener('click', () => setLab(false));
    }
    /* the pod's hint says [L] opens the lab — p08 fires 'ui:lab' */
    bus.on('ui:lab', () => setLab());
  }

  /* ───────────────────────────────────────────────────────────────
     §9 · CORE LAB — PRESETS
  ─────────────────────────────────────────────────────────────── */

  function wirePresets(){
    const grid = el('presetGrid');
    if(!grid) return;
    const btns = grid.querySelectorAll('.pbtn');
    for(let i = 0; i < btns.length; i++){
      const b = btns[i];
      b.addEventListener('click', () => applyPreset(b.dataset.preset, true));
    }
  }

  /* apply a named preset: push its values into settings, the sliders,
     and the audio graph.  Manual slider moves call markPreset(null)
     to clear the highlight (a custom mix). */
  function applyPreset(name, highlight){
    const p = CFG.presets[name];
    if(!p) return;
    setSetting('reverb', p.reverb);
    setSetting('room',   p.room);
    setSetting('decay',  p.decay);
    setSetting('bass',   p.bass);
    setSetting('lowmid', p.lowmid);
    setSetting('mid',    p.mid);
    setSetting('highmid',p.highmid);
    setSetting('treble', p.treble);
    pushAudio();
    A.saveSettings();
    markPreset(highlight ? name : null);
    bus.emit('lab:applied', { preset: name });
    A.toast('Preset · ' + (p ? name.toUpperCase() : ''), '⚙');
  }

  function markPreset(name){
    const grid = el('presetGrid');
    if(!grid) return;
    const btns = grid.querySelectorAll('.pbtn');
    for(let i = 0; i < btns.length; i++){
      btns[i].classList.toggle('active', btns[i].dataset.preset === name);
    }
  }

  /* ───────────────────────────────────────────────────────────────
     §10 · CORE LAB — REVERB MATRIX
  ─────────────────────────────────────────────────────────────── */

  function wireReverb(){
    wireSlider('reverbS', 'reverbV', 'reverb',
      (v) => Math.round(v) + '%',
      () => { pushAudio(); });

    wireSlider('roomS', 'roomV', 'room',
      (v) => Math.round(v) + '%',
      () => { pushAudio(); });

    wireSlider('decayS', 'decayV', 'decay',
      (v) => (Math.round(v * 10) / 10).toFixed(1) + 's',
      () => { pushAudio(); });
  }

  /* ───────────────────────────────────────────────────────────────
     §11 · CORE LAB — 5-BAND EQUALIZER
  ─────────────────────────────────────────────────────────────── */

  function wireEQ(){
    const bands = [
      ['bassV',    'bass',    'Bass · 60Hz'],
      ['lowmidV',  'lowmid',  'Low-Mid · 250Hz'],
      ['midV',     'mid',     'Mid · 1kHz'],
      ['highmidV', 'highmid', 'High-Mid · 4kHz'],
      ['trebleV',  'treble',  'Treble · 16kHz']
    ];
    for(let i = 0; i < bands.length; i++){
      const valId = bands[i][0];
      const key   = bands[i][1];
      const label = bands[i][2];
      /* the sliders carry data-band, no id — find them */
      const slider = document.querySelector('.slider[data-band="' + key + '"]');
      if(!slider) continue;
      const valEl = el(valId);
      slider.addEventListener('input', () => {
        const v = cl(parseFloat(slider.value) || 0, -15, 15);
        setSetting(key, v);
        if(valEl) valEl.textContent = dbLabel(v);
        markPreset(null);
        pushAudio();
        A.saveSettings();
      });
    }
  }

  function dbLabel(v){
    const r = Math.round(v);
    return (r > 0 ? '+' : '') + r + 'dB';
  }

  /* ───────────────────────────────────────────────────────────────
     §12 · CORE LAB — MOTION & SPACE (pitch / speed / width)
  ─────────────────────────────────────────────────────────────── */

  function wireMotion(){
    wireSlider('pitchS', 'pitchV', 'pitch',
      (v) => {
        const r = Math.round(v * 10) / 10;
        return (r > 0 ? '+' : '') + (Math.round(r * 10) / 10) + ' st';
      },
      () => { pushAudio(); });

    wireSlider('speedS', 'speedV', 'speed',
      (v) => (Math.round(v * 100) / 100).toFixed(2) + 'x',
      () => { pushAudio(); });

    wireSlider('widthS', 'widthV', 'width',
      (v) => Math.round(v) + '%',
      () => { pushAudio(); });
  }

  /* ───────────────────────────────────────────────────────────────
     §13 · CORE LAB — SYSTEM SWITCHES
  ─────────────────────────────────────────────────────────────── */

  function wireToggles(){
    wireToggle('tglNight', 'night', () => {
      /* night = a gentle loudness compressor feel; we just persist +
         nudge the reverb mix down so the room gets quieter at night */
      pushAudio();
    });
    wireToggle('tglDyn', 'dynColor', () => {
      /* dynamic colors — the GL scene re-reads the palette on the next
         frame; nothing to push into the audio graph */
      if(A.gl && A.gl.applyPalette) { try{ A.gl.applyPalette(); }catch(_){} }
    });
    wireToggle('tglAuto', 'autoPlay', () => {
      /* auto-advance at track end — Aqua.play.onEnded already checks
         S.autoPlay indirectly via the repeat logic; persist only */
    });
  }

  function wireToggle(id, key, onChange){
    const t = el(id);
    if(!t) return;
    t.addEventListener('click', () => {
      S[key] = !S[key];
      t.classList.toggle('on', !!S[key]);
      A.saveSettings();
      if(onChange) onChange();
    });
  }

  /* ───────────────────────────────────────────────────────────────
     §14 · CORE LAB — GPU RENDER TIER
  ─────────────────────────────────────────────────────────────── */

  function wireTier(){
    const row = el('tierRow');
    if(!row) return;
    const btns = row.querySelectorAll('.tier');
    for(let i = 0; i < btns.length; i++){
      const b = btns[i];
      b.addEventListener('click', () => setTier(b.dataset.tier));
    }
  }

  function setTier(name){
    if(!CFG.tiers[name]) return;
    S.tier = name;
    A.saveSettings();
    const row = el('tierRow');
    if(row){
      const btns = row.querySelectorAll('.tier');
      for(let i = 0; i < btns.length; i++){
        btns[i].classList.toggle('active', btns[i].dataset.tier === name);
      }
    }
    /* tell the GL engine to rebuild at the new tier (if it exposes it) */
    if(A.gl && A.gl.setTier){
      try{ A.gl.setTier(name); }catch(_){}
    }else{
      /* fallback: request a full re-init via a bus event the GL part
         can opt into; harmless if nobody is listening */
      bus.emit('gl:tier', name);
    }
    A.toast('Render tier · ' + CFG.tiers[name].label, '▣');
  }

  /* ───────────────────────────────────────────────────────────────
     §15 · CORE LAB — LIVE SIGNAL METERS
  ─────────────────────────────────────────────────────────────── */

  /* two little level bars (L/R) driven by the audio:energy event.
     They live in the lab footer so the engineer can watch the bus
     while tuning. */
  function wireMeters(){
    const lab = el('labPanel');
    if(!lab) return;
    const body = lab.querySelector('.lab-body');
    if(!body) return;

    const wrap = document.createElement('div');
    wrap.className = 'meter-row';
    wrap.innerHTML =
      '<div class="meter"><span class="m-k">IN</span>' +
        '<div class="m-bar"><i class="m-fill" id="mIn"></i></div>' +
        '<span class="m-db" id="mInDb">-∞</span></div>' +
      '<div class="meter"><span class="m-k">OUT</span>' +
        '<div class="m-bar"><i class="m-fill" id="mOut"></i></div>' +
        '<span class="m-db" id="mOutDb">-∞</span></div>';
    body.appendChild(wrap);

    const mIn  = el('mIn');
    const mOut = el('mOut');
    const mInDb  = el('mInDb');
    const mOutDb = el('mOutDb');

    let inLevel = 0, outLevel = 0;
    bus.on('audio:energy', (e) => {
      if(e == null) return;
      inLevel = e;                       // normalised 0..1
    });
    /* output level ≈ input × master gain (account for mute/volume) */
    function tickOut(){
      outLevel = inLevel * (S.muted ? 0 : cl(S.volume, 0, 1));
    }

    let acc = 0;
    function paint(){
      acc++;
      if(acc % 2 !== 0) return;          // ~30fps is plenty for meters
      tickOut();
      if(mIn)  mIn.style.width  = (inLevel  * 100).toFixed(1) + '%';
      if(mOut) mOut.style.width = (outLevel * 100).toFixed(1) + '%';
      const dIn  = inLevel  > 0.0005 ? (20 * Math.log10(inLevel)).toFixed(0)  : '-∞';
      const dOut = outLevel > 0.0005 ? (20 * Math.log10(outLevel)).toFixed(0) : '-∞';
      if(mInDb)  mInDb.textContent  = dIn  + ' dB';
      if(mOutDb) mOutDb.textContent = dOut + ' dB';
      requestAnimationFrame(paint);
    }
    requestAnimationFrame(paint);
  }

  /* ───────────────────────────────────────────────────────────────
     §16 · HUD — STAGE READOUTS (now-tracking metadata)
  ─────────────────────────────────────────────────────────────── */

  function wireStageReadouts(){
    bus.on('audio:track', (t) => {
      if(!t) return;
      const name = el('trName');
      if(name) name.textContent = t.name || '—';
      const sig = el('trSig');
      if(sig) sig.textContent = (t.type === 'video' ? 'VIDEO' : 'AUDIO') + ' · ' + (t.ext || '').toUpperCase();
    });
    bus.on('audio:playing', (on) => {
      const sig = el('trSig');
      if(sig && !Q.current){ sig.textContent = 'STANDBY'; }
      else if(sig){
        sig.textContent = on ? 'LIVE' : 'HOLD';
      }
    });
    bus.on('audio:pause', () => {
      const sig = el('trSig');
      if(sig && Q.current) sig.textContent = 'HOLD';
    });
  }

  /* ───────────────────────────────────────────────────────────────
     §17 · HUD — DOCK PROGRESS FILL + SEEK SYNC
  ───────────────────────────────────────────────────────────────── */

  /* p06 owns the seek *input* (user scrubs).  Here we own the seek
     *position* (the fill + the range value) on a rAF loop, so the
     dock and pod stay in lockstep with the media element without
     fighting p06's seeking flag. */
  function wireProgress(){
    const fill = el('dockFill');
    const dockProg = el('dockProg');
    const seek = el('seek');
    const seekCur = el('seekCur');
    const seekTot = el('seekTot');
    const trTime = el('trTime');
    const trSeq  = el('trSeq');

    let seeking = false;
    if(seek){
      seek.addEventListener('pointerdown', () => { seeking = true; });
      window.addEventListener('pointerup',   () => { seeking = false; });
    }

    function tick(){
      const t = Q.current;
      const dur = (t && isFinite(Q.duration) && Q.duration > 0) ? Q.duration : 0;
      const cur = (t && isFinite(Q.time)) ? Q.time : 0;
      const frac = dur > 0 ? cl(cur / dur, 0, 1) : 0;

      if(fill) fill.style.width = (frac * 100).toFixed(2) + '%';
      if(dockProg && t){
        dockProg.dataset.state = (Q.state === 'playing') ? 'live' : 'hold';
      }
      if(seek && !seeking){
        seek.value = Math.round(frac * 1000);
      }
      if(seekCur) seekCur.textContent = FMT.time(cur);
      if(seekTot) seekTot.textContent = dur > 0 ? FMT.time(dur) : '00:00';
      if(trTime)  trTime.textContent  = FMT.time(cur);
      if(trSeq){
        trSeq.textContent = (Q.list.length
          ? FMT.seq(Q.index + 1, Q.list.length)
          : '--/---');
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ───────────────────────────────────────────────────────────────
     §18 · SETTINGS GLUE + BOOT RESTORE
  ─────────────────────────────────────────────────────────────── */

  /* write a setting, keep the matching slider + value label in sync,
     and (optionally) push into the audio graph. */
  function setSetting(key, value){
    S[key] = value;
    const slider = sliderFor(key);
    if(slider) slider.value = value;
    const label = labelFor(key);
    if(label) label.textContent = fmtFor(key, value);
  }

  function sliderFor(key){
    const map = {
      reverb: 'reverbS', room: 'roomS', decay: 'decayS',
      pitch: 'pitchS', speed: 'speedS', width: 'widthS'
    };
    if(map[key]) return el(map[key]);
    if(key === 'bass' || key === 'lowmid' || key === 'mid' ||
       key === 'highmid' || key === 'treble'){
      return document.querySelector('.slider[data-band="' + key + '"]');
    }
    return null;
  }

  function labelFor(key){
    const map = {
      reverb: 'reverbV', room: 'roomV', decay: 'decayV',
      bass: 'bassV', lowmid: 'lowmidV', mid: 'midV',
      highmid: 'highmidV', treble: 'trebleV',
      pitch: 'pitchV', speed: 'speedV', width: 'widthV'
    };
    return map[key] ? el(map[key]) : null;
  }

  function fmtFor(key, v){
    switch(key){
      case 'reverb':  return Math.round(v) + '%';
      case 'room':    return Math.round(v) + '%';
      case 'decay':   return (Math.round(v * 10) / 10).toFixed(1) + 's';
      case 'bass':
      case 'lowmid':
      case 'mid':
      case 'highmid':
      case 'treble':  return dbLabel(v);
      case 'pitch':   return (Math.round(v * 10) / 10 > 0 ? '+' : '') + (Math.round(v * 10) / 10) + ' st';
      case 'speed':   return (Math.round(v * 100) / 100).toFixed(2) + 'x';
      case 'width':   return Math.round(v) + '%';
      default:        return String(v);
    }
  }

  /* push every relevant setting into the audio graph in one go.
     No-ops safely if the graph isn't built yet (e.g. before the
     first user gesture). */
  function pushAudio(){
    const au = A.audio;
    if(!au) return;
    try{
      au.applyReverb && au.applyReverb();
      au.applyEQ && au.applyEQ();
      au.applySpeedPitch && au.applySpeedPitch();
      au.applyWidth && au.applyWidth();
      au.applyVolume && au.applyVolume();
    }catch(_){}
  }

  /* a single slider binder used by the reverb/motion sections */
  function wireSlider(sliderId, labelId, key, fmt, onInput){
    const slider = el(sliderId);
    if(!slider) return;
    const label = el(labelId);
    slider.addEventListener('input', () => {
      const lo = parseFloat(slider.min) || 0;
      const hi = parseFloat(slider.max) || 100;
      const v = cl(parseFloat(slider.value) || lo, lo, hi);
      setSetting(key, v);
      if(label) label.textContent = fmt(v);
      markPreset(null);
      if(onInput) onInput();
      A.saveSettings();
    });
  }

  /* hydrate every control from the persisted settings so a reload
     restores the last mix. */
  function restore(){
    /* reverb + motion sliders */
    ['reverb','room','decay','pitch','speed','width'].forEach((key) => {
      const slider = sliderFor(key);
      const label  = labelFor(key);
      if(slider) slider.value = S[key];
      if(label)  label.textContent = fmtFor(key, S[key]);
    });
    /* EQ sliders */
    ['bass','lowmid','mid','highmid','treble'].forEach((key) => {
      const slider = sliderFor(key);
      const label  = labelFor(key);
      if(slider) slider.value = S[key];
      if(label)  label.textContent = fmtFor(key, S[key]);
    });
    /* toggles */
    setToggle('tglNight', !!S.night);
    setToggle('tglDyn',   !!S.dynColor);
    setToggle('tglAuto',  !!S.autoPlay);
    /* tier */
    const row = el('tierRow');
    if(row){
      const btns = row.querySelectorAll('.tier');
      for(let i = 0; i < btns.length; i++){
        btns[i].classList.toggle('active', btns[i].dataset.tier === S.tier);
      }
    }
    /* preset highlight: if the current mix matches a preset exactly,
       light it; otherwise leave them all off (custom mix) */
    detectPreset();
  }

  function setToggle(id, on){
    const t = el(id);
    if(t) t.classList.toggle('on', !!on);
  }

  function detectPreset(){
    const mix = [S.reverb, S.room, S.decay, S.bass, S.lowmid, S.mid, S.highmid, S.treble];
    for(const name in CFG.presets){
      const p = CFG.presets[name];
      const ref = [p.reverb, p.room, p.decay, p.bass, p.lowmid, p.mid, p.highmid, p.treble];
      let same = true;
      for(let i = 0; i < 8; i++){
        if(Math.abs(mix[i] - ref[i]) > 0.01){ same = false; break; }
      }
      if(same){ markPreset(name); return; }
    }
    markPreset(null);
  }

  /* ───────────────────────────────────────────────────────────────
     BOOT
  ─────────────────────────────────────────────────────────────── */

  /* pull any tracks that landed in the transport queue from outside
     this part (demo generator, etc.) into the display list */
  function ingestQueue(){
    if(!Q || !Q.list) return;
    for(let i = 0; i < Q.list.length; i++){
      const t = Q.list[i];
      let found = false;
      for(let j = 0; j < LIB.rows.length; j++){
        const r = LIB.rows[j];
        if((t.file && r.file === t.file) || (t.url && r.url === t.url) || (t.src && r.url === t.src)){
          if(!r.url) r.url = t.url || t.src || r.url;
          found = true;
          break;
        }
      }
      if(found) continue;
      LIB.rows.push({
        id: LIB.nextId++,
        file: t.file || t.blob || null,
        name: t.name || ('Track ' + (i + 1)),
        base: baseName(t.name || ('Track ' + (i + 1))),
        ext: t.ext || '',
        type: t.type === 'video' ? 'video' : 'audio',
        folder: t.folder || 'DIRECT',
        size: t.size || (t.file && t.file.size) || 0,
        duration: t.duration || null,
        url: t.url || t.src || null,
        _row: null
      });
    }
    /* prune display rows whose files left the queue */
    const keep = new Set();
    for(let i = 0; i < Q.list.length; i++){
      const t = Q.list[i];
      if(t.file) keep.add(t.file);
      if(t.url) keep.add(t.url);
    }
    for(let i = LIB.rows.length - 1; i >= 0; i--){
      const r = LIB.rows[i];
      if((r.file && keep.has(r.file)) || (r.url && keep.has(r.url))) continue;
      if(r._row && r._row.parentNode) r._row.parentNode.removeChild(r._row);
      LIB.rows.splice(i, 1);
    }
  }

  bus.on('search:input', onSearch);
  bus.on('queue:changed', () => {
    ingestQueue();
    renderChips();
    renderList();
    updateCount();
  });
  bus.on('lib:added', () => {
    ingestQueue();
    renderChips();
    renderList();
    updateCount();
  });

  wireDrop();
  wireInputs();
  wirePanels();
  wirePresets();
  wireReverb();
  wireEQ();
  wireMotion();
  wireToggles();
  wireTier();
  wireMeters();
  wireStageReadouts();
  wireProgress();

  renderChips();
  renderList();
  updateCount();
  restore();

  /* expose the controller for p08 (keyboard) + p09 (demo) */
  A.lib = {
    import: importFiles,
    clear: clearQueue,
    remove: removeFromQueue,
    rows: LIB.rows,
    filter: (q) => onSearch(q),
    render: () => { renderChips(); renderList(); updateCount(); },
    play: playRecord,
    setTier: setTier,
    setLab: setLab,
    toggleLib: toggleLib,
    pushAudio: pushAudio,
    applyPreset: applyPreset
  };

  console.info('[Aqua Lib] library + core lab online — ' + Q.list.length + ' tracks, ' + Object.keys(CFG.presets).length + ' presets');
});

/* ═══════════════ PART: p08_input.js ═══════════════ */

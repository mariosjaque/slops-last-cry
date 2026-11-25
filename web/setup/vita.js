/*
 * PS Vita export: turns an already set-up Slop's Last Cry folder into the data folder the Vita app
 * reads (ux0:data/slc/). Runs in the setup page on PC.
 *   story.json       pages pre-parsed into blocks and text runs, plus their scripts and game tables
 *   img/...          backgrounds and interface pictures (big ones scaled down for the Vita)
 *   audio/*.slco     every sound as Opus packets in a tiny container the app decodes sample-exactly
 *   movies/*.slcm    movies as JPEG frames (+ .slco for their sound)
 * Nothing here is sent anywhere; it all stays in the folder the player chose.
 */
(function () {
  'use strict';
  const C = window.SLCConvert;
  const APP = 'ink-en.app/', OUT = 'slc-vita/';
  const td = new TextDecoder();

  // ---------- page HTML -> blocks ----------
  const INLINE_STYLE = { b: { b: 1 }, strong: { b: 1 }, i: { i: 1 }, em: { i: 1 } };
  function runsOf(node, st, out, spanId) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { const s = n.nodeValue.replace(/\s+/g, ' '); if (s) out.push(Object.assign({ s }, st, spanId ? { id: spanId } : {})); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || n.getAttribute('name') === 'charge') continue;
      if (tag === 'br') { out.push({ br: 1 }); continue; }
      if (tag === 'var') { out.push(Object.assign({ v: n.className === 'char1' ? 1 : 2 }, st)); continue; }
      if (tag === 'img') { const src = (n.getAttribute('src') || '').split('/').pop(); if (src && !n.classList.contains('premium')) out.push({ img: src }); continue; }
      const s2 = Object.assign({}, st, INLINE_STYLE[tag] || {});
      if (n.classList.contains('selection_en')) { s2.b = 1; s2.i = 1; }
      if (n.classList.contains('close_gm')) s2.col = '#ffff00';
      const fc = n.getAttribute('color'); if (fc) s2.col = fc;
      const before = out.length;
      runsOf(n, s2, out, n.id || spanId);
      if (n.id && out.length === before) out.push({ s: '', id: n.id });   // empty span filled in later by the page script
    }
    return out;
  }
  const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'dt', 'dd', 'pre', 'center', 'li']);
  function hasBlockChild(el) { for (const c of el.children) { const t = c.tagName.toLowerCase(); if (BLOCK_TAGS.has(t) || ['ul', 'ol', 'dl', 'div', 'section', 'hr', 'table', 'p'].includes(t)) return true; } return false; }
  function parseBlocks(root) {
    const blocks = [];
    const walk = (el, ids) => {
      let pending = [];
      const flush = () => { if (pending.some(r => r.s && r.s.trim() || r.v)) blocks.push({ k: 'p', c: '', ids, r: pending }); pending = []; };
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { const s = n.nodeValue.replace(/\s+/g, ' '); if (s.trim()) pending.push({ s }); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'head' || n.getAttribute('name') === 'charge') continue;
        const myIds = n.id ? ids.concat(n.id) : ids;
        if (tag === 'br') { pending.length ? pending.push({ br: 1 }) : blocks.push({ k: 'sp', ids }); continue; }
        if (tag === 'hr') { flush(); blocks.push({ k: 'hr', c: n.className || '', ids: myIds }); continue; }
        if (tag === 'img') { flush(); const src = (n.getAttribute('src') || '').split('/').pop(); if (src && !n.classList.contains('premium')) blocks.push({ k: 'img', src, ids: myIds }); continue; }
        if (tag === 'ul' || tag === 'ol') {
          flush();
          const items = [];
          for (const li of n.children) {
            if (li.getAttribute('name') === 'charge') continue;
            const sel = li.getAttribute('kmsel');
            if (sel) items.push({ id: li.id || '', sel, c: li.className || 'select', r: runsOf(li, {}, []), ids: li.id ? myIds.concat(li.id) : myIds });
            else blocks.push({ k: 'p', c: li.className || 'li', ids: li.id ? myIds.concat(li.id) : myIds, r: runsOf(li, {}, []) });
          }
          if (items.length) blocks.push({ k: 'ul', c: n.className || '', ids: myIds, items });
          continue;
        }
        if (BLOCK_TAGS.has(tag) || (tag === 'div' && !hasBlockChild(n))) {
          flush();
          if (hasBlockChild(n) && tag !== 'li') { walk(n, myIds); continue; }
          const r = runsOf(n, {}, []);
          blocks.push({ k: 'p', c: n.className || (tag === 'p' || tag === 'div' ? '' : tag), ids: myIds, r });
          continue;
        }
        if (['section', 'div', 'dl', 'body', 'html', 'table', 'tbody', 'tr', 'td', 'setcion'].includes(tag) || hasBlockChild(n)) { flush(); walk(n, myIds); continue; }
        // inline element at block level
        pending.push(...runsOf({ childNodes: [n] }, {}, []));
      }
      flush();
    };
    walk(root, []);
    // pictures inside paragraphs become blocks of their own
    const out = [];
    for (const b of blocks) {
      if (b.k !== 'p' || !b.r.some(r => r.img)) { out.push(b); continue; }
      let part = [];
      const flush = () => { if (part.some(r => (r.s && r.s.trim()) || r.v)) out.push({ k: 'p', c: b.c, ids: b.ids, r: part }); part = []; };
      for (const r of b.r) { if (r.img) { flush(); out.push({ k: 'img', src: r.img, ids: b.ids }); } else part.push(r); }
      flush();
    }
    return out;
  }
  function parsePage(html) {
    const scripts = [];
    const body = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (m, s) => { scripts.push(s); return ''; });
    const doc = new DOMParser().parseFromString('<!doctype html><html><body>' + body + '</body></html>', 'text/html');
    const page = { b: parseBlocks(doc.body), s: scripts.join('\n') };
    const m = html.match(/\/ifnot\s+(\d+)\s+(\w+)/); if (m) page.ifnot = [m[1], m[2]];
    const j = html.match(/\/jump\s+(\w+)/); if (j) page.jump = j[1];
    return page;
  }

  // ---------- images ----------
  async function shrink(bytes, name, maxw) {
    const blob = new Blob([bytes]);
    let bmp; try { bmp = await createImageBitmap(blob); } catch (e) { return bytes; }
    if (bmp.width <= maxw) { bmp.close(); return bytes; }
    const w = maxw, h = Math.round(bmp.height * maxw / bmp.width);
    const cv = new OffscreenCanvas(w, h); cv.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close();
    const out = await cv.convertToBlob(/\.png$/i.test(name) ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.88 });
    return new Uint8Array(await out.arrayBuffer());
  }

  // ---------- audio ----------
  async function slco(channels) {
    const r = await C.encodeOpusWebm(channels, true);
    let preSkip = 312;
    if (r.head && r.head.length >= 12 && td.decode(r.head.subarray(0, 8)) === 'OpusHead') preSkip = r.head[10] | (r.head[11] << 8);
    const total = channels[0].length, size = 20 + r.packets.reduce((s, p) => s + 2 + p.d.length, 0);
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    out.set([83, 76, 67, 79]); out[4] = 1; out[5] = r.nch; dv.setUint16(6, preSkip, true); dv.setUint32(8, 48000, true);
    dv.setUint32(12, total, true); dv.setUint32(16, r.packets.length, true);
    let p = 20;
    for (const k of r.packets) { dv.setUint16(p, k.d.length, true); out.set(k.d, p + 2); p += 2 + k.d.length; }
    return out;
  }
  async function decodeAny(name, b) {
    if (/\.aif$/i.test(name)) return C.resample(C.decodeAifc(b), 48000);
    if (C.ALAC_TRACKS.test(name)) return C.resample(ALAC.decodeM4A(b), 48000);
    return C.decodeCompressed(b);
  }

  // ---------- movies ----------
  async function movieFrames(bytes, name, fps) {
    const url = URL.createObjectURL(new Blob([bytes], { type: /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4' }));
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('cannot decode ' + name)); });
    const dur = v.duration, w = Math.min(544, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
    const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d'), frames = [];
    for (let t = 0; t < dur - 0.001; t += 1 / fps) {
      v.currentTime = t; await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      g.drawImage(v, 0, 0, w, h);
      frames.push(new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer()));
    }
    URL.revokeObjectURL(url);
    const head = 16 + (frames.length + 1) * 4, size = head + frames.reduce((s, f) => s + f.length, 0);
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    out.set([83, 76, 67, 77]); dv.setUint32(4, Math.round(fps * 1000), true); dv.setUint32(8, frames.length, true);
    dv.setUint16(12, w, true); dv.setUint16(14, h, true);
    let o = 0; frames.forEach((f, i) => { dv.setUint32(16 + i * 4, o, true); out.set(f, head + o); o += f.length; });
    dv.setUint32(16 + frames.length * 4, o, true);
    return out;
  }

  // ---------- main ----------
  async function exportVita(fs, log) {
    log = log || (() => { });
    const step = (name, i, n) => log({ step: name, i, n });
    const dataSrc = await fs.read('engine/data.js');
    if (!dataSrc) throw new Error('Run the normal setup in this folder first (engine/data.js is missing).');
    const js = td.decode(dataSrc), D = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(';')));
    const root = await fs.list(APP), lproj = await fs.list(APP + 'en.lproj/'), eng = await fs.list('engine/img/');

    // story
    const pages = {}, ids = Object.keys(D.pages);
    for (let i = 0; i < ids.length; i++) { if (i % 25 === 0) step('vita story', i, ids.length); pages[ids[i]] = parsePage(D.pages[ids[i]]); }
    const help = {};
    for (const h of ['howtoplay', 'howtoplay_intro', 'productinfo', 'product']) {
      const b = await fs.read(APP + 'en.lproj/' + h + '.html'); if (b) help[h] = parsePage(td.decode(b)).b;
    }
    const movies = new Set();
    for (const k in D.pages) for (const m of D.pages[k].matchAll(/playMovie\w*\(\s*['"]([^'"]+)['"]/g)) movies.add(m[1]);
    const audioSrc = root.filter(n => /\.(aif|m4a|mp3|wav)$/i.test(n) || (/\.mp4$/i.test(n) && !movies.has(n)));
    const story = {
      start: D.start, chapters: D.chapters, pageload: D.pageload, loops: D.loops, strings: D.strings, endings: D.endings,
      pages, help, audio: audioSrc, movies: Array.from(movies).filter(m => root.includes(m)), images: [], version: 1
    };

    // images
    const imgs = [];
    lproj.filter(n => /\.(jpe?g|png)$/i.test(n) && !/~ipad/i.test(n)).forEach(n => imgs.push(['en.lproj/' + n, APP + 'en.lproj/' + n, 640]));
    root.filter(n => /\.(jpe?g|png)$/i.test(n) && !/^(Default|Icon|iTunes)/i.test(n)).forEach(n => imgs.push([n, APP + n, /pagejump_bg/.test(n) ? 640 : 1024]));
    eng.filter(n => /\.png$/i.test(n)).forEach(n => imgs.push(['engine/' + n, 'engine/img/' + n, 1024]));
    for (let i = 0; i < imgs.length; i++) {
      if (i % 10 === 0) step('vita images', i, imgs.length);
      const [key, src, maxw] = imgs[i];
      const b = await fs.read(src); if (!b || C.isCgBI(b)) continue;
      await fs.write(OUT + 'img/' + key, await shrink(b, key, maxw));
      story.images.push(key);
    }
    await fs.write(OUT + 'story.json', JSON.stringify(story));

    // audio
    const have = new Set(await fs.list(OUT + 'audio/'));
    for (let i = 0; i < audioSrc.length; i++) {
      step('vita music', i, audioSrc.length);
      const n = audioSrc[i]; if (have.has(n + '.slco')) continue;
      const b = await fs.read(APP + n); if (!b) continue;
      try { await fs.write(OUT + 'audio/' + n + '.slco', await slco(await decodeAny(n, b))); } catch (e) { log({ warn: n + ': ' + e.message }); }
    }
    // movies
    const mv = story.movies;
    for (let i = 0; i < mv.length; i++) {
      step('vita movies', i, mv.length);
      const b = await fs.read(APP + mv[i]); if (!b) continue;
      try { await fs.write(OUT + 'movies/' + mv[i] + '.slcm', await movieFrames(b, mv[i], 15)); } catch (e) { log({ warn: mv[i] + ': ' + e.message }); }
      try { await fs.write(OUT + 'movies/' + mv[i] + '.slco', await slco(await C.decodeCompressed(b))); } catch (e) { /* silent movie */ }
    }
    step('done', 1, 1);
  }
  window.SLCVita = { exportVita, parsePage };
})();

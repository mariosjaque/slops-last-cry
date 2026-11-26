/*
 * New 3DS export: turns an already set-up Slop's Last Cry folder into the data folder the 3DS app
 * reads (sdmc:/3ds/slc/). Runs in the setup page on PC, after vita.js (it shares its page parser).
 *   story.json       pages pre-parsed into blocks and text runs (same as the Vita), plus the
 *                    original size of every picture that was scaled down
 *   img/...          pictures scaled to the 3DS screens
 *   audio/*.slca     every sound as 32 kHz IMA ADPCM, cheap enough to mix many at once on the console
 *   movies/*.slcm    movies as small JPEG frames (+ .slca for their sound)
 * Nothing here is sent anywhere; it all stays in the folder the player chose.
 */
(function () {
  'use strict';
  const C = window.SLCConvert;
  const APP = 'ink-en.app/', OUT = 'slc-3ds/', RATE = 32000, BF = 1024;
  const td = new TextDecoder();

  // ---------- pictures ----------
  // Big enough to cover a 240x400 portrait screen, never larger than the original.
  const fitScale = (w, h) => Math.min(1, Math.max(240 / w, 400 / h));
  async function shrink(bytes, name, vitaMax) {
    const blob = new Blob([bytes]);
    let bmp; try { bmp = await createImageBitmap(blob); } catch (e) { return { bytes, size: null }; }
    // the size the Vita version sees (pages are laid out with it)
    const lw = bmp.width > vitaMax ? vitaMax : bmp.width, lh = bmp.width > vitaMax ? Math.round(bmp.height * vitaMax / bmp.width) : bmp.height;
    const s = fitScale(bmp.width, bmp.height);
    if (s >= 1) { const scaled = lw !== bmp.width; bmp.close(); return { bytes, size: scaled ? [lw, lh] : null }; }
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const cv = new OffscreenCanvas(w, h); const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h); bmp.close();
    const out = await cv.convertToBlob(/\.png$/i.test(name) ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.9 });
    return { bytes: new Uint8Array(await out.arrayBuffer()), size: [lw, lh] };
  }

  // ---------- sound: IMA ADPCM, blocks of 1024 frames that each decode on their own ----------
  const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  function slca(channels) {
    const nch = Math.min(2, channels.length), total = channels[0].length, nblk = Math.max(1, Math.ceil(total / BF));
    const bsize = nch * (4 + BF / 2);
    const out = new Uint8Array(24 + bsize * nblk), dv = new DataView(out.buffer);
    out.set([83, 76, 67, 65]); out[4] = 1; out[5] = nch;
    dv.setUint32(8, RATE, true); dv.setUint32(12, total, true); dv.setUint32(16, BF, true); dv.setUint32(20, nblk, true);
    for (let c = 0; c < nch; c++) {
      const x = channels[c]; let pred = 0, idx = 0;
      for (let b = 0; b < nblk; b++) {
        let p = 24 + b * bsize + c * (4 + BF / 2);
        dv.setInt16(p, pred, true); out[p + 2] = idx; p += 4;
        for (let i = 0; i < BF; i++) {
          const k = b * BF + i;
          const s = k < total ? Math.max(-32768, Math.min(32767, Math.round(x[k] * 32767))) : 0;
          const step = STEP[idx];
          let diff = s - pred, code = 0;
          if (diff < 0) { code = 8; diff = -diff; }
          let st = step;
          if (diff >= st) { code |= 4; diff -= st; } st >>= 1;
          if (diff >= st) { code |= 2; diff -= st; } st >>= 1;
          if (diff >= st) code |= 1;
          // track exactly what the decoder will produce
          let d = step >> 3; if (code & 1) d += step >> 2; if (code & 2) d += step >> 1; if (code & 4) d += step;
          pred += (code & 8) ? -d : d;
          if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
          idx += IDX[code]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
          if (i & 1) out[p + (i >> 1)] |= code << 4; else out[p + (i >> 1)] = code;
        }
      }
    }
    return out;
  }
  async function decodeAny(name, b) {
    if (/\.aif$/i.test(name)) return C.resample(C.decodeAifc(b), RATE);
    if (C.ALAC_TRACKS.test(name)) return C.resample(ALAC.decodeM4A(b), RATE);
    return C.resample({ sampleRate: 48000, channels: await C.decodeCompressed(b) }, RATE);
  }

  // ---------- movies ----------
  async function movieFrames(bytes, name, fps) {
    const url = URL.createObjectURL(new Blob([bytes], { type: /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4' }));
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('cannot decode ' + name)); });
    const s = fitScale(v.videoWidth, v.videoHeight);
    const dur = v.duration, w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
    const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d'), frames = [];
    for (let t = 0; t < dur - 0.001; t += 1 / fps) {
      v.currentTime = t; await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      g.drawImage(v, 0, 0, w, h);
      frames.push(new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer()));
    }
    URL.revokeObjectURL(url);
    const head = 16 + (frames.length + 1) * 4, size = head + frames.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    out.set([83, 76, 67, 77]); dv.setUint32(4, Math.round(fps * 1000), true); dv.setUint32(8, frames.length, true);
    dv.setUint16(12, w, true); dv.setUint16(14, h, true);
    let o = 0; frames.forEach((f, i) => { dv.setUint32(16 + i * 4, o, true); out.set(f, head + o); o += f.length; });
    dv.setUint32(16 + frames.length * 4, o, true);
    return out;
  }

  // ---------- main ----------
  async function export3ds(fs, log) {
    log = log || (() => { });
    const step = (name, i, n) => log({ step: name, i, n });
    const parsePage = window.SLCVita.parsePage;
    const dataSrc = await fs.read('engine/data.js');
    if (!dataSrc) throw new Error('Run the normal setup in this folder first (engine/data.js is missing).');
    const js = td.decode(dataSrc), D = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(';')));
    const root = await fs.list(APP), lproj = await fs.list(APP + 'en.lproj/'), eng = await fs.list('engine/img/');
    // story (the same pre-parsed pages as the Vita)
    const pages = {}, ids = Object.keys(D.pages);
    for (let i = 0; i < ids.length; i++) { if (i % 25 === 0) step('3ds story', i, ids.length); pages[ids[i]] = parsePage(D.pages[ids[i]]); }
    const help = {};
    for (const h of ['howtoplay', 'howtoplay_intro', 'productinfo', 'product']) {
      const b = await fs.read(APP + 'en.lproj/' + h + '.html'); if (b) help[h] = parsePage(td.decode(b)).b;
    }
    const movies = new Set();
    for (const k in D.pages) for (const m of D.pages[k].matchAll(/playMovie\w*\(\s*['"]([^'"]+)['"]/g)) movies.add(m[1]);
    const audioSrc = root.filter(n => /\.(aif|m4a|mp3|wav)$/i.test(n) || (/\.mp4$/i.test(n) && !movies.has(n)));
    const story = {
      start: D.start, chapters: D.chapters, pageload: D.pageload, loops: D.loops, strings: D.strings, endings: D.endings,
      pages, help, audio: audioSrc, movies: Array.from(movies).filter(m => root.includes(m)), images: [], imgsize: {}, version: 1
    };
    // pictures (vitaMax: the width the Vita version scales each one to, kept as the layout size)
    const imgs = [];
    lproj.filter(n => /\.(jpe?g|png)$/i.test(n) && !/~ipad/i.test(n)).forEach(n => imgs.push(['en.lproj/' + n, APP + 'en.lproj/' + n, 640]));
    root.filter(n => /\.(jpe?g|png)$/i.test(n) && !/^(Default|Icon|iTunes)/i.test(n)).forEach(n => imgs.push([n, APP + n, /pagejump_bg/.test(n) ? 640 : 1024]));
    eng.filter(n => /\.png$/i.test(n)).forEach(n => imgs.push(['engine/' + n, 'engine/img/' + n, 1024]));
    for (let i = 0; i < imgs.length; i++) {
      if (i % 10 === 0) step('3ds images', i, imgs.length);
      const [key, src, vitaMax] = imgs[i];
      const b = await fs.read(src); if (!b || C.isCgBI(b)) continue;
      const r = await shrink(b, key, vitaMax);
      await fs.write(OUT + 'img/' + key, r.bytes);
      if (r.size) story.imgsize[key] = r.size;
      story.images.push(key);
    }
    await fs.write(OUT + 'story.json', JSON.stringify(story));
    // sound
    const have = new Set(await fs.list(OUT + 'audio/'));
    for (let i = 0; i < audioSrc.length; i++) {
      step('3ds music', i, audioSrc.length);
      const n = audioSrc[i]; if (have.has(n + '.slca')) continue;
      const b = await fs.read(APP + n); if (!b) continue;
      try { await fs.write(OUT + 'audio/' + n + '.slca', slca(await decodeAny(n, b))); } catch (e) { log({ warn: n + ': ' + e.message }); }
    }
    // movies
    const mv = story.movies;
    for (let i = 0; i < mv.length; i++) {
      step('3ds movies', i, mv.length);
      const b = await fs.read(APP + mv[i]); if (!b) continue;
      try { await fs.write(OUT + 'movies/' + mv[i] + '.slcm', await movieFrames(b, mv[i], 15)); } catch (e) { log({ warn: mv[i] + ': ' + e.message }); }
      try { await fs.write(OUT + 'movies/' + mv[i] + '.slca', slca(await C.resample({ sampleRate: 48000, channels: await C.decodeCompressed(b) }, RATE))); } catch (e) { /* silent movie */ }
    }
    step('done', 1, 1);
  }
  window.SLC3DS = { export3ds, slca };
})();

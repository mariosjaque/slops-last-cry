/*
 * Slop's Last Cry: converts the files of a Banshee's Last Cry install (ink-en.app, from the iOS
 * IPA) into what the web engine needs. Runs in the browser (PC setup page) and inside the Android
 * app's WebView. Nothing from the game is shipped with this code; everything is made from the
 * user's own copy.
 *
 * Output, relative to the game folder:
 *   ink-en.app/...        the app's files, with iOS-only "CgBI" PNGs rewritten as standard PNGs
 *   engine/data.js        scenes, chapter map, backgrounds, loop points and interface strings
 *   engine/img/*.png      title, logos, Table of Contents and help images used by the engine
 *   engine/audio/*.webm   the .aif (IMA4) and Apple Lossless .m4a tracks, re-encoded as Opus
 *
 * The caller provides a small file-system object:
 *   list(dir)            -> Promise<string[]>   file names directly inside dir ("" = game folder)
 *   read(path)           -> Promise<Uint8Array|null>
 *   write(path, data)    -> Promise              data: Uint8Array or string
 */
(function () {
  const APP = 'ink-en.app/';
  const td = new TextDecoder('utf-8');
  const text = (b) => td.decode(b).replace(/\r\n?/g, '\n');

  // ---------- Binary property lists (bplist00) ----------
  function parseBplist(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (td.decode(b.subarray(0, 8)) !== 'bplist00') throw new Error('not a binary plist');
    const t = b.length - 32;
    const offSize = b[t + 6], refSize = b[t + 7];
    const numObj = Number(dv.getBigUint64(t + 8)), top = Number(dv.getBigUint64(t + 16)), tableOff = Number(dv.getBigUint64(t + 24));
    const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };
    const offsets = []; for (let i = 0; i < numObj; i++) offsets.push(uint(tableOff + i * offSize, offSize));
    const cache = new Map();
    function obj(i) {
      if (cache.has(i)) return cache.get(i);
      const p = offsets[i], m = b[p], hi = m >> 4, lo = m & 15;
      let len = lo, q = p + 1;
      const readLen = () => { if (lo === 15) { const im = b[q]; const n = 1 << (im & 15); len = uint(q + 1, n); q += 1 + n; } };
      let v;
      switch (hi) {
        case 0: v = lo === 8 ? false : lo === 9 ? true : null; break;
        case 1: { const n = 1 << lo; v = n === 8 ? Number(dv.getBigInt64(q)) : uint(q, n); break; }
        case 2: v = lo === 2 ? dv.getFloat32(q) : dv.getFloat64(q); break;
        case 3: v = new Date((dv.getFloat64(q) + 978307200) * 1000); break;
        case 4: readLen(); v = b.slice(q, q + len); break;
        case 5: readLen(); v = String.fromCharCode.apply(null, b.subarray(q, q + len)); break;
        case 6: { readLen(); let s = ''; for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint16(q + k * 2)); v = s; break; }
        case 8: v = uint(q, lo + 1); break;
        case 10: { readLen(); v = []; cache.set(i, v); for (let k = 0; k < len; k++) v.push(obj(uint(q + k * refSize, refSize))); return v; }
        case 13: {
          readLen(); v = {}; cache.set(i, v);
          for (let k = 0; k < len; k++) v[obj(uint(q + k * refSize, refSize))] = obj(uint(q + (len + k) * refSize, refSize));
          return v;
        }
        default: throw new Error('unsupported plist object ' + m.toString(16));
      }
      cache.set(i, v);
      return v;
    }
    return obj(top);
  }

  // ---------- iOS "CgBI" PNGs ----------
  // Xcode stores PNGs with raw deflate data, BGRA byte order and premultiplied alpha.
  async function inflateRaw(data) {
    const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function deflate(data) {
    const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(parts) { let c = 0xffffffff; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer), tb = new TextEncoder().encode(type);
    dv.setUint32(0, data.length); out.set(tb, 4); out.set(data, 8); dv.setUint32(8 + data.length, crc32([tb, data]));
    return out;
  }
  function isCgBI(b) { return b && b.length > 16 && td.decode(b.subarray(12, 16)) === 'CgBI'; }
  // Returns { w, h, rgba } for a PNG (standard or CgBI, 8-bit RGBA/RGB only).
  async function decodePng(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 8, cg = false, w = 0, h = 0, ct = 6, idat = [];
    while (p < b.length) {
      const len = dv.getUint32(p), type = td.decode(b.subarray(p + 4, p + 8)), data = b.subarray(p + 8, p + 8 + len);
      if (type === 'CgBI') cg = true;
      else if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); ct = b[p + 17]; if (b[p + 16] !== 8) throw new Error('unsupported bit depth'); }
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    const all = new Uint8Array(idat.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of idat) { all.set(a, o); o += a.length; }
    const raw = cg ? await inflateRaw(all) : await new Response(new Blob([all]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer().then(x => new Uint8Array(x));
    const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
    if (!bpp) throw new Error('unsupported color type ' + ct);
    const stride = w * bpp, px = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[dst + x - bpp] : 0, up = y ? px[dst - stride + x] : 0, c = (x >= bpp && y) ? px[dst - stride + x - bpp] : 0;
        let v = raw[src + x];
        if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
        else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : pb <= pc ? up : c; }
        px[dst + x] = v & 255;
      }
    }
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += bpp) {
      let r = px[j], g = px[j + 1], bl = px[j + 2]; const al = bpp === 4 ? px[j + 3] : 255;
      if (cg) { const t = r; r = bl; bl = t; if (al && al < 255) { r = Math.min(255, Math.round(r * 255 / al)); g = Math.min(255, Math.round(g * 255 / al)); bl = Math.min(255, Math.round(bl * 255 / al)); } }
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = bl; rgba[i * 4 + 3] = al;
    }
    return { w, h, rgba };
  }
  async function encodePng(img) {
    const { w, h, rgba } = img, raw = new Uint8Array(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of parts) { out.set(a, o); o += a.length; }
    return out;
  }
  function crop(img, x0, y0, x1, y1) {
    const w = x1 - x0, h = y1 - y0, rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) rgba.set(img.rgba.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x1) * 4), y * w * 4);
    return { w, h, rgba };
  }
  // Bounding box of pixels that differ from the corner colour (or are not transparent).
  function contentBox(img, byAlpha) {
    const { w, h, rgba } = img; let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const br = rgba[0], bg = rgba[1], bb = rgba[2];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const on = byAlpha ? rgba[i + 3] > 0 : (Math.abs(rgba[i] - br) + Math.abs(rgba[i + 1] - bg) + Math.abs(rgba[i + 2] - bb)) / 3 > 12;
      if (on) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return [x0, y0, x1 + 1, y1 + 1];
  }

  // ---------- Audio ----------
  // AIFC with Apple IMA4 ADPCM (34-byte packets of 64 samples per channel).
  const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const IMA_IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  function decodeAifc(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let ch = 0, frames = 0, rate = 0, comp = '', ssnd = -1, ssndLen = 0;
    for (let p = 12; p + 8 <= b.length;) {
      const id = td.decode(b.subarray(p, p + 4)), len = dv.getUint32(p + 4);
      if (id === 'COMM') {
        ch = dv.getUint16(p + 8); frames = dv.getUint32(p + 10);
        const exp = dv.getUint16(p + 16) & 0x7fff, mant = dv.getUint32(p + 18);
        rate = Math.round(mant * Math.pow(2, exp - 16383 - 31));
        comp = td.decode(b.subarray(p + 26, p + 30));
      } else if (id === 'SSND') { ssnd = p + 16 + dv.getUint32(p + 8); ssndLen = len - 8; }
      p += 8 + len + (len & 1);
    }
    if (comp !== 'ima4') throw new Error('unsupported AIFC compression ' + comp);
    const out = []; for (let c = 0; c < ch; c++) out.push(new Float32Array(frames * 64));
    let q = ssnd;
    const st = []; for (let c = 0; c < ch; c++) st.push({ pred: 0, idx: -1 });
    for (let f = 0; f < frames; f++) for (let c = 0; c < ch; c++) {
      const head = dv.getUint16(q);
      let hp = (head & 0xff80); if (hp & 0x8000) hp -= 0x10000;
      const hi = head & 0x7f, S = st[c];
      // Like Apple's and FFmpeg's decoders, keep the running predictor unless the packet header differs a lot.
      if (S.idx !== hi || Math.abs(hp - S.pred) > 0x7f) { S.pred = hp; S.idx = hi; }
      let pred = S.pred, idx = S.idx > 88 ? 88 : S.idx;
      const o = out[c], base = f * 64;
      for (let i = 0; i < 32; i++) {
        const byte = b[q + 2 + i];
        for (let k = 0; k < 2; k++) {
          const nib = k ? byte >> 4 : byte & 15, step = IMA_STEP[idx];
          let diff = step >> 3; if (nib & 1) diff += step >> 2; if (nib & 2) diff += step >> 1; if (nib & 4) diff += step;
          if (nib & 8) pred -= diff; else pred += diff;
          if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
          idx += IMA_IDX[nib]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
          o[base + i * 2 + k] = pred / 32768;
        }
      }
      S.pred = pred; S.idx = idx;
      q += 34;
    }
    return { sampleRate: rate, channels: out };
  }
  async function resample(pcm, rate) {
    if (pcm.sampleRate === rate) return pcm.channels;
    const len = Math.ceil(pcm.channels[0].length * rate / pcm.sampleRate);
    const ctx = new OfflineAudioContext(pcm.channels.length, len, rate);
    const buf = ctx.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
    pcm.channels.forEach((c, i) => buf.copyToChannel(c, i));
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    const out = await ctx.startRendering();
    return pcm.channels.map((_, i) => out.getChannelData(i));
  }
  // Encodes 48 kHz float channels as Opus and returns a WebM file.
  async function encodeOpusWebm(channels, rawOnly) {
    const rate = 48000, nch = channels.length, total = channels[0].length;
    const packets = []; let head = null, err = null;
    const enc = new AudioEncoder({
      output: (ch, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !head) head = new Uint8Array(meta.decoderConfig.description);
        const d = new Uint8Array(ch.byteLength); ch.copyTo(d); packets.push({ t: ch.timestamp, d });
      },
      error: (e) => { err = e; }
    });
    enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: nch, bitrate: 128000, opus: { frameDuration: 20000 } });
    const block = rate;   // feed one second at a time
    for (let s = 0; s < total; s += block) {
      const n = Math.min(block, total - s), planar = new Float32Array(n * nch);
      for (let c = 0; c < nch; c++) planar.set(channels[c].subarray(s, s + n), c * n);
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: nch, timestamp: Math.round(s * 1e6 / rate), data: planar }));
      if (enc.encodeQueueSize > 20) await new Promise(r => setTimeout(r, 0));
    }
    await enc.flush(); enc.close();
    if (err) throw err;
    if (rawOnly) return { packets, head, nch };
    let preSkip = 312;
    if (head && head.length >= 12 && td.decode(head.subarray(0, 8)) === 'OpusHead') preSkip = head[10] | (head[11] << 8);
    if (!head || td.decode(head.subarray(0, 8)) !== 'OpusHead') {
      head = new Uint8Array(19); head.set(new TextEncoder().encode('OpusHead')); head[8] = 1; head[9] = nch;
      head[10] = preSkip & 255; head[11] = preSkip >> 8; new DataView(head.buffer).setUint32(12, rate, true);
    }
    return webm(packets, head, nch, rate, preSkip, total / rate);
  }
  // Minimal WebM (Matroska) writer for one Opus track, with cues so the engine can seek to loop points.
  function webm(packets, opusHead, nch, rate, preSkip, durSec) {
    const vint = (n) => { for (let l = 1; l <= 8; l++) if (n < Math.pow(2, 7 * l) - 1) { const o = new Uint8Array(l); let v = n; for (let i = l - 1; i >= 0; i--) { o[i] = v & 255; v = Math.floor(v / 256); } o[0] |= 1 << (8 - l); return o; } throw new Error('size'); };
    const idb = (id) => { const a = []; while (id > 0) { a.unshift(id & 255); id = Math.floor(id / 256); } return new Uint8Array(a); };
    const cat = (arr) => { const n = arr.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; };
    const el = (id, data) => cat([idb(id), vint(data.length), data]);
    const u = (id, v, fixed) => { const a = []; do { a.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0); while (fixed && a.length < fixed) a.unshift(0); return el(id, new Uint8Array(a)); };
    const f64 = (id, v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b); };
    const str = (id, s) => el(id, new TextEncoder().encode(s));
    const ebml = el(0x1A45DFA3, cat([u(0x4286, 1), u(0x42F7, 1), u(0x42F2, 4), u(0x42F3, 8), str(0x4282, 'webm'), u(0x4287, 4), u(0x4285, 2)]));
    const info = el(0x1549A966, cat([u(0x2AD7B1, 1000000), str(0x4D80, 'slops-last-cry'), str(0x5741, 'slops-last-cry'), f64(0x4489, durSec * 1000)]));
    const tracks = el(0x1654AE6B, el(0xAE, cat([u(0xD7, 1), u(0x73C5, 1), u(0x83, 2), str(0x86, 'A_OPUS'), el(0x63A2, opusHead),
      u(0x56AA, Math.round(preSkip * 1e9 / rate)), u(0x56BB, 80000000), el(0xE1, cat([f64(0xB5, rate), u(0x9F, nch)]))])));
    // clusters of about 5 seconds
    const clusters = [], cues = [];
    for (let i = 0; i < packets.length;) {
      const t0 = Math.round(packets[i].t / 1000), blocks = [];
      while (i < packets.length && Math.round(packets[i].t / 1000) - t0 < 5000) {
        const rel = Math.round(packets[i].t / 1000) - t0, hb = new Uint8Array(4);
        hb[0] = 0x81; hb[1] = (rel >> 8) & 255; hb[2] = rel & 255; hb[3] = 0x80;
        blocks.push(el(0xA3, cat([hb, packets[i].d]))); i++;
      }
      clusters.push({ t: t0, bytes: el(0x1F43B675, cat([u(0xE7, t0)].concat(blocks))) });
    }
    // layout: SeekHead, Info, Tracks, Clusters, Cues (positions relative to the segment data)
    const seekEntry = (id, pos) => el(0x4DBB, cat([el(0x53AB, idb(id)), u(0x53AC, pos, 8)]));
    const seekLen = el(0x114D9B74, cat([seekEntry(0x1549A966, 0), seekEntry(0x1654AE6B, 0), seekEntry(0x1C53BB6B, 0)])).length;
    let pos = seekLen + info.length + tracks.length;
    for (const c of clusters) { cues.push(el(0xBB, cat([u(0xB3, c.t), el(0xB7, cat([u(0xF7, 1), u(0xF1, pos)]))]))); pos += c.bytes.length; }
    const cuesEl = el(0x1C53BB6B, cat(cues));
    const seek = el(0x114D9B74, cat([seekEntry(0x1549A966, seekLen), seekEntry(0x1654AE6B, seekLen + info.length), seekEntry(0x1C53BB6B, pos)]));
    const segData = cat([seek, info, tracks].concat(clusters.map(c => c.bytes)).concat([cuesEl]));
    return cat([ebml, el(0x18538067, segData)]);
  }

  // ---------- Engine images (made from the app's own artwork) ----------
  // [output, source, how]: 'whole', 'alpha' (crop to opaque part) or 'logo' (crop to the logo).
  const ENGINE_IMAGES = [
    ['titlelogo.png', 'en.lproj/titlelogo@2x~ipad.png', 'whole'],
    ['title_copyright.png', 'title_copyright@2x~ipad.png', 'whole'],
    ['branch.png', 'pagejump_icon_branch.png', 'alpha'],
    ['asobikata_a.png', 'en.lproj/asobikata_a.png', 'whole'],
    ['asobikata_b.png', 'en.lproj/asobikata_b.png', 'whole'],
    ['logo_aksys.png', 'aksys-568h@2x.png', 'logo'],
    ['logo_spike.png', 'spachun-568h@2x.png', 'logo'],
    ['pj_back.png', 'en.lproj/pagejump_back@2x~iphone.png', 'whole'],
    ['pj_backtitle.png', 'en.lproj/pagejump_backtitle@2x~iphone.png', 'whole'],
    ['pj_option.png', 'en.lproj/pagejump_option@2x~iphone.png', 'whole'],
    ['pj_save.png', 'en.lproj/pagejump_save@2x~iphone.png', 'whole'],
    ['pj_share.png', 'en.lproj/pagejump_share@2x~iphone.png', 'whole'],
    ['pj_frame_01.png', 'pagejump_frame_01@2x~iphone.png', 'whole'],
    ['pj_frame_02.png', 'pagejump_frame_02@2x~iphone.png', 'whole'],
    ['pj_swipe.png', 'pagejump_swipe@2x~iphone.png', 'whole'],
    ['pj_thumbnail_bg.png', 'pagejump_thumbnail_bg@2x~iphone.png', 'whole'],
    ['pj_title_bg.png', 'pagejump_title_bg@2x~iphone.png', 'whole']
  ];
  const ALAC_TRACKS = /^(scare|secret|senti|sequence)\.m4a$/;
  // Bumped when the setup produces something new; the Android app reruns the setup for older data.
  const SETUP_VERSION = 2;

  // The game's .mp4/.mov files keep their index (moov) after the media data. Android's WebView
  // could not start those from the app's local files, so they are rewritten with the index first
  // ("fast start"); the chunk offsets inside it are moved by the same amount.
  function faststart(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), top = [];
    for (let o = 0; o + 8 <= b.length;) {
      let sz = dv.getUint32(o), hdr = 8;
      if (sz === 1) { sz = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (sz === 0) sz = b.length - o;
      if (sz < hdr || o + sz > b.length) return null;
      top.push({ t: td.decode(b.subarray(o + 4, o + 8)), o, sz }); o += sz;
    }
    const mi = top.findIndex(x => x.t === 'moov'), di = top.findIndex(x => x.t === 'mdat');
    if (mi < 0 || di < 0 || mi < di) return null;
    const moov = top[mi], moovBytes = b.slice(moov.o, moov.o + moov.sz), mv = new DataView(moovBytes.buffer);
    const delta = moov.sz;
    const walk = (o, e) => {
      while (o + 8 <= e) {
        const sz = mv.getUint32(o), t = td.decode(moovBytes.subarray(o + 4, o + 8));
        if (sz < 8) return;
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(t)) walk(o + 8, o + sz);
        else if (t === 'stco') { const n = mv.getUint32(o + 12); for (let i = 0; i < n; i++) mv.setUint32(o + 16 + i * 4, mv.getUint32(o + 16 + i * 4) + delta); }
        else if (t === 'co64') { const n = mv.getUint32(o + 12); for (let i = 0; i < n; i++) mv.setBigUint64(o + 16 + i * 8, mv.getBigUint64(o + 16 + i * 8) + BigInt(delta)); }
        o += sz;
      }
    };
    walk(0, moovBytes.length);
    const order = top.slice(0, di).concat([moov], top.slice(di).filter(x => x !== moov));
    const out = new Uint8Array(b.length); let p = 0;
    for (const x of order) { out.set(x === moov ? moovBytes : b.subarray(x.o, x.o + x.sz), p); p += x.sz; }
    return out;
  }
  // Decodes a compressed audio file (AAC in .mp4) to 48 kHz channels.
  async function decodeCompressed(b) {
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const buf = await ctx.decodeAudioData(b.slice().buffer);
    const ch = []; for (let i = 0; i < buf.numberOfChannels; i++) ch.push(buf.getChannelData(i));
    return ch;
  }

  // ---------- Main ----------
  async function convertGame(fs, log, opt) {
    log = log || (() => { }); opt = opt || {};
    const step = (name, i, n) => log({ step: name, i, n });
    const root = (await fs.list(APP)).sort(), lproj = (await fs.list(APP + 'en.lproj/')).sort();
    if (!root.includes('page.plist') || !lproj.length) throw new Error("This doesn't look like Banshee's Last Cry (ink-en.app not found).");

    // 1. PNGs
    const pngs = root.filter(n => n.endsWith('.png')).map(n => APP + n).concat(lproj.filter(n => n.endsWith('.png')).map(n => APP + 'en.lproj/' + n));
    for (let i = 0; i < pngs.length; i++) {
      step('images', i, pngs.length);
      const b = await fs.read(pngs[i]);
      if (isCgBI(b)) { try { await fs.write(pngs[i], await encodePng(await decodePng(b))); } catch (e) { log({ warn: pngs[i] + ': ' + e.message }); } }
    }
    for (let i = 0; i < ENGINE_IMAGES.length; i++) {
      const [out, src, how] = ENGINE_IMAGES[i];
      step('engine images', i, ENGINE_IMAGES.length);
      const b = await fs.read(APP + src); if (!b) { log({ warn: 'missing ' + src }); continue; }
      let img = await decodePng(b);
      if (how !== 'whole') {
        const [x0, y0, x1, y1] = contentBox(img, how === 'alpha'), pad = how === 'logo' ? 8 : 0;
        img = crop(img, Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(img.w, x1 + pad), Math.min(img.h, y1 + pad));
        if (how === 'logo') { const a = img.rgba; for (let k = 3; k < a.length; k += 4) a[k] = 255; }
      }
      await fs.write('engine/img/' + out, await encodePng(img));
    }

    // 2. data.js
    step('story data', 0, 1);
    const pl = async (p) => parseBplist(await fs.read(APP + p));
    const pg = await pl('page.plist'), ov = await pl('en.lproj/page_overwrite.plist');
    const pageload = await pl('en.lproj/pageload.plist'), strings = await pl('en.lproj/Localizable.strings');
    for (const k in ov) pg[k] = Object.assign(pg[k] && typeof pg[k] === 'object' ? pg[k] : {}, ov[k]);
    const pages = {};
    const htmls = lproj.filter(n => n.endsWith('.html'));
    for (let i = 0; i < htmls.length; i++) { step('story data', i, htmls.length); pages[htmls[i].slice(0, -5)] = text(await fs.read(APP + 'en.lproj/' + htmls[i])); }
    const chapters = {};
    for (const k of Object.keys(pg).sort()) {
      const v = pg[k]; if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const c = {}; if ('pages' in v) c.p = v.pages; if (v.title_en) c.t = v.title_en;
      if (Object.keys(c).length) chapters[k] = c;
    }
    const loops = {};
    for (const n of root.filter(n => n.endsWith('.afi'))) {
      const b = await fs.read(APP + n), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (b.length < 16 || td.decode(b.subarray(0, 4)) !== 'AFIA') continue;
      const s = dv.getInt32(4, true), e = dv.getInt32(8, true), r = dv.getInt32(12, true);
      if (s >= 0) loops[n.slice(0, -4)] = [s, e, r];
    }
    // music stored as .mp4 (AAC) is converted like the rest; the .mp4/.mov files used as movies stay
    const movies = new Set();
    for (const k in pages) for (const m of pages[k].matchAll(/playMovie\w*\(\s*['"]([^'"]+)['"]/g)) movies.add(m[1]);
    const mp4Audio = root.filter(n => /\.mp4$/i.test(n) && !movies.has(n));
    const pl2 = {}; for (const k in pageload) if (Array.isArray(pageload[k]) && pageload[k].length) pl2[k] = pageload[k][0];
    const data = {
      start: pg._start_ || 'mm0010', pages, chapters, pageload: pl2, lproj, root, loops, strings,
      endings: Object.keys(pages).filter(k => pages[k].includes('end_logo')).sort(),
      css: text(await fs.read(APP + 'km.css')), kmjs: text(await fs.read(APP + 'km.js')),
      audioExt: '.webm', audioConv: mp4Audio, setupVersion: SETUP_VERSION
    };
    await fs.write('engine/data.js', "/* Made from your own copy of Banshee's Last Cry by the setup. Personal use only. */\nwindow.BLC_DATA=" + JSON.stringify(data) + ';\n');

    // 3. Movies: index first
    const media = root.filter(n => movies.has(n) && /\.(mp4|mov)$/i.test(n));
    for (let i = 0; i < media.length; i++) {
      step('movies', i, media.length);
      const b = await fs.read(APP + media[i]); if (!b) continue;
      try { const fixed = faststart(b); if (fixed) await fs.write(APP + media[i], fixed); } catch (e) { log({ warn: media[i] + ': ' + e.message }); }
    }

    // 4. Audio (.aif/.m4a become <name>.webm; .mp4 music becomes <name>.mp4.webm)
    const tracks = root.filter(n => n.endsWith('.aif') || ALAC_TRACKS.test(n)).concat(mp4Audio);
    const outName = (n) => /\.mp4$/i.test(n) ? n + '.webm' : n.replace(/\.\w+$/, '') + '.webm';
    const have = new Set(opt.skipExisting ? await fs.list('engine/audio/') : []);
    for (let i = 0; i < tracks.length; i++) {
      step('music', i, tracks.length);
      const n = tracks[i];
      if (have.has(outName(n))) continue;
      const b = await fs.read(APP + n);
      try {
        let ch;
        if (/\.mp4$/i.test(n)) ch = await decodeCompressed(b);
        else ch = await resample(n.endsWith('.aif') ? decodeAifc(b) : ALAC.decodeM4A(b), 48000);
        await fs.write('engine/audio/' + outName(n), await encodeOpusWebm(ch));
      } catch (e) { log({ warn: n + ': ' + e.message }); }
    }
    step('done', 1, 1);
  }

  // ---------- Reading the IPA (zip) in the browser ----------
  // Lists the IPA's central directory and extracts Payload/*.app/ entries with fs.write.
  async function extractIpa(file, fs, log) {
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
    let e = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
    if (e < 0) throw new Error('Not a zip/IPA file.');
    const tdv = new DataView(tail.buffer);
    let count = tdv.getUint16(e + 10, true), cdSize = tdv.getUint32(e + 12, true), cdOff = tdv.getUint32(e + 16, true);
    if (cdOff === 0xffffffff || count === 0xffff) {   // zip64
      const l = e - 20; const lo = tdv.getUint32(l + 8, true) + tdv.getUint32(l + 12, true) * 4294967296;
      const z = new DataView(await file.slice(lo, lo + 56).arrayBuffer());
      count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), dv = new DataView(cd.buffer);
    const entries = [];
    for (let p = 0, i = 0; i < count; i++) {
      const method = dv.getUint16(p + 10, true); let csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      let off = dv.getUint32(p + 42, true);
      const name = td.decode(cd.subarray(p + 46, p + 46 + nl));
      for (let q = p + 46 + nl; q < p + 46 + nl + xl;) {           // zip64 extra field
        const id = dv.getUint16(q, true), len = dv.getUint16(q + 2, true);
        if (id === 1) { let r = q + 4; if (size === 0xffffffff) { size = Number(dv.getBigUint64(r, true)); r += 8; } if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(r, true)); r += 8; } if (off === 0xffffffff) off = Number(dv.getBigUint64(r, true)); }
        q += 4 + len;
      }
      const m = name.match(/^Payload\/[^/]+\.app\/(.+)$/);
      if (m && !name.endsWith('/') && !/^(_CodeSignature\/|[^/]+\.ttf$|SC_Info\/)/.test(m[1])) entries.push({ rel: m[1], method, csize, off });
      p += 46 + nl + xl + cl;
    }
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i];
      if (i % 20 === 0) log({ step: 'extracting', i, n: entries.length });
      const lh = new DataView(await file.slice(en.off, en.off + 30).arrayBuffer());
      const start = en.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const comp = file.slice(start, start + en.csize);
      let data;
      if (en.method === 0) data = new Uint8Array(await comp.arrayBuffer());
      else if (en.method === 8) data = new Uint8Array(await new Response(comp.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else throw new Error('Unsupported zip compression in ' + en.rel);
      await fs.write(APP + en.rel, data);
    }
    log({ step: 'extracting', i: entries.length, n: entries.length });
  }

  const api = { SETUP_VERSION, faststart, decodeCompressed, resample, isCgBI, ALAC_TRACKS, convertGame, extractIpa, parseBplist, decodePng, encodePng, decodeAifc, encodeOpusWebm };
  (typeof window !== 'undefined' ? window : globalThis).SLCConvert = api;
})();

/*
 * Slop's Last Cry for PS Vita and New 3DS: the game engine (run by QuickJS inside the native host).
 * A port of the web engine (web/engine/engine.js) to an immediate-mode canvas: the portrait screen(s)
 * are redrawn every frame from the state kept here. The original scene scripts run unchanged
 * against the same "km" bridge the iOS app gave them.
 *
 * Vita: one portrait 544x960 canvas.
 * 3DS (host.dual): the console is held like a book and each screen is a portrait canvas, 360 units
 * wide (the host scales them to the real 240 pixels). One screen shows the story text, the other the
 * scene's picture; menus, choices and everything else you touch are on the touch screen.
 */
'use strict';
const DUAL = !!host.dual;
const W = DUAL ? 360 : 544;
const SCR = DUAL ? [[360, 600], [360, 480]] : [[544, 960]];   // [top, touch screen] on the 3DS
const UI = DUAL ? 1 : 0;                                        // the screen you touch
let H = SCR[0][1];    // height of the screen being drawn (menus are laid out with it)
let TH = H;           // height of the screen that shows the story text
let regionsOn = true; // tap regions only come from the touch screen
const PLATFORM = DUAL ? '3DS' : 'Vita';
function textScr() { return DUAL && S && S.ts === 'bottom' ? 1 : 0; }
function apart() { return DUAL && textScr() !== UI; }          // choices go on the touch screen, apart from the text
function updTH() { TH = SCR[textScr()][1]; }
function useScr(i) { H = SCR[i][1]; regionsOn = i === UI; if (DUAL) host.target(i); }
const DATA = host.dataDir, APPD = host.appDir;
let NOW = 0;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const vol01 = (v) => clamp(+v || 0, 0, 1);
const easeInOut = (p) => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
const easeOut = (p) => 1 - (1 - p) * (1 - p);
function log() { host.log(Array.from(arguments).map(String).join(' ')); }

// ---------- timers and tweens ----------
let timers = [], timerSeq = 1;
function setTimer(fn, ms, owner) { const id = timerSeq++; timers.push({ id, at: NOW + (ms || 0) / 1000, fn, owner }); return id; }
function clearTimer(id) { timers = timers.filter(t => t.id !== id); }
function clearOwner(o) { timers = timers.filter(t => t.owner !== o); }
function runTimers() {
  for (let guard = 0; guard < 50; guard++) {
    const due = timers.filter(t => t.at <= NOW); if (!due.length) return;
    timers = timers.filter(t => t.at > NOW);
    for (const t of due) { try { t.fn(); } catch (e) { log('timer error', e, e.stack); } }
  }
}
// A value that moves linearly (or with an easing) from its current value to a target.
class Tw {
  constructor(v) { this.a = v; this.b = v; this.t0 = 0; this.d = 0; this.e = null; }
  get v() { if (this.d <= 0) return this.b; const p = clamp((NOW - this.t0) / this.d, 0, 1); return this.a + (this.b - this.a) * (this.e ? this.e(p) : p); }
  to(b, d, e) { const cur = this.v; this.a = cur; this.b = b; this.t0 = NOW; this.d = d || 0; this.e = e || null; return this; }
  set(v) { this.a = this.b = v; this.d = 0; return this; }
  get done() { return this.d <= 0 || NOW >= this.t0 + this.d; }
}

// ---------- storage ----------
const LS = {
  get(k, d) { const s = host.read(DATA + 'save/' + k + '.json'); if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { host.write(DATA + 'save/' + k + '.json', JSON.stringify(v)); },
  del(k) { host.write(DATA + 'save/' + k + '.json', 'null'); }
};

// ---------- data ----------
let D = null, IMGSET = null, CH = null, STR = {};
function loadStory() {
  const s = host.read(DATA + 'story.json');
  if (!s) return false;
  try { D = JSON.parse(s); } catch (e) { log('story.json', e); return false; }
  IMGSET = new Set(D.images); CH = D.chapters; STR = D.strings || {};
  return true;
}
function imgKey(name) {
  if (!name) return null;
  if (IMGSET.has('en.lproj/' + name)) return 'en.lproj/' + name;
  if (IMGSET.has(name)) return name;
  return null;
}

// ---------- images ----------
const IMG = new Map();   // key -> { id, w, h, used }
function img(key) {
  if (!key) return null;
  let e = IMG.get(key);
  if (!e) {
    const lg = D.imgsize && D.imgsize[key];   // the 3DS files are scaled down; layout uses the original size
    const id = host.loadImage(DATA + 'img/' + key, 1024, lg ? lg[0] : 0, lg ? lg[1] : 0);
    if (id < 0) { e = { id: -1, w: 0, h: 0 }; }
    else { const sz = host.imageSize(id); e = { id, w: sz[0], h: sz[1] }; }
    IMG.set(key, e);
    if (IMG.size > (host.imgCache || 40)) {   // keep texture memory down: drop the least recently used pictures
      const old = Array.from(IMG.entries()).filter(([k, v]) => k !== key && v.id > 0 && NOW - v.used > 5).sort((a, b) => a[1].used - b[1].used).slice(0, 10);
      for (const [k, v] of old) { host.freeImage(v.id); IMG.delete(k); }
    }
  }
  e.used = NOW;
  return e.id > 0 ? e : null;
}
const eimg = (n) => img('engine/' + n);
function drawCover(e, x, y, w, h, a, ang) {
  if (!e) return;
  const s = Math.max(w / e.w, h / e.h), dw = e.w * s, dh = e.h * s;
  host.drawImage(e.id, 0, 0, e.w, e.h, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh, a == null ? 1 : a, ang || 0);
}
function drawFit(e, x, y, w, h, a) {
  if (!e) return;
  const s = Math.min(w / e.w, h / e.h), dw = e.w * s, dh = e.h * s;
  host.drawImage(e.id, 0, 0, e.w, e.h, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh, a == null ? 1 : a);
}
function drawImg(e, x, y, w, h, a) { if (e) host.drawImage(e.id, 0, 0, e.w, e.h, x, y, w, h, a == null ? 1 : a); }

// ---------- fonts ----------
// Mincho setting -> Libre Baskerville (stand-in for Marion); Gothic setting -> Lato (stand-in for Euphemia UCAS).
const FONT_FILES = {
  m: ['LibreBaskerville-Regular.ttf', 'LibreBaskerville-Bold.ttf', 'LibreBaskerville-Italic.ttf', 'LibreBaskerville-BoldItalic.ttf'],
  g: ['Lato-Regular.ttf', 'Lato-Bold.ttf', 'Lato-Italic.ttf', 'Lato-BoldItalic.ttf']
};
const FONTS = new Map();
function font(fam, b, i, px) {
  px = Math.max(8, Math.round(px));
  const k = fam + (b ? 1 : 0) + (i ? 2 : 0) + ':' + px;
  let f = FONTS.get(k);
  if (f == null) {
    const id = host.loadFont(APPD + 'fonts/' + FONT_FILES[fam][(b ? 1 : 0) + (i ? 2 : 0)], px);
    const m = id > 0 ? host.fontMetrics(id) : [px, px];
    f = { id, h: m[0], asc: m[1], px, used: NOW, wcache: new Map() };
    FONTS.set(k, f);
    if (FONTS.size > 36) for (const [kk, ff] of FONTS) if (kk !== k && NOW - ff.used > 3) { host.freeFont(ff.id); FONTS.delete(kk); if (FONTS.size <= 28) break; }
  }
  f.used = NOW;
  return f;
}
function tw(f, s) { let w = f.wcache.get(s); if (w == null) { w = host.textWidth(f.id, s); if (f.wcache.size < 4000) f.wcache.set(s, w); } return w; }
function text(f, s, x, y, col, a, shadow) { host.drawText(f.id, s, x, y, col[0], col[1], col[2], a == null ? 1 : a, shadow || 0); }
const WHITE = [255, 255, 255];
const UIS = DUAL ? 1.15 : 1;   // menu text a little larger on the 3DS's low-density screens
function uiFont(px, b, i) { return font('m', b, i, px * UIS); }
function centerText(f, s, cx, y, col, a, sh) { text(f, s, cx - tw(f, s) / 2, y, col || WHITE, a, sh); }
function wrapText(f, s, w) {
  const out = []; let line = '';
  for (const para of String(s).split('\n')) {
    line = '';
    for (let word of para.split(' ')) {
      const t = line ? line + ' ' + word : word;
      if (line && tw(f, t) > w) { out.push(line); line = word; } else line = t;
      while (tw(f, line) > w && line.length > 1) {   // a word too long for the line (a file path): break it
        let k = line.length - 1; while (k > 1 && tw(f, line.slice(0, k)) > w) k--;
        out.push(line.slice(0, k)); line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

// ---------- settings and progress (same keys and defaults as the web version) ----------
const DEF = { size: 5, font: 'm', bgb: 70, textb: 100, gore: 1, dir: 'R', master: 100, bgm: 90, env: 80, se: 100, fx: 'shake', rot: 90, ts: 'top' };
let S, G, visited, chapSeen, flags, names;
const LOCAL = /^(local_|flag_from_|flag_name_|_main_$|flag_mc4030_1time$)/;
function loadProgress() {
  S = Object.assign({}, DEF, LS.get('settings', {}));
  if (S.fx === 'vibrate') S.fx = 'shake';   // neither console has a vibration motor
  host.setRotation(S.rot); updTH();
  G = Object.assign({ flags: {}, visited: [], chapters: [] }, LS.get('global', {}));
  visited = new Set(G.visited); chapSeen = G.chapters.slice();
  flags = Object.assign({}, G.flags);
  names = LS.get('names', { main: STR.NameInput_MainName || 'Max', sub: STR.NameInput_SubName || 'Grace' });
}
function saveSettings() { LS.set('settings', S); }
let gTimer = 0;
function saveGlobal() {
  clearTimer(gTimer);
  gTimer = setTimer(() => {
    const gf = {}; for (const k in flags) if (!LOCAL.test(k)) gf[k] = flags[k];
    LS.set('global', { flags: gf, visited: Array.from(visited), chapters: chapSeen });
  }, 300);
}
function localFlags() { const o = {}; for (const k in flags) if (LOCAL.test(k)) o[k] = flags[k]; return o; }
function setLocalFlags(o) { for (const k in flags) if (LOCAL.test(k)) delete flags[k]; Object.assign(flags, o || {}); }

// ---------- audio (web Track semantics on top of the host mixer) ----------
const SND = new Map();
const SNDEXT = host.sndExt || '.slco', RATE = host.audioRate || 48000;
function snd(file) {
  let e = SND.get(file);
  if (!e) { e = { id: host.sndLoad(DATA + 'audio/' + file + SNDEXT), used: NOW }; SND.set(file, e); }
  e.used = NOW;
  return e.id;
}
function sndGC() {
  if (SND.size < 24) return;
  const live = new Set([Audio_.bgm, Audio_.env, ...Audio_.se, ...Audio_.fading].filter(Boolean).map(t => t.file));
  for (const [k, e] of SND) if (!live.has(k) && NOW - e.used > 30 && e.id > 0) { host.sndFree(e.id); SND.delete(k); }
}
class Track {
  constructor(file, ch, vol, rep, path) {
    this.file = file; this.ch = ch; this.vol = 0; this.target = vol; this.rep = rep; this.fade = null; this.dead = false; this.voice = -1;
    const sid = path ? host.sndLoad(path) : snd(file);
    this.ownSid = path ? sid : 0;
    let lp = D.loops[file.replace(/\.\w+$/, '')];
    if (lp && !(lp[1] > lp[0] && lp[0] >= 0)) lp = null;
    const ls = lp ? Math.round(lp[0] * RATE / lp[2]) : 0, le = lp ? Math.round(lp[1] * RATE / lp[2]) : 0;
    if (sid > 0) this.voice = host.play(sid, 0, ls, le, rep);
    if (this.voice < 0) this.dead = true;
  }
  start(fadeIn) { this.fadeTo(this.target, fadeIn); return this; }
  fadeTo(v, t, onEnd) { this.fade = { from: this.vol, to: v, t0: NOW, dur: Math.max(0, t || 0), onEnd }; if (!t) this.step(); }
  stop(t) { if (this.dead) return; if (!t) { this.kill(); return; } this.fadeTo(0, t, () => this.kill()); this.stopping = true; }
  kill() { this.dead = true; if (this.voice >= 0) host.voiceStop(this.voice); if (this.ownSid > 0) host.sndFree(this.ownSid); }
  setRep(r) { this.rep = r; if (this.voice >= 0) host.voiceRep(this.voice, r); }
  step() {
    if (this.dead) return;
    if (this.fade) {
      const f = this.fade, k = f.dur ? clamp((NOW - f.t0) / f.dur, 0, 1) : 1;
      this.vol = f.from + (f.to - f.from) * k;
      if (k >= 1) { this.fade = null; if (f.onEnd) f.onEnd(); }
    }
    if (this.dead) return;
    if (host.voiceEnded(this.voice)) { this.dead = true; return; }
    host.voiceVol(this.voice, vol01(this.vol * (S.master / 100) * (S[this.ch] / 100)));
  }
}
const Audio_ = {
  bgm: null, env: null, se: new Set(), fading: new Set(),
  tick() {
    for (const t of [this.bgm, this.env, ...this.se, ...this.fading]) if (t) t.step();
    for (const t of this.se) if (t.dead) this.se.delete(t);
    for (const t of this.fading) if (t.dead) this.fading.delete(t);
  },
  retire(t, time) { if (!t || t.dead) return; t.stop(time); if (!t.dead) this.fading.add(t); },
  play(ch, file, vol, fadeIn, rep, cross) {
    if (ch === 'se') { const t = new Track(file, 'se', vol, rep).start(fadeIn); this.se.add(t); return; }
    const old = this[ch];
    if (old && !old.stopping) this.retire(old, cross || 0);
    this[ch] = new Track(file, ch, vol, rep).start(Math.max(fadeIn || 0, 0));
  },
  change(ch, file, vol, fadeIn, rep, cross) {
    if (ch === 'se') {
      for (const t of this.se) if (t.file === file && !t.dead && !t.stopping) { t.fadeTo(vol, fadeIn || 0.3); return; }
      return this.play(ch, file, vol, fadeIn, rep, cross);
    }
    const cur = this[ch];
    if (cur && cur.file === file && !cur.dead && !cur.stopping) { cur.setRep(rep); return; }
    this.play(ch, file, vol, fadeIn, rep, cross);
  },
  stop(ch, t) {
    if (ch === 'se') { for (const x of this.se) this.retire(x, t); this.se.clear(); return; }
    this.retire(this[ch], t); this[ch] = null;
  },
  stopAll(t) { this.stop('bgm', t); this.stop('env', t); this.stop('se', t); }
};

// ---------- background, overlays, movie ----------
const BG = { cur: null, prev: null, fade: new Tw(1), T: null, slide: new Tw(0), slideOn: false };
function newT() { return { x: new Tw(0), y: new Tw(0), sx: new Tw(1), sy: new Tw(1), rot: new Tw(0), cx: 0.5, cy: 0.5 }; }
BG.T = newT();
let bgName = '', bgFadeDur = 0.6, bgInstant = false;
const dim = new Tw(0), bright = new Tw(0), wipeA = new Tw(0);
let wipeImg = null, shakeT = -10;
function applyDim(t) { dim.to(Math.min(85, 100 - S.bgb) / 100, t || 0); }
function setBgImage(name) {
  const key = imgKey(name);
  if (key === (BG.cur && BG.cur.key)) return;
  bgName = name || '';
  BG.prev = BG.cur; BG.cur = { key };
  BG.fade.set(0).to(1, bgInstant ? 0 : bgFadeDur);
}
function drawBgLayer(layer, T, a, dx, dy) {
  if (!layer || a <= 0) return;
  const e = img(layer.key); if (!e) return;
  const sx = T.sx.v, sy = T.sy.v, s = Math.max(W / e.w, H / e.h);
  const bw = e.w * s * sx, bh = e.h * s * sy;
  const ox = W * T.cx, oy = H * T.cy;
  const x = ox + (-W * T.cx + (W - e.w * s) / 2) * sx + T.x.v * W + (dx || 0);
  const y = oy + (-H * T.cy + (H - e.h * s) / 2) * sy + T.y.v * H + (dy || 0);
  host.drawImage(e.id, 0, 0, e.w, e.h, x, y, bw, bh, a, T.rot.v, ox - x, oy - y);
}
const MOV = { id: -1, img: -1, t0: 0, fps: 15, n: 0, w: 0, h: 0, rep: 0, track: null, file: '' };
let movieKeep = false;
function playMovie(file, rep) {
  movieKeep = true;
  if (MOV.file === file && MOV.id >= 0) { MOV.rep = rep; return; }
  stopMovie();
  const id = host.movieOpen(DATA + 'movies/' + file + '.slcm'); if (id < 0) return;
  const inf = host.movieInfo(id);
  Object.assign(MOV, { id, t0: NOW, fps: inf[0], n: inf[1], w: inf[2], h: inf[3], rep, file });
  MOV.track = new Track(file, 'bgm', 1, rep === -1 ? -1 : 0, DATA + 'movies/' + file + SNDEXT).start(0);
  if (MOV.track.dead) MOV.track = null;
}
function stopMovie() { if (MOV.id >= 0) host.movieClose(MOV.id); if (MOV.track) MOV.track.kill(); MOV.id = -1; MOV.track = null; MOV.file = ''; }
function drawMovie() {
  if (MOV.id < 0) return;
  let f = Math.floor((NOW - MOV.t0) * MOV.fps);
  if (f >= MOV.n) { if (MOV.rep === -1) { MOV.t0 = NOW; f = 0; } else { stopMovie(); return; } }
  const id = host.movieFrame(MOV.id, f);
  if (id > 0) drawCover({ id, w: MOV.w, h: MOV.h }, 0, 0, W, H, 1);
}
function shake() { if (S.fx === 'shake') shakeT = NOW; }
function shakeOffset() {
  const p = (NOW - shakeT) / 0.45; if (p < 0 || p > 1) return [0, 0];
  const k = [[0, 0], [-9, 3], [8, -4], [-6, 2], [5, -2], [0, 0]], i = Math.floor(p * 5), f = p * 5 - i;
  return [k[i][0] + (k[i + 1][0] - k[i][0]) * f, k[i][1] + (k[i + 1][1] - k[i][1]) * f];
}

// ---------- text layout ----------
function sizeMul() { const v = +S.size; return v >= 1 && v <= 10 ? 1 + (v - 5) * 0.1 : 1; }
function fontPx() { return Math.round(Math.max(16, W * (DUAL ? 0.055 : 0.045)) * sizeMul()); }
const PAD_X = Math.round(W * 0.08), PAD_T = Math.round(W * 0.07), CONTENT_W = W - PAD_X * 2;
function styleOf(c) {
  const st = { size: 1, col: null, align: 'left', mt: 0, mb: 1, pad: 0, ml: 0, b: 0, mbPx: 0 };
  if (/bottom/.test(c)) st.mbPx = CONTENT_W * 0.4;
  if (/center/.test(c)) st.align = 'center';
  switch (c) {
    case 'end_title': st.size = 0.75; st.align = 'right'; st.pad = 10; break;
    case 'end_logo': st.size = 1.5; st.align = 'right'; st.pad = 30; break;
    case 'end_info': case 'end_info_en': st.size = 0.75; st.col = [255, 255, 0]; st.pad = 10; break;
    case 'credit_h1': case 'h1': st.size = 1.6; st.b = 1; st.mt = 0.67; st.mb = 0.67; break;
    case 'h4': st.b = 1; st.mt = 1.33; st.mb = 1.33; break;
    case 'credit_dt': case 'dt': st.size = 0.75; st.col = [187, 187, 187]; st.mb = 0.2; break;
    case 'credit_dt2': st.size = 0.9; st.mb = 0.2; break;
    case 'credit_dt3': st.size = 0.8; st.col = [187, 187, 187]; st.mb = 1; break;
    case 'credit_dd': case 'dd': st.size = 0.8; st.ml = 20; st.mb = 0.4; break;
    case 'credit_dd2': st.size = 0.75; st.mb = 0.4; break;
  }
  return st;
}
// Lays out a page's blocks into lines and choice boxes (positions in document coordinates).
function layout(blocks, opt) {
  opt = opt || {};
  const fam = S.font === 'g' ? 'g' : 'm', base = opt.px || fontPx(), lh = 1.55, width = opt.width || CONTENT_W;
  const items = [];   // { kind:'line'|'box'|'hr'|'img', ... }
  let y = opt.top != null ? opt.top : PAD_T;
  const x0 = opt.left != null ? opt.left : PAD_X;
  const wrapRuns = (runs, px, maxw, st, sel) => {
    // tokens: words with style; spaces kept as separate tokens to measure correctly
    const toks = [];
    for (const r of runs) {
      if (r.br) { toks.push({ br: 1 }); continue; }
      let s = r.v ? (r.v === 1 ? names.main : names.sub) : r.s;
      if (!s) continue;
      const parts = s.split(/( )/);
      for (const p of parts) if (p) toks.push({ s: p, b: r.b || st.b, i: r.i, col: r.col });
    }
    const lines = []; let cur = [], w = 0;
    const push = () => { while (cur.length && cur[cur.length - 1].s === ' ') { w -= cur[cur.length - 1].w; cur.pop(); } lines.push({ toks: cur, w }); cur = []; w = 0; };
    for (const t of toks) {
      if (t.br) { push(); continue; }
      if (t.s === ' ' && !cur.length) continue;
      const f = font(fam, t.b, t.i, px); t.f = f; t.w = tw(f, t.s);
      if (t.s !== ' ' && w + t.w > maxw && cur.length) { push(); }
      if (t.w > maxw && t.s !== ' ') {   // a single long word: break by characters
        let piece = '';
        for (const ch of t.s) { if (tw(f, piece + ch) > maxw && piece) { cur.push({ s: piece, f, w: tw(f, piece), col: t.col }); w += tw(f, piece); push(); piece = ''; } piece += ch; }
        t.s = piece; t.w = tw(f, piece);
      }
      cur.push(t); w += t.w;
    }
    if (cur.length || !lines.length) push();
    return lines;
  };
  const emitLines = (lines, px, x, maxw, align, col, extra) => {
    const lineH = Math.round(px * lh);
    for (const ln of lines) {
      let lx = x; if (align === 'center') lx = x + (maxw - ln.w) / 2; else if (align === 'right') lx = x + maxw - ln.w;
      const segs = []; let cx = lx;
      for (const t of ln.toks) {
        const last = segs[segs.length - 1];
        if (last && last.f === t.f && last.col === t.col) { last.s += t.s; } else segs.push({ s: t.s, f: t.f, x: cx, col: t.col });
        cx += t.w;
      }
      items.push(Object.assign({ kind: 'line', y, h: lineH, segs, col, base: Math.round((lineH - (segs[0] ? segs[0].f.h : px)) / 2) }, extra || {}));
      y += lineH;
    }
  };
  let prevMb = 0;
  const vm = (px, top) => { y += Math.max(0, top - prevMb); };   // collapse margins roughly
  for (const b of blocks) {
    if (b.k === 'sp') { y += Math.round(base * lh); continue; }
    if (b.k === 'hr') { y += 8; items.push({ kind: 'hr', y }); y += 8 + (b.c === 'credit_hr' ? base * 6 : 0); prevMb = 0; continue; }
    if (b.k === 'img') {
      const e = img(imgKey(b.src)); if (!e) continue;
      const w = Math.min(width, e.w * (W / 320) / 2), h = e.h * w / e.w;
      items.push({ kind: 'img', y, x: x0 + (width - w) / 2, w, h, key: imgKey(b.src) }); y += h + base * 0.5; prevMb = 0; continue;
    }
    if (b.k === 'ul') {
      const end = /end_select/.test(b.c);
      y += Math.max(0, 20 - prevMb) + 10;
      for (const it of b.items) {
        const px = base, padX = end ? 30 : 18, padY = end ? 10 : 16, m = end ? 5 : 10;
        const bx = x0 + 10 + m, bw = width - 20 - m * 2;
        const lines = wrapRuns(it.r, px, bw - padX - (end ? 10 : 18), {}, true);
        const top = y + m, lineH = Math.round(px * lh), bh = lines.length * lineH + padY * 2;
        const box = { kind: 'box', y: top, x: bx, w: bw, h: bh, item: it, end };
        items.push(box);
        const save = y; y = top + padY;
        emitLines(lines, px, bx + padX, bw - padX * 2, 'left', null, { box });
        y = save + m + bh + m;
      }
      y += 10 + width * 0.25; prevMb = 0;
      continue;
    }
    const st = styleOf(b.c || ''), px = Math.round(base * st.size);
    vm(px, px * st.mt);
    y += st.pad;
    const lines = wrapRuns(b.r || [], px, width - st.ml - st.pad * 2, st);
    if (lines.length === 1 && !lines[0].toks.length && !(b.r || []).some(r => r.br)) { continue; }
    emitLines(lines, px, x0 + st.ml + st.pad, width - st.ml - st.pad * 2, st.align, st.col);
    y += st.pad;
    const mb = Math.max(px * st.mb, st.mbPx);
    y += mb; prevMb = mb;
  }
  return { items, height: y };
}

// ---------- pages ----------
let cur = null, history = [], trail = [], busy = false, inGame = false;
function seqOf(k) { return CH[k] && CH[k].p ? [k].concat(CH[k].p) : null; }
function locate(id, prefer) {
  if (CH[id] && CH[id].p) return { chap: id, idx: 0 };
  if (prefer && seqOf(prefer)) { const i = seqOf(prefer).indexOf(id); if (i > 0) return { chap: prefer, idx: i }; }
  for (const k in CH) { const s = seqOf(k); if (s) { const i = s.indexOf(id); if (i > 0) return { chap: k, idx: i }; } }
  return null;
}
function chapterTitleFor(id, ctx) {
  if (CH[id] && CH[id].t) return CH[id].t;
  if (ctx && CH[ctx.chap] && CH[ctx.chap].t) return CH[ctx.chap].t;
  return '';
}
function parseSel(a) {
  const m = String(a).match(/^((\w+):)?(\w+)?(\s*)?(\S.*)?$/);
  if (!m) return null;
  return { type: m[2], target: m[3], args: m[5] ? m[5].split(/\s+/) : [] };
}
function clonePage(id) { return JSON.parse(JSON.stringify(D.pages[id])); }

// The scene scripts run in their own function scope with the iOS app's km.js constants.
const KMJS = (function () {
  return 'function removeElementById(id){ km.hideElementById(id); }\n' +
    'const bgm_vol_high=0.5,bgm_vol_normal=0.4,bgm_vol_low=0.3,env_vol_high=0.4,env_vol_normal=0.30,env_vol_low=0.20,se_vol_high=1.0,se_vol_normal=1.0,se_vol_low=0.5;\n' +
    'const fade_time_long=5.0,fade_time_normal=3.0,fade_time_short=1.0,fade_time_very_short=0.5,fade_time_very2_short=0.2,fade_time_none=0.0;\n' +
    'const name_mikimoto=100,name_tanaka=101,name_kobayashi=102,name_kyoko=103,name_toshio=104,name_midori=105,name_kayama=106,name_haruko=107,name_kanako=108,name_aki=109,name_keiko=110,name_ol3=111;\n' +
    'const from_be0220=0,from_be0290=1;\n';
})();
function makeKm(pg) {
  const own = (fn) => function () { if (cur === pg) return fn.apply(null, arguments); };
  const T = () => BG.T, applyT = (k, v, t) => { T()[k].to(+v, t > 0 ? +t : 0); };
  const km = {
    playBgm_volume_fadein_repeat: (f, v, fi, r) => Audio_.play('bgm', f, v, fi, r),
    playBgm_volume_crossfade_repeat: (f, v, fi, cf, r) => Audio_.play('bgm', f, v, fi, r, cf),
    changeBgm_volume_fadein_repeat: (f, v, fi, r) => Audio_.change('bgm', f, v, fi, r),
    changeBgm_volume_crossfade_repeat: (f, v, fi, cf, r) => Audio_.change('bgm', f, v, fi, r, cf),
    playEnv_volume_fadein_repeat: (f, v, fi, r) => Audio_.play('env', f, v, fi, r),
    playEnv_volume_crossfade_repeat: (f, v, fi, cf, r) => Audio_.play('env', f, v, fi, r, cf),
    changeEnv_volume_fadein_repeat: (f, v, fi, r) => Audio_.change('env', f, v, fi, r),
    changeEnv_volume_crossfade_repeat: (f, v, fi, cf, r) => Audio_.change('env', f, v, fi, r, cf),
    playSe_volume_fadein_repeat: (f, v, fi, r) => Audio_.play('se', f, v, fi, r),
    changeSe_volume_fadein_repeat: (f, v, fi, r) => Audio_.change('se', f, v, fi, r),
    stopBgm_fadeout: (t) => Audio_.stop('bgm', t),
    stopEnv_fadeout: (t) => Audio_.stop('env', t),
    stopSe_fadeout: (t) => Audio_.stop('se', t),
    stopSound: () => Audio_.stopAll(0),
    playVibrate: () => shake(),
    setBg: (a) => setBgImage(a || 'wh.jpg'),
    setBgViolence: (a, b, c) => setBgImage([a, b, c][+S.gore] || a || 'wh.jpg'),
    slideBGImage_ox_oy_w_h_tx_ty_dur: (a) => setBgImage(a || 'wh.jpg'),
    setBrightness: (v, t) => bright.to(vol01(v), +t || 0),
    slideBg_x_y_time: (x, y, t) => { applyT('x', x, t); applyT('y', y, t); },
    slideBg_x_y_x_y_time: (x0, y0, x1, y1, t) => { T().x.set(+x0); T().y.set(+y0); applyT('x', x1, t); applyT('y', y1, t); },
    rotateBg_rot_cx_cy_time: (r, cx, cy, t) => { T().cx = +cx; T().cy = +cy; applyT('rot', r, t); },
    rotateBg_rot_rot_cx_cy_time: (r0, r1, cx, cy, t) => { T().cx = +cx; T().cy = +cy; T().rot.set(+r0); applyT('rot', r1, t); },
    scaleBg_sx_sy_cx_cy_time: (sx, sy, cx, cy, t) => { T().cx = +cx || 0.5; T().cy = +cy || 0.5; applyT('sx', sx, t); applyT('sy', sy, t); },
    scaleBg_sx_sy_time: (sx, sy, t) => { applyT('sx', sx, t); applyT('sy', sy, t); },
    scaleBg_scale_time: (s, t) => { applyT('sx', s, t); applyT('sy', s, t); },
    scaleBg_scale_cx_cy_time: (s, cx, cy, t) => { T().cx = +cx; T().cy = +cy; applyT('sx', s, t); applyT('sy', s, t); },
    playMovie_mw_mh_oy_rep: (f, mw, mh, oy, rep) => playMovie(f, rep),
    playMovie_oy_rep: (f, oy, rep) => playMovie(f, rep),
    setTimeout: (fn, ms) => setTimer(typeof fn === 'function' ? fn : () => pg.fns.__eval(String(fn)), ms, pg),
    clearTimeoutTable: () => { },
    getFlag: (n) => n === '_unlocked_' ? 1 : n === '_is_ipad_' ? 0 : n === '_is_gothic_font_' ? (S.font === 'g' ? 1 : 0) : n === '_font_size_' ? fontPx() : (flags[n] || 0),
    setFlag: (n, v) => { flags[n] = v; if (!LOCAL.test(n)) saveGlobal(); },
    debugInitFlags: () => { },
    getf: () => flags._main_ || 0,
    setf: (v) => { flags._main_ = v; },
    isUnlocked: () => 1, isIPad: () => 0, isFontGothic: () => S.font === 'g' ? 1 : 0, getFontSizePx: () => fontPx(),
    pushSelectPage: own((n) => { pg.override = n; }),
    pushSecretPage: own((s) => { pg.secret = s; }),
    altBranch: (t) => choose('alt:' + t),
    fltBranch: (t, x, d) => choose('flt:' + t + ' ' + (d || 1)),
    transitionBranch: (t, x, im, d) => choose('trs:' + t + ' ' + im + ' ' + (d || 0.5)),
    nameInput: () => openKiller(), returnTitle: () => toTitle(), returnStart: () => restartStory(),
    chargeAlert: () => { }, refreshCharge: () => { }, consoleLog: (a) => log('page:', a), callPageJavaScriptEnd: () => { },
    hideElementById: (id) => removeElement(pg, id),
    refreshHide: () => { }, listToArray: (a) => a ? Array.from(a) : null,
    parseSelectString: (a) => { const p = parseSel(a); return p ? [p.type, p.target, p.args.join(' '), p.args] : null; },
    isBranchPage: () => (pg && pg.choices && pg.choices.length) ? '1' : '',
    scriptFlagsFromProg_: flags
  };
  km.stopBgm_fadeoust = km.stopBgm_fadeout;
  km.changeSe_Volume_fadein_repeat = km.changeSe_volume_fadein_repeat;
  km.changeBgm_Volume_fadein_repeat = km.changeBgm_volume_fadein_repeat;
  return new Proxy(km, { get: (o, k) => (k in o) ? o[k] : (typeof k === 'string' ? (() => log('km.' + k + ' not implemented')) : undefined) });
}
function removeElement(pg, id) {
  const has = (x) => x.ids && x.ids.indexOf(id) >= 0;
  pg.blocks = pg.blocks.filter(b => !has(b));
  for (const b of pg.blocks) if (b.k === 'ul') b.items = b.items.filter(it => it.id !== id && !has(it));
  pg.blocks = pg.blocks.filter(b => b.k !== 'ul' || b.items.length);
  pg.dirty = true;
}
function elementProxy(pg, id) {
  return {
    set innerHTML(v) {
      const s = String(v).replace(/<[^>]*>/g, '');
      const fix = (runs) => { let done = false; for (let i = 0; i < runs.length; i++) if (runs[i].id === id) { if (!done) { runs[i] = { s, id }; done = true; } else { runs.splice(i, 1); i--; } } };
      for (const b of pg.blocks) { if (b.r) fix(b.r); if (b.items) b.items.forEach(it => fix(it.r)); if (b.ids && b.ids[b.ids.length - 1] === id && b.r) b.r = [{ s, id }]; }
      pg.dirty = true;
    },
    get innerHTML() { return ''; },
    style: {}, setAttribute() { }, getAttribute() { return null; }
  };
}
function compileScript(pg) {
  const doc = {
    get height() { return Math.round((pg.lay ? pg.lay.height + TH * 0.3 : TH) * 320 / W); },
    getElementById: (id) => elementProxy(pg, id),
    addEventListener: (type, fn) => { if (type === 'touchstart') pg.touchHandlers.push(fn); },
    write: () => { }, body: {}
  };
  const scrollBy = (dx, dy) => { pg.scroll.target = null; pg.scrollY = clamp(pg.scrollY + (+dy || 0) * W / 320, 0, maxScroll(pg)); };
  const st = (f, t) => setTimer(f, t, pg), ct = (id) => clearTimer(id);
  let f;
  try {
    f = new Function('km', 'document', '__st', '__ct', 'scrollBy', 'window',
      KMJS + 'var setTimeout=function(f,t){if(typeof f!=="function"){var __s=String(f);f=function(){eval(__s)}}return __st(f,t)};var clearTimeout=__ct;\n' +
      pg.src.s + '\n;return {ready:typeof ready=="function"?ready:null,play:typeof play=="function"?play:null,enter:typeof enter=="function"?enter:null,leave:typeof leave=="function"?leave:null,onNameInput:typeof onNameInput=="function"?onNameInput:null,__eval:function(s){return eval(s)}};');
  } catch (e) { log('script error in', pg.id, e); return {}; }
  try { return f(pg.km, doc, st, ct, scrollBy, {}) || {}; } catch (e) { log('script run error in', pg.id, e, e.stack); return {}; }
}
function callPage(pg, name) { const fn = pg.fns && pg.fns[name]; if (fn) { try { return fn.apply(null, Array.from(arguments).slice(2)); } catch (e) { log(name, 'error in', pg.id, e, e.stack); } } }

const T_OLD = { pg: null, bg: null, T: null, dim: 0, kind: '', a: new Tw(0), dx: new Tw(0), d: 1 };
function snapshotT() { const t = BG.T, o = newT(); for (const k of ['x', 'y', 'sx', 'sy', 'rot']) o[k].set(t[k].v); o.cx = t.cx; o.cy = t.cy; return o; }
function resetT() { BG.T = newT(); }
function goto(id, opt) {
  opt = opt || {};
  if (!D.pages[id]) { toast('Missing page: ' + id); return; }
  if (busy && !opt.force) return;
  busy = true;
  const prev = cur;
  if (prev && !opt.noHistory) {
    history.push({ id: prev.id, ctx: prev.ctx, locals: prev.localsAtEntry, branch: !prev.linear });
    if (history.length > 1500) { history.shift(); trail.shift(); }
  }
  if (prev) { callPage(prev, 'leave'); clearOwner(prev); }
  const fade = opt.fade != null ? +opt.fade : 0.35;
  // remember the page that is going away, for the transition
  if (prev) {
    T_OLD.pg = prev; T_OLD.bg = BG.cur; T_OLD.T = snapshotT(); T_OLD.dim = dim.v; T_OLD.bright = bright.v;
    T_OLD.textA = prev.textA.v;
  } else T_OLD.pg = null;
  if (opt.slide && prev && !opt.wipe) {
    T_OLD.kind = 'slide'; T_OLD.d = (opt.back ? -1 : 1) * (S.dir === 'L' ? -1 : 1);
    BG.slide.set(T_OLD.d); bgInstant = true;   // in screen widths
    mount(id, opt);
    return;
  }
  if (opt.wipe) {
    T_OLD.kind = 'none';
    wipeImg = imgKey(opt.wipe); wipeA.to(1, fade / 2);
    dim.to(0, Math.min(fade, 0.6));
    if (prev) prev.textA.to(0, Math.min(fade, 0.6));
    setTimer(() => { T_OLD.pg = null; mount(id, opt); }, Math.min(fade, 0.6) * 1000);
    return;
  }
  T_OLD.kind = prev ? 'fade' : 'none'; T_OLD.a.set(1).to(0, fade);
  bgFadeDur = fade;
  mount(id, opt);
}
function mount(id, opt) {
  resetT();
  movieKeep = false;
  const ctx = opt.ctx || locate(id, cur && cur.ctx && cur.ctx.chap);
  const src = D.pages[id];
  const pg = { id, ctx, src, blocks: clonePage(id).b, override: null, secret: null, linear: true, localsAtEntry: localFlags(),
    scrollY: 0, scroll: { v: 0, target: null }, textA: new Tw(0), revealed: false, touchHandlers: [], dirty: true, choiceAnim: null, focus: -1, pull: 0 };
  {
    const pos = history.length;
    if (trail.length < pos) trail = history.map(h => ({ id: h.id, ctx: h.ctx, locals: h.locals }));
    if (!(trail[pos] && trail[pos].id === id)) { trail.length = pos; trail.push({ id, ctx, locals: pg.localsAtEntry }); }
    else trail[pos].ctx = ctx;
  }
  cur = pg;
  pg.km = makeKm(pg);
  bright.set(0);
  pg.fns = compileScript(pg);      // runs the page's top-level code (setBg...)
  bgInstant = false;
  callPage(pg, 'ready');
  // choices: visited targets show as "selected"
  for (const b of pg.blocks) if (b.k === 'ul') for (const it of b.items) {
    const p = parseSel(it.sel);
    if (it.c === 'select_lock') it.c = 'select';
    if (p && p.target && visited.has(p.target) && it.c === 'select') it.c = 'selected';
  }
  relayout(pg);
  pg.branch = pg.choices.length > 0 && !pg.choices.some(it => /^returnStart/.test(it.sel));
  visited.add(id);
  const ct = CH[id] && CH[id].t ? id : null;
  if (ct && chapSeen.indexOf(ct) < 0) chapSeen.push(ct);
  saveGlobal();
  if (opt.wipe) { wipeA.to(0, (opt.fade || 0.5) / 2 + 0.2); }
  const HOLD = 0.4;
  const start = () => {
    if (cur !== pg) return;
    if (!opt.back && !opt.load) callPage(pg, 'enter');
    callPage(pg, 'play');
    if (!movieKeep) stopMovie();
    autosave();
  };
  if (T_OLD.kind === 'slide') {
    dim.set(0);
    BG.slide.to(0, 0.3, easeInOut);
    setTimer(() => { if (cur !== pg) return; T_OLD.pg = null; T_OLD.kind = ''; busy = false; start(); pg.holdT = setTimer(() => reveal(pg), HOLD * 1000); }, 320);
  } else {
    busy = false;
    dim.to(0, 0.3);
    start();
    const fadeT = opt.wipe ? (opt.fade || 0.5) / 2 + 0.2 : bgFadeDur;
    bgFadeDur = 0.6;
    setTimer(() => { if (T_OLD.pg && cur === pg) T_OLD.pg = null; }, fadeT * 1000 + 50);
    pg.holdT = setTimer(() => reveal(pg), (fadeT + HOLD) * 1000);
  }
}
function reveal(pg) {
  if (!pg || pg.revealed) return;
  pg.revealed = true; clearTimer(pg.holdT);
  applyDim(0.3); pg.textA.to(1, 0.3);
}
function relayout(pg) {
  updTH();
  // keep the first lines clear of the BRANCH icon on pages with choices
  const hasChoices = pg.blocks.some(b => b.k === 'ul' && b.items.some(it => !/^returnStart/.test(it.sel)));
  let top = PAD_T;
  if (hasChoices) { const b = eimg('branch.png'), bw = Math.min(W * 0.15, 110); if (b) top = Math.max(top, 12 + b.h * bw / b.w + 10); }
  const sep = apart();
  pg.lay = layout(sep ? pg.blocks.filter(b => b.k !== 'ul') : pg.blocks, { top });
  pg.choices = []; pg.clay = null;
  if (sep) {
    const ul = pg.blocks.filter(b => b.k === 'ul');
    if (ul.length) { pg.clay = layoutChoices(ul); for (const it of pg.clay.items) if (it.kind === 'box') pg.choices.push(it); }
  } else for (const it of pg.lay.items) if (it.kind === 'box') pg.choices.push(it);
  pg.linear = pg.choices.length === 0;
  pg.dirty = false;
  pg.scrollY = clamp(pg.scrollY, 0, maxScroll(pg));
}
// 3DS with the text on the top screen: the choices are laid out on their own, centred on the touch screen.
function layoutChoices(ul) {
  const HU = SCR[UI][1];
  let lay = null;
  for (const m of [1, 0.9, 0.8, 0.7]) {
    lay = layout(ul, { top: 0, px: Math.round(fontPx() * m) });
    let b = 0; for (const it of lay.items) if (it.kind === 'box') b = Math.max(b, it.y + it.h);
    lay.bottom = b; if (b <= HU - 20) break;
  }
  let t = Infinity; for (const it of lay.items) t = Math.min(t, it.y);
  const off = Math.round((HU - (lay.bottom - t)) / 2 - t);
  for (const it of lay.items) it.y += off;
  lay.height = HU;
  return lay;
}
function ctxNext(pg) {
  const c = pg.ctx, s = c && seqOf(c.chap);
  if (s && c.idx + 1 < s.length) { const id = s[c.idx + 1]; return { id, ctx: (CH[id] && CH[id].p) ? { chap: id, idx: 0 } : { chap: c.chap, idx: c.idx + 1 } }; }
  const src = D.pages[pg.id];
  if (src.ifnot && !flags['global_' + src.ifnot[0]] && D.pages[src.ifnot[1]]) return { id: src.ifnot[1] };
  if (src.jump && D.pages[src.jump]) return { id: src.jump };
  return null;
}
function next() {
  if (!cur || busy || anyOverlay()) return;
  if (!cur.revealed) { reveal(cur); return; }
  if (!cur.linear) { focusChoices(); return; }
  if (cur.override) { goto(cur.override, { slide: true }); return; }
  const n = ctxNext(cur);
  if (n) { goto(n.id, n.ctx ? { ctx: n.ctx, slide: true } : { slide: true }); return; }
  backToChoice();
}
function backToChoice() {
  while (history.length) {
    const h = history.pop();
    if (h.branch) { setLocalFlags(h.locals); goto(h.id, { noHistory: true, back: true, ctx: h.ctx }); return; }
  }
  toTitle();
}
function back() {
  if (busy || anyOverlay() || !history.length || !cur || cur.choiceAnim) return;
  const h = history.pop();
  setLocalFlags(h.locals);
  goto(h.id, { noHistory: true, back: true, ctx: h.ctx, slide: true });
}
function choose(s) {
  if (busy) return;
  const p = parseSel(s);
  if (!p) return;
  switch (p.type) {
    case 'alt': if (p.target) goto(p.target, { slide: true }); break;
    case 'flt': case undefined: if (p.target) goto(p.target, { fade: p.args[0] ? +p.args[0] : 1 }); break;
    case 'trs': if (p.target) goto(p.target, { wipe: p.args[0], fade: p.args[1] ? +p.args[1] : 0.5 }); break;
    case 'nameInput': openKiller(); break;
    case 'returnStart': restartStory(); break;
    case 'returnTitle': toTitle(true); break;
    default: log('unknown select', s);
  }
}
// Original choice animation: the rest fades, the chosen option glides to the middle and grows (0.4 s),
// stays, fades out, then the next page.
function pickChoice(box) {
  const pg = cur; if (!pg || busy || pg.choiceAnim) return;
  if (/^nameInput/.test(box.item.sel)) { choose(box.item.sel); return; }
  busy = true;
  dim.to(0, 0.3);
  pg.choiceAnim = { box, t0: NOW };
  setTimer(() => { busy = false; pg.choiceAnim.done = true; choose(box.item.sel); }, 2000);
}
function focusChoices() {
  const pg = cur; if (!pg || !pg.choices.length) return;
  if (pg.focus < 0) pg.focus = 0;
  if (apart()) { pg.scroll.target = maxScroll(pg); return; }
  const b = pg.choices[pg.focus];
  pg.scroll.target = clamp(b.y - TH * 0.4, 0, maxScroll(pg));
}
function maxScroll(pg) { return Math.max(0, (pg.lay ? pg.lay.height : 0) + TH * 0.3 - TH); }
function atBottom(pg) { return pg.scrollY >= maxScroll(pg) - 6; }

// ---------- saving ----------
const SLOTS = ['slot1', 'slot2', 'slot3'];
function snapshot() {
  if (!cur) return null;
  return { id: cur.id, ctx: cur.ctx, locals: cur.localsAtEntry, names, bg: bgName, time: host.now(), title: chapterTitleFor(cur.id, cur.ctx), hist: history.slice(-400), trail: trail.slice(-600) };
}
function autosave() { const s = snapshot(); if (s) LS.set('auto', s); }
function loadState(s) {
  if (!s || !D.pages[s.id]) { toast('No saved data'); return; }
  names = s.names || names; LS.set('names', names);
  setLocalFlags(s.locals);
  history = Array.isArray(s.hist) ? s.hist.slice() : [];
  trail = Array.isArray(s.trail) && s.trail.length > history.length ? s.trail.slice() : history.map(h => ({ id: h.id, ctx: h.ctx, locals: h.locals }));
  enterGame(); cur = null;
  goto(s.id, { noHistory: true, load: true, ctx: s.ctx, force: true });
}

// ---------- screens ----------
let screen = 'boot';   // boot | logos | title | names | game
const overlays = [];   // stack of { draw, tap, button, ... }
function anyOverlay() { return overlays.length > 0; }
function pushOverlay(o) { o.t0 = NOW; overlays.push(o); return o; }
function popOverlay(o) { const i = overlays.indexOf(o || overlays[overlays.length - 1]); if (i >= 0) overlays.splice(i, 1); }
let toastMsg = '', toastT = -10;
function toast(m) { toastMsg = m; toastT = NOW; }
function enterGame() { inGame = true; screen = 'game'; Audio_.stopAll(0.5); }
function toTitle() {
  overlays.length = 0;
  if (cur) { callPage(cur, 'leave'); clearOwner(cur); }
  cur = null; inGame = false; history = []; trail = [];
  stopMovie(); Audio_.stopAll(0.5);
  BG.cur = BG.prev = null; bright.set(0); dim.set(0);
  playLogos(() => openTitle());
}
function restartStory() {
  setLocalFlags({}); history = []; trail = [];
  Audio_.stopAll(0.5);
  goto(D.start, { noHistory: true, force: true, fade: 0.5 });
}
function beginStory() {
  setLocalFlags({}); history = []; trail = []; cur = null;
  enterGame();
  goto(D.start, { noHistory: true, force: true, fade: 1 });
}

// logos
let logo = null;
function playLogos(done) {
  screen = 'logos';
  logo = { list: ['logo_aksys.png', 'logo_spike.png'], i: 0, t0: NOW, done };
}
function drawLogos() {
  const L = logo, seg = 2.6, t = NOW - L.t0, i = Math.floor(t / seg);
  if (i >= L.list.length) { screen = ''; L.done(); return; }
  const p = t - i * seg, a = p < 0.5 ? p / 0.5 : p < 2.0 ? 1 : p < 2.5 ? 1 - (p - 2.0) / 0.5 : 0;
  const e = eimg(L.list[i]); if (e) drawFit(e, W * 0.1, H * 0.3, W * 0.8, H * 0.4, a);
}

// title
let title = null;
function openTitle() {
  screen = 'title';
  title = { t0: NOW, focus: 0 };
  if (!Audio_.bgm || Audio_.bgm.file !== 'scare.m4a' || Audio_.bgm.stopping) Audio_.play('bgm', 'scare.m4a', 0.4, 1, -1);
}
function titleButtons() {
  if (title.has == null) title.has = !!LS.get('auto', null) || SLOTS.some(k => LS.get(k, null));
  const has = title.has;
  return [
    { label: 'From the beginning', fn: () => openNames() },
    { label: 'From saved location', fn: () => openSaves('load'), off: !has },
    { label: 'Settings', fn: () => openSettings() }
  ];
}
// part: 'all' (Vita), 'art' (3DS top screen: picture and logo) or 'menu' (3DS touch screen: buttons)
function drawTitle(part) {
  part = part || 'all';
  const t = NOW - title.t0;
  const st = clamp(t / 0.5, 0, 1);
  drawCover(img(imgKey('s_house.jpg')), 0, 0, W, H, st);
  if (part === 'menu') host.fillRect(0, 0, W, H, 0, 0, 0, 0.35 * st);
  const lg = part === 'menu' ? null : eimg('titlelogo.png');
  if (lg) {
    const p = clamp((t - 0.5) / 1.5, 0, 1), lw = W, lh = lg.h * W / lg.w, ly = H * 0.39 - lh / 2;
    const vis = p * 1.25 * lw;   // soft-edged wipe from the left
    const n = 12;
    for (let k = 0; k < n; k++) {
      const x0 = vis - lw * 0.25 + (lw * 0.25) * k / n, x1 = x0 + lw * 0.25 / n;
      const a = 1 - k / n;
      const cx0 = clamp(x0, 0, lw), cx1 = clamp(x1, 0, lw);
      if (cx1 > cx0) host.drawImage(lg.id, cx0 * lg.w / lw, 0, (cx1 - cx0) * lg.w / lw, lg.h, cx0, ly, cx1 - cx0, lh, a * st);
    }
    const solid = clamp(vis - lw * 0.25, 0, lw);
    if (solid > 0) host.drawImage(lg.id, 0, 0, solid * lg.w / lw, lg.h, 0, ly, solid, lh, st);
  }
  if (part === 'art') return;
  const cp = eimg('title_copyright.png'); if (cp) drawFit(cp, W * 0.15, H * 0.955, W * 0.7, H * 0.03, 0.8 * st);
  const ma = clamp((t - 2.0) / 1, 0, 1);
  const bs = titleButtons(), bw = W * 0.8, bh = 58, gap = 12;
  const by0 = part === 'menu' ? (H - bs.length * (bh + gap)) / 2 : H - H * 0.09 - bs.length * (bh + gap);
  bs.forEach((b, i) => {
    const r = { x: (W - bw) / 2, y: by0 + i * (bh + gap), w: bw, h: bh };
    menuButton(r, b.label, ma * (b.off ? 0.35 : 1), title.focus === i);
    if (ma > 0.5 && !b.off) region(r, b.fn);
  });
}
function menuButton(r, label, a, focus) {
  host.roundRect(r.x, r.y, r.w, r.h, 6, 0, 0, 0, 0.55 * a);
  host.roundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 5, focus ? 60 : 39, focus ? 76 : 50, focus ? 110 : 74, (focus ? 0.95 : 0.7) * a);
  const f = uiFont(22);
  centerText(f, label, r.x + r.w / 2, r.y + (r.h - f.h) / 2, WHITE, a, 0.6);
}

// names screen (original: shows the two names, lets you change them in place, then How to Play)
let namesSt = null;
function openNames() { screen = 'names'; namesSt = { t0: NOW, focus: 2, help: false }; }
function drawNames() {
  const t = NOW - namesSt.t0;
  drawCover(img(imgKey('s_house.jpg')), 0, 0, W, H, 1);
  host.fillRect(0, 0, W, H, 0, 0, 0, 0.55);
  if (namesSt.help) { drawHelpPage('howtoplay_intro', namesSt.helpT); return; }
  const f = uiFont(22), fb = uiFont(30), fs = uiFont(18), small = H < 700;
  centerText(fs, STR.NameInput_Title || 'Main characters', W / 2, small ? H * 0.06 : H * 0.2, [220, 220, 220], 1, 0.6);
  const rows = [[STR.NameInput_MainLabel || 'You', 'main'], [STR.NameInput_SubLabel || 'Your girlfriend', 'sub']];
  rows.forEach(([lab, k], i) => {
    const y = small ? H * 0.15 + i * Math.round(H * 0.26) : H * 0.3 + i * 150;
    centerText(fs, lab, W / 2, y, [200, 200, 200], 1, 0.6);
    const r = { x: W * 0.15, y: y + 32, w: W * 0.7, h: 64 };
    host.roundRect(r.x, r.y, r.w, r.h, 8, 17, 28, 60, 0.85);
    if (namesSt.focus === i) host.roundRect(r.x - 2, r.y - 2, r.w + 4, 3, 1, 168, 55, 44, 1);
    centerText(fb, names[k], W / 2, r.y + (r.h - fb.h) / 2, WHITE, 1, 0.8);
    centerText(uiFont(14), 'Change', r.x + r.w - 40, r.y + r.h + 6, [180, 180, 180], 1);
    region(r, () => editName(k));
  });
  const bw = W * 0.8;
  const by = small ? H - 2 * 60 - 12 : H * 0.72, bh = small ? 52 : 58, bg = small ? 60 : 72;
  const r1 = { x: (W - bw) / 2, y: by, w: bw, h: bh }, r2 = { x: (W - bw) / 2, y: by + bg, w: bw, h: bh };
  menuButton(r1, STR.NameInput_Start || 'Use these names', 1, namesSt.focus === 2); region(r1, startNew);
  menuButton(r2, STR.NameInput_Back || 'Return to Title Screen', 1, namesSt.focus === 3); region(r2, () => { screen = 'title'; title.focus = 0; });
  void t; void f;
}
function editName(k) {
  openIME(names[k], (s) => { s = (s || '').trim(); if (s) { names[k] = s.slice(0, 16); LS.set('names', names); } });
}
function startNew() {
  if (!D.help.howtoplay_intro) return beginStory();
  namesSt.help = true; namesSt.helpT = NOW; namesSt.helpLay = null;
}
function drawHelpPage(key, t0, opt) {
  opt = opt || {};
  const st = namesSt && key === 'howtoplay_intro' ? namesSt : helpSt;
  if (!st.helpLay) st.helpLay = layout(D.help[key] || [], { px: DUAL ? 21 : 19, top: 60 });
  const a = opt.leaving != null ? opt.leaving : clamp((NOW - t0) / 0.5, 0, 1);
  host.fillRect(0, 0, W, H, 0, 0, 0, 0.85 * a);
  drawLayout(st.helpLay, st.helpScroll || 0, a, null);
}

// How to Play / Product Information pages from settings
let helpSt = null;
function openHelp(key) { helpSt = { key, helpLay: null, helpScroll: 0 }; pushOverlay({ name: 'help', draw: () => { drawHelpPage(key, 0, { leaving: 1 }); }, back: () => popOverlay(), scrollable: helpSt }); }

// ---------- drawing the game ----------
function drawLayout(lay, scrollY, a, pg) {
  const ta = vol01(S.textb / 100);
  // while a choice is being picked, the rest of the page fades out (0.3 s)
  if (pg && pg.choiceAnim) a *= clamp(1 - (NOW - pg.choiceAnim.t0) / 0.3, 0, 1);
  if (a <= 0) return;
  for (const it of lay.items) {
    const y = it.y - scrollY;
    if (y > H || y + (it.h || 20) < 0) continue;
    if (it.kind === 'box') {
      const ba = a * 0.85;
      if (it.end) host.roundRect(it.x, y, it.w, it.h, 22, 20, 40, 40, 0.4 * a);
      else { host.roundRect(it.x + 3, y + 3, it.w, it.h, 10, 40, 22, 51, ba); host.roundRect(it.x, y, it.w, it.h, 10, 27, 0, 66, ba); host.roundRect(it.x + 1, y + 1, it.w - 2, it.h - 2, 9, 39, 50, 74, ba); }
      if (pg && pg.focus >= 0 && pg.choices[pg.focus] === it && !pg.choiceAnim) host.roundRect(it.x - 3, y - 3, 4, it.h + 6, 2, 168, 55, 44, a);
      continue;
    }
    if (it.kind === 'hr') { host.fillRect(PAD_X, y, CONTENT_W, 1, 255, 255, 255, 0.4 * a); continue; }
    if (it.kind === 'img') { drawImg(img(it.key), it.x, y, it.w, it.h, a); continue; }
    if (it.kind === 'line') {
      let la = a * ta;
      if (it.box) {
        if (it.box.item.c === 'selected') { for (const s of it.segs) text(s.f, s.s, s.x, y + it.base, [170, 170, 170], la, 0.7); continue; }
      }
      for (const s of it.segs) text(s.f, s.s, s.x, y + it.base, s.col ? hexCol(s.col) : (it.col || WHITE), la, 0.7);
    }
  }
}
function hexCol(c) { if (Array.isArray(c)) return c; const m = String(c).match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : WHITE; }
function drawChoiceAnim(pg, scrollY) {
  const A = pg.choiceAnim; if (!A) return;
  const box = A.box, t = NOW - A.t0;
  const p = easeOut(clamp(t / 0.4, 0, 1)), y0 = box.y - (scrollY != null ? scrollY : pg.scrollY);
  const scale = 1 + (Math.max(1, Math.min(1.6, W * 0.84 / box.w)) - 1) * p;
  const cx = box.x + box.w / 2, cy = y0 + box.h / 2, tx = W / 2, ty = H * 0.5;
  const x = cx + (tx - cx) * p, y = cy + (ty - cy) * p;
  const a = t < 1.4 ? 1 : clamp(1 - (t - 1.4) / 0.6, 0, 1);
  const bw = box.w * scale, bh = box.h * scale;
  host.roundRect(x - bw / 2, y - bh / 2, bw, bh, 10 * scale, 39, 50, 74, 0.85 * a);
  const px = Math.round(fontPx() * scale), fam = S.font === 'g' ? 'g' : 'm';
  const lay = layout([{ k: 'p', c: '', r: box.item.r }], { px, width: bw - 36 * scale, left: 0, top: 0 });
  const lh = lay.height - px;
  for (const it of lay.items) if (it.kind === 'line') for (const s of it.segs) text(s.f, s.s, x - bw / 2 + 18 * scale + s.x, y - lh / 2 + it.y + it.base, WHITE, a * vol01(S.textb / 100), 0.7);
  void fam;
}
// opt.text: this screen shows the story text (dimmed picture behind it); otherwise only the picture.
// opt.ui: this is the screen you touch (choices apart from the text, the ??? button).
function drawGame(opt) {
  opt = opt || { text: true, ui: true };
  const [sx, sy] = shakeOffset();
  const pg = cur, txt = opt.text, here = apart() && opt.ui && !txt;
  const dimOf = (v) => txt ? v : 0;
  // old page (transition)
  if (T_OLD.pg && T_OLD.kind === 'slide') {
    drawBgLayer(T_OLD.bg, T_OLD.T, 1, sx, sy);
    host.fillRect(0, 0, W, H, 0, 0, 0, dimOf(T_OLD.dim));
    host.fillRect(0, 0, W, H, 0, 0, 0, T_OLD.bright || 0);
    if (txt) drawLayout(T_OLD.pg.lay, T_OLD.pg.scrollY - sy, T_OLD.textA, T_OLD.pg);
    const dx = BG.slide.v * W;
    host.clip(Math.max(0, Math.round(dx)), 0, W, H);
    host.fillRect(dx, 0, W, H, 0, 0, 0, 1);
    drawBgLayer(BG.cur, BG.T, 1, dx + sx, sy);
    host.clip();
  } else {
    if (BG.prev && BG.fade.v < 1 && !(T_OLD.pg && T_OLD.kind === 'fade')) drawBgLayer(BG.prev, BG.T, 1, sx, sy);
    drawBgLayer(BG.cur, BG.T, BG.prev && !(T_OLD.pg && T_OLD.kind === 'fade') ? BG.fade.v : 1, sx, sy);
    if (BG.fade.done) BG.prev = null;
    drawMovie();
    host.fillRect(0, 0, W, H, 0, 0, 0, dimOf(dim.v));
    host.fillRect(0, 0, W, H, 0, 0, 0, bright.v);
    if (pg) {
      if (txt) {
        const pull = pg.pull || (pg.pullAnim ? pg.pullAnim.v : 0);
        drawLayout(pg.lay, pg.scrollY + pull - sy, pg.textA.v, pg);
        if (pg.branch && pg.textA.v > 0) { const b = eimg('branch.png'); if (b) { const bw = Math.min(W * 0.15, 110); drawImg(b, W - bw - 12, 12, bw, b.h * bw / b.w, pg.textA.v); } }
        if (!apart()) drawChoiceAnim(pg);
        drawEndMarker(pg);
        drawScrollbar(pg);
      }
      if (here && pg.clay && pg.revealed) {
        const a = pg.textA.v;
        host.fillRect(0, 0, W, H, 0, 0, 0, 0.45 * a);
        drawLayout(pg.clay, 0, a, pg);
        drawChoiceAnim(pg, 0);
      }
    }
    if (T_OLD.pg && T_OLD.kind === 'fade') {
      const a = T_OLD.a.v;
      if (a > 0) {
        drawBgLayer(T_OLD.bg, T_OLD.T, a, sx, sy);
        host.fillRect(0, 0, W, H, 0, 0, 0, dimOf(T_OLD.dim) * a);
        host.fillRect(0, 0, W, H, 0, 0, 0, (T_OLD.bright || 0) * a);
        if (txt) drawLayout(T_OLD.pg.lay, T_OLD.pg.scrollY - sy, T_OLD.textA * a, T_OLD.pg);
      }
    }
  }
  if (wipeImg && wipeA.v > 0) drawCover(img(wipeImg), 0, 0, W, H, wipeA.v);
  if (opt.ui && pg && pg.secret && !ACC.ok && pg.revealed) {
    const r = { x: W - 90, y: H - 70, w: 76, h: 50 };
    menuButton(r, '???', 1, false); region(r, () => { const s = pg.secret; pg.secret = null; choose(s); });
  }
}
function drawEndMarker(pg) {
  if (!pg.linear || pg.override || ctxNext(pg) || !pg.revealed) return;
  const y = pg.lay.height + 20 - pg.scrollY; if (y > H) return;
  const f = uiFont(18);
  const s = history.some(h => h.branch) ? 'Return to the last choice' : 'Return to Title Screen';
  centerText(f, s, W / 2, y, WHITE, 0.65 * pg.textA.v, 0.6);
}
let sbarT = -10;
function drawScrollbar(pg) {
  const ms = maxScroll(pg); if (ms <= 0) return;
  const a = NOW - sbarT < 0.25 ? 1 : clamp(1 - (NOW - sbarT - 0.25) / 0.3, 0, 1); if (a <= 0) return;
  const pt = W / 320, t0 = 10 * pt, track = H - 60 * pt, docH = ms + H;
  const h = Math.max(30, track * H / docH), top = t0 + (pg.scrollY / ms) * (track - h);
  host.roundRect(W - 10 * pt - 3, clamp(top, t0, t0 + track - h), 3, h, 1.5, 0, 0, 0, 0.55 * a);
}

// ---------- input: regions, touch, scrolling ----------
let regions = [];
function region(r, fn) { if (regionsOn) regions.push({ r, fn }); }
const touches = new Map();
let gesture = null, twoFinger = false;
function hit(r, x, y) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
function onTouch(kind, id, x, y, rear) {
  if (kind === 0) touches.set(id, { x, y, x0: x, y0: y, t0: NOW });
  const t = touches.get(id); if (!t) return;
  if (kind === 0) {
    if (touches.size === 2) twoFinger = true;
    if (touches.size === 1) { twoFinger = false; gesture = { x0: x, y0: y, t0: NOW, moved: false, last: [[NOW, y]], lastx: x }; touchStart(x, y); }
    return;
  }
  if (kind === 1) {
    t.x = x; t.y = y;
    if (gesture && touches.size === 1) {
      if (Math.abs(y - gesture.y0) > 10 || Math.abs(x - gesture.x0) > 10) gesture.moved = true;
      gesture.last.push([NOW, y]); if (gesture.last.length > 6) gesture.last.shift();
      touchMove(x, y);
    }
    return;
  }
  touches.delete(id);
  if (twoFinger) { if (touches.size === 0) { twoFinger = false; gesture = null; if (screen === 'game' && !anyOverlay() && cur) openToc(); } return; }
  if (!gesture) return;
  const g = gesture; gesture = null;
  touchEnd(x, y, g);
}
function scrollTarget() {
  if (overlays.length) { const o = overlays[overlays.length - 1]; return o.scrollable || null; }
  if (screen === 'names' && namesSt.help) return namesSt;
  if (screen === 'game' && cur) return cur;
  return null;
}
function touchStart(x, y) {
  const st = scrollTarget(); if (!st) return;
  st.scroll = st.scroll || { v: 0, target: null };
  st.scroll.v = 0; st.scroll.target = null;
  if (st === cur) { st.startBottom = atBottom(st); st.startTop = st.scrollY <= 2; st.touchHandlers && st.touchHandlers.forEach(fn => { try { fn({}); } catch (e) { } }); }
  gesture.sy0 = st === cur ? st.scrollY : (st.helpScroll || 0);
}
function touchMove(x, y) {
  const top = overlays[overlays.length - 1];
  if (top && top.scrollFn && !top.scrollable && gesture.moved) { top.scrollFn((gesture.ly != null ? gesture.ly : gesture.y0) - y); gesture.ly = y; return; }
  const st = scrollTarget(); if (!st || !gesture.moved) return;
  const dy = y - gesture.y0;
  if (st === cur) {
    let ny = gesture.sy0 - dy; const ms = maxScroll(st);
    if (ny > ms) { st.pull = (ny - ms) * 0.5; ny = ms; } else if (ny < 0) { st.pull = ny * 0.5; ny = 0; } else st.pull = 0;
    st.scrollY = ny; sbarT = NOW;
  } else { st.helpScroll = clamp(gesture.sy0 - dy, 0, helpMax(st)); }
}
function helpMax(st) { return Math.max(0, (st.helpLay ? st.helpLay.height : 0) + 60 - H); }
function touchEnd(x, y, g) {
  const st = scrollTarget();
  if (g.held) return;   // the long press already opened the Table of Contents
  const top = overlays[overlays.length - 1];
  if (g.moved && top && top.swipe && Math.abs(x - g.x0) > 40 && Math.abs(x - g.x0) > Math.abs(y - g.y0)) { top.swipe(x - g.x0); return; }
  if (g.moved && top && top.scrollFn && !top.scrollable) return;
  if (g.moved) {
    if (st) {
      const L = g.last, a = L[0], b = L[L.length - 1], v = b[0] > a[0] ? -(b[1] - a[1]) / (b[0] - a[0]) : 0;
      st.scroll = st.scroll || {}; st.scroll.v = clamp(v, -4000, 4000); st.scroll.target = null;
      if (st === cur) {
        const lim = TH * 0.15;
        if (st.pull > lim / 2 && st.startBottom && st.revealed) { st.pull = 0; st.scroll.v = 0; next(); }
        else if (st.pull < -lim / 2 && st.startTop) { st.pull = 0; st.scroll.v = 0; back(); }
        st.pullAnim = new Tw(st.pull).to(0, 0.25, easeOut); st.pull = 0;
      }
    }
    return;
  }
  // a tap
  const rs = regions.slice().reverse();
  for (const r of rs) if (hit(r.r, x, y)) { r.fn(x, y); return; }
  if (overlays.length) { const o = overlays[overlays.length - 1]; if (o.tap) o.tap(x, y); return; }
  if (screen === 'logos') return;
  if (screen === 'names' && namesSt.help) { leaveIntro(); return; }
  if (screen === 'game' && cur) gameTap(x, y);
}
function gameTap(x, y) {
  const pg = cur;
  if (!pg.revealed) { reveal(pg); return; }
  if (busy || pg.choiceAnim) return;
  const sc = apart() ? 0 : pg.scrollY;   // choices on their own screen do not scroll
  for (const b of pg.choices) if (hit({ x: b.x, y: b.y - sc, w: b.w, h: b.h }, x, y)) { pickChoice(b); return; }
  const edge = W * 0.3;
  if (x < edge || x > W - edge) {
    const fwd = (x > W - edge) === (S.dir !== 'L');
    if (fwd) next(); else back();
    return;
  }
  if (atBottom(pg)) { if (pg.linear) next(); else focusChoices(); }
  else if (apart()) { pg.scroll.target = clamp(pg.scrollY + TH * 0.75, 0, maxScroll(pg)); sbarT = NOW; }   // the text is on the other screen: a tap reads on
}
function scrollBy(st, d) {
  if (st === cur) { st.scrollY = clamp(st.scrollY + d, 0, maxScroll(st)); sbarT = NOW; }
  else st.helpScroll = clamp((st.helpScroll || 0) + d, 0, helpMax(st));
}
function onWheel(n) { const st = scrollTarget(); if (st) scrollBy(st, n * 60); }
function physicsStep(dt) {
  const st = scrollTarget(); if (!st || !st.scroll) return;
  if (gesture && gesture.moved) return;
  if (st.scroll.target != null) {
    const cy = st === cur ? st.scrollY : st.helpScroll, d = st.scroll.target - cy;
    if (Math.abs(d) < 1) { st.scroll.target = null; } else scrollBy(st, d * Math.min(1, dt * 10));
    return;
  }
  const v = st.scroll.v; if (!v) return;
  scrollBy(st, v * dt);
  st.scroll.v = Math.abs(v) < 20 ? 0 : v * Math.pow(0.998, dt * 1000);
}

// ---------- buttons ----------
let enterBtn = 'cross', cancelBtn = 'circle';
// physical d-pad -> direction on the rotated (portrait) screen
function logicalDir(b) {
  const map90 = { right: 'up', left: 'down', up: 'left', down: 'right' }, map270 = { left: 'up', right: 'down', down: 'left', up: 'right' };
  return (S.rot === 270 ? map270 : map90)[b] || b;
}
const held = {};
function onButton(name, down) {
  if (['up', 'down', 'left', 'right'].includes(name)) name = logicalDir(name);
  held[name] = down;
  if (!down) return;
  if (imeSt) return;
  if (name === enterBtn) name = 'ok'; else if (name === cancelBtn) name = 'cancel';
  if (overlays.length) { const o = overlays[overlays.length - 1]; if (o.button && o.button(name) !== false) return; if (name === 'cancel') { (o.back || (() => popOverlay(o)))(); } return; }
  if (screen === 'logos') return;
  if (screen === 'title') {
    const bs = titleButtons();
    if (name === 'up') title.focus = (title.focus + bs.length - 1) % bs.length;
    else if (name === 'down') title.focus = (title.focus + 1) % bs.length;
    else if (name === 'ok' && !bs[title.focus].off) bs[title.focus].fn();
    return;
  }
  if (screen === 'names') {
    if (namesSt.help) { if (name === 'ok' || name === 'cancel') leaveIntro(); return; }
    if (name === 'up') namesSt.focus = (namesSt.focus + 3) % 4; else if (name === 'down') namesSt.focus = (namesSt.focus + 1) % 4;
    else if (name === 'ok') [() => editName('main'), () => editName('sub'), startNew, () => { screen = 'title'; }][namesSt.focus]();
    else if (name === 'cancel') screen = 'title';
    return;
  }
  if (screen !== 'game' || !cur) return;
  const pg = cur;
  switch (name) {
    case 'ok':
      if (!pg.revealed) { reveal(pg); break; }
      if (pg.choices.length && pg.focus >= 0 && atBottom(pg)) { pickChoice(pg.choices[pg.focus]); break; }
      if (!atBottom(pg)) { pg.scroll.target = clamp(pg.scrollY + TH * 0.75, 0, maxScroll(pg)); break; }
      if (pg.linear) next(); else focusChoices();
      break;
    case 'cancel': case 'l': back(); break;
    case 'r': if (pg.linear) next(); else focusChoices(); break;
    case 'down':
      if (pg.choices.length && atBottom(pg)) { pg.focus = Math.min(pg.choices.length - 1, pg.focus + 1); focusChoices(); }
      else pg.scroll.target = clamp(pg.scrollY + TH * 0.4, 0, maxScroll(pg));
      sbarT = NOW; break;
    case 'up':
      if (pg.choices.length && pg.focus > 0) { pg.focus--; focusChoices(); }
      else { pg.focus = -1; pg.scroll.target = clamp(pg.scrollY - TH * 0.4, 0, maxScroll(pg)); }
      sbarT = NOW; break;
    case 'right': if (S.dir !== 'L') next(); else back(); break;
    case 'left': if (S.dir !== 'L') back(); else next(); break;
    case 'triangle': case 'select': openToc(); break;
    case 'start': openSettings(); break;
    case 'square': if (pg.secret && !ACC.ok) { const s = pg.secret; pg.secret = null; choose(s); } break;
  }
}
function leaveIntro() {
  if (namesSt.leaving) return;
  namesSt.leaving = NOW;
  Audio_.stop('bgm', 1);
  setTimer(() => { namesSt.help = false; namesSt.leaving = 0; beginStory(); }, 1000);
}

// ---------- accelerometer: shake for the secret page ----------
const ACC = { ok: false, shakes: [], last: 1 };
function accelStep() {
  const a = host.accel(); ACC.ok = !!a[3]; if (!ACC.ok) return;
  if (!cur || !cur.secret || busy || overlays.length || screen !== 'game') return;
  const mag = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) / 9.81;
  if (Math.abs(mag - 1) > 1 && Math.abs(mag - ACC.last) > 0.5) ACC.shakes.push(NOW);
  ACC.last = mag;
  ACC.shakes = ACC.shakes.filter(t => NOW - t < 1.5);
  if (ACC.shakes.length >= 3) { ACC.shakes = []; const s = cur.secret; cur.secret = null; choose(s); }
}

// ---------- system keyboard ----------
let imeSt = null;
function openIME(initial, done) { imeSt = { buf: '', done, initial: initial || '', t0: NOW }; host.ime(true, initial || ''); }
function onIME(s) {
  if (!imeSt) return;
  if (s === '\n') { const st = imeSt; imeSt = null; host.ime(false); st.done(st.buf); return; }
  if (s === '\b') { imeSt.buf = imeSt.buf.slice(0, -1); return; }
  imeSt.buf += s;
}
function imeStep() {
  if (imeSt && host.vita && !host.imeActive() && NOW - imeSt.t0 > 0.5) { const st = imeSt; imeSt = null; host.ime(false); st.done(st.buf); }
}
function drawIME() {
  if (!imeSt) return;
  host.fillRect(0, 0, W, H, 0, 0, 0, 0.6);
  const f = uiFont(24);
  centerText(f, imeSt.buf + '|', W / 2, H * 0.45, WHITE, 1, 0.6);
  if (!host.vita && !host.n3ds) centerText(uiFont(16), 'Type, then press Enter', W / 2, H * 0.5, [200, 200, 200], 1);
}

// ---------- killer's name ----------
function openKiller() {
  const o = pushOverlay({ name: 'killer', back: () => popOverlay(o) });
  o.draw = () => {
    const a = clamp((NOW - o.t0) / 0.5, 0, 1), r = { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: 220 };
    host.roundRect(r.x, r.y, r.w, r.h, 8, 17, 28, 60, 0.95 * a);
    const f = uiFont(20);
    centerText(f, STR.NameInput_KillerTitle || "Enter the killer's name.", W / 2, r.y + 24, WHITE, a, 0.6);
    const fr = { x: r.x + 24, y: r.y + 70, w: r.w - 48, h: 54 };
    host.roundRect(fr.x, fr.y, fr.w, fr.h, 6, 255, 255, 255, 0.9 * a);
    text(uiFont(22), o.value || '', fr.x + 12, fr.y + 12, [20, 20, 20], a);
    region(fr, () => openIME(o.value, (s) => { o.value = (s || '').trim(); }));
    const ok = { x: r.x + r.w / 2 + 8, y: r.y + 146, w: r.w / 2 - 32, h: 50 }, cn = { x: r.x + 24, y: r.y + 146, w: r.w / 2 - 32, h: 50 };
    menuButton(cn, 'Cancel', a, o.focus === 1); region(cn, () => popOverlay(o));
    menuButton(ok, 'OK', o.value ? a : a * 0.4, o.focus === 0); region(ok, () => submit());
  };
  const submit = () => {
    if (!o.value) return;
    popOverlay(o);
    if (!cur || !cur.fns || !cur.fns.onNameInput) return;
    let r = null; try { r = cur.fns.onNameInput(o.value); } catch (e) { log('onNameInput', e); }
    if (r) choose(r);
  };
  o.focus = 0;
  o.button = (n) => {
    if (n === 'ok') { if (o.focus === 0 && !o.value) openIME('', (s) => { o.value = (s || '').trim(); }); else if (o.focus === 0) submit(); else popOverlay(o); return true; }
    if (n === 'left' || n === 'right' || n === 'up' || n === 'down') { o.focus = 1 - o.focus; return true; }
    return false;
  };
  openIME('', (s) => { o.value = (s || '').trim(); });
}

// ---------- dialogs ----------
function dialog(titleText, body, buttons) {
  const o = pushOverlay({ name: 'dialog', focus: buttons.length - 1 });
  o.draw = () => {
    host.fillRect(0, 0, W, H, 0, 0, 0, 0.6);
    const f = uiFont(20), fb = uiFont(24, true), lines = wrapText(f, body || '', W * 0.72);
    const h = 90 + lines.length * 30 + 80, r = { x: W * 0.08, y: (H - h) / 2, w: W * 0.84, h };
    host.roundRect(r.x, r.y, r.w, r.h, 8, 0, 0, 0, 0.8);
    host.roundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 7, 45, 60, 112, 0.95);
    centerText(fb, titleText, W / 2, r.y + 22, WHITE, 1, 0.6);
    lines.forEach((l, i) => centerText(f, l, W / 2, r.y + 70 + i * 30, [235, 235, 235], 1, 0.4));
    const bw = (r.w - 30 - (buttons.length - 1) * 10) / buttons.length;
    buttons.forEach((b, i) => { const br = { x: r.x + 15 + i * (bw + 10), y: r.y + r.h - 66, w: bw, h: 50 }; menuButton(br, b[0], 1, o.focus === i); region(br, () => { popOverlay(o); if (b[1]) b[1](); }); });
  };
  o.button = (n) => {
    if (n === 'left' || n === 'up') { o.focus = Math.max(0, o.focus - 1); return true; }
    if (n === 'right' || n === 'down') { o.focus = Math.min(buttons.length - 1, o.focus + 1); return true; }
    if (n === 'ok') { popOverlay(o); const f = buttons[o.focus][1]; if (f) f(); return true; }
    return false;
  };
  o.tap = () => { };
  return o;
}

// ---------- Table of Contents (original page jump screen on the 320x480 grid) ----------
function tocChapters() {
  const list = []; let last = null;
  trail.forEach((h, i) => {
    const t = chapterTitleFor(h.id, h.ctx); if (!t) return;
    if (!last || last.title !== t) { last = { title: t, start: { id: h.id, ctx: h.ctx, locals: h.locals, idx: i }, bg: '', end: i }; list.push(last); }
    last.end = i;
    if (!last.bg && D.pageload[h.id]) last.bg = D.pageload[h.id];
  });
  return list;
}
function thumbKey(bg) { if (!bg) return null; const th = bg.replace(/\.jpg$/i, '') + '_th.jpg'; return imgKey(th) || imgKey(bg); }
function openToc() {
  if (!cur || busy) return;
  const bgs = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => 'pagejump_bg_' + c + '@2x~ipad.jpg').filter(f => IMGSET.has(f));
  const list = tocChapters();
  const pos = history.length;
  let sel = list.findIndex(c => c.start.idx <= pos && pos <= c.end); if (sel < 0) sel = list.length - 1;
  const o = pushOverlay({ name: 'toc', bg: bgs.length ? bgs[Math.floor(Math.random() * bgs.length)] : null, list, sel: Math.max(0, sel), pos: new Tw(Math.max(0, sel)) });
  const BH = Math.min(W * 1.5, H), BW = BH / 1.5, BX = (W - BW) / 2, BY = (H - BH) / 2;   // the original 320x480 layout, fitted
  const R = (px, py, pw, ph) => ({ x: BX + px * BW, y: BY + py * BH, w: pw * BW, h: ph * BH });
  const jump = () => {
    const c = o.list[o.sel]; if (!c) return;
    popOverlay(o);
    history = trail.slice(0, c.start.idx).map(h => Object.assign({}, h));
    setLocalFlags(c.start.locals);
    goto(c.start.id, { noHistory: true, ctx: c.start.ctx, fade: 0.5, force: true });
  };
  const move = (d) => { o.sel = clamp(o.sel + d, 0, o.list.length - 1); o.pos.to(o.sel, 0.25, easeOut); };
  o.draw = () => {
    host.fillRect(0, 0, W, H, 0, 0, 0, 1);
    if (o.bg) drawCover(img(o.bg), 0, 0, W, H, 1);
    const pj = (n) => eimg(n);
    const tb = [['pj_share.png', 0.006, share], ['pj_option.png', 0.3336, () => openSettings()], ['pj_backtitle.png', 0.6612, () => dialog('Return to Title Screen', 'Return to the title screen?', [['Cancel'], ['OK', () => toTitle()]])]];
    tb.forEach(([n, x, fn]) => { const r = R(x, 0.0083, 0.3328, 0.0635); drawImg(pj(n), r.x, r.y, r.w, r.h, 1); region(r, fn); });
    const band = pj('pj_title_bg.png');
    const b1 = R(0, 0.083, 1, 0.0667), b2 = R(0, 0.142, 1, 0.0667);
    drawImg(band, b1.x, b1.y, b1.w, b1.h, 1); drawImg(band, b2.x, b2.y, b2.w, b2.h, 1);
    const fBig = uiFont(BW * 0.056), fSm = uiFont(BW * 0.026), fCh = uiFont(BW * 0.05);
    const t1 = STR.PageJump_Title0 || 'Table of Contents', t2 = STR.PageJump_Title1 || '(Jump to Chapter Start)';
    const w1 = tw(fBig, t1), w2 = tw(fSm, t2), tx = BX + (BW - w1 - w2 - 6) / 2;
    text(fBig, t1, tx, b1.y + (b1.h - fBig.h) / 2, WHITE, 1, 0.6); text(fSm, t2, tx + w1 + 6, b1.y + (b1.h - fBig.h) / 2 + fBig.asc - fSm.asc, WHITE, 1, 0.6);
    const c = o.list[o.sel];
    if (c) centerText(fCh, c.title, BX + BW / 2, b2.y + (b2.h - fCh.h) / 2, WHITE, 1, 0.6);
    // card
    const jt = BY + 0.22 * BH, jh = 0.70 * BH;
    const card = { x: BX + 0.256 * BW, y: jt + 0.036 * jh, w: 0.488 * BW, h: 0.545 * jh };
    if (c) {
      const pic = img(thumbKey(c.bg) && imgKey(c.bg) ? imgKey(c.bg) : thumbKey(c.bg));
      host.fillRect(card.x + card.w * 0.08, card.y + card.h * 0.055, card.w * 0.84, card.h * 0.89, 0, 0, 0, 1);
      if (pic) { host.clip(card.x + card.w * 0.08, card.y + card.h * 0.055, card.w * 0.84, card.h * 0.89); drawCover(pic, card.x + card.w * 0.08, card.y + card.h * 0.055, card.w * 0.84, card.h * 0.89, 1); host.clip(); }
    }
    drawImg(pj('pj_frame_01.png'), card.x, card.y, card.w, card.h, 1);
    region(card, jump);
    const sw = pj('pj_swipe.png');
    const al = { x: BX + 0.02 * BW, y: jt + 0.08 * jh, w: 0.1 * BW, h: 0.46 * jh }, ar = { x: BX + BW - 0.12 * BW, y: al.y, w: al.w, h: al.h };
    if (sw) { drawImg(sw, al.x, al.y, al.w, al.h, 0.9); host.drawImage(sw.id, 0, 0, sw.w, sw.h, ar.x, ar.y, ar.w, ar.h, 0.9, 180); }
    region(al, () => move(-1)); region(ar, () => move(1));
    // thumbnails strip
    const th = R(0, 0.63, 1, 0.27);
    drawImg(pj('pj_thumbnail_bg.png'), th.x, th.y, th.w, th.h, 1);
    host.clip(th.x, th.y, th.w, th.h);
    const tw_ = 0.18 * BW, thh = 0.24 * BW, cy = th.y + th.h / 2;
    o.list.forEach((ch, i) => {
      const x = BX + BW / 2 + (i - o.pos.v) * tw_ - tw_ / 2; if (x < BX - tw_ || x > BX + BW) return;
      const r = { x, y: cy - thh / 2, w: tw_, h: thh };
      host.fillRect(r.x + 2, r.y, r.w - 4, r.h, 0, 0, 0, 1);
      const p = img(thumbKey(ch.bg)); if (p) { host.clip(Math.max(th.x, r.x + 2), r.y, r.w - 4, r.h); drawCover(p, r.x + 2, r.y, r.w - 4, r.h, 1); host.clip(th.x, th.y, th.w, th.h); }
      region(r, () => { o.sel = i; o.pos.to(i, 0.25, easeOut); });
    });
    host.clip();
    const fs = pj('pj_frame_02.png'); if (fs) { const w = 0.28 * BW, h = 0.335 * BW; drawImg(fs, BX + BW / 2 - w / 2, cy - h / 2, w, h, 1); }
    const sv = R(0.006, 1 - 0.009 - 0.0635, 0.3328, 0.0635), rt = R(1 - 0.006 - 0.3328, 1 - 0.009 - 0.0635, 0.3328, 0.0635);
    drawImg(pj('pj_save.png'), sv.x, sv.y, sv.w, sv.h, 1); region(sv, () => openSaves('save'));
    drawImg(pj('pj_back.png'), rt.x, rt.y, rt.w, rt.h, 1); region(rt, () => popOverlay(o));
  };
  o.swipe = (dx) => move(dx < 0 ? 1 : -1);
  o.button = (n) => {
    if (n === 'left' || n === 'up') { move(-1); return true; } if (n === 'right' || n === 'down') { move(1); return true; }
    if (n === 'ok') { jump(); return true; } if (n === 'triangle' || n === 'select') { popOverlay(o); return true; }
    if (n === 'square') { openSaves('save'); return true; } if (n === 'start') { openSettings(); return true; }
    return false;
  };
  o.tap = () => { };
}
function share() {
  const c = cur ? chapterTitleFor(cur.id, cur.ctx) : '';
  dialog('Share', "Banshee's Last Cry: " + c + ' #BansheesLastCry\n\nThe ' + PLATFORM + ' can\'t post this for you; share it from another device.', [['Close']]);
}

// ---------- save data page ----------
function openSaves(mode) {
  const o = pushOverlay({ name: 'saves', focus: 0, scrollable: null });
  const cache = {};
  const get = (k) => { if (!(k in cache)) cache[k] = LS.get(k, null); return cache[k]; };
  o.scroll = 0; o.cellY = [];
  o.draw = () => {
    host.fillRect(0, 0, W, H, 12, 12, 13, 1);
    let y = 90 - o.scroll;
    host.clip(0, 64, W, H - 64);
    const f = uiFont(18);
    if (mode === 'save') { wrapText(f, STR.ConfigSave_HeadMessage || 'Saving story data. Is it okay to overwrite?', W - 60).forEach(l => { centerText(f, l, W / 2, y, [200, 200, 200], 1); y += 26; }); y += 10; }
    const cells = [];
    if (mode === 'load') cells.push(['auto', get('auto')]);
    SLOTS.forEach(k => cells.push([k, get(k)]));
    cells.forEach(([k, s], i) => {
      const r = { x: 24, y, w: W - 48, h: 150 };
      saveCell(r, s, o.focus === i);
      if (k === 'auto') { centerText(uiFont(15, false, true), STR.ConfigSave_AutoSaveSectionFooter || 'Auto Save', W / 2, y + 156, [150, 150, 150], 1); y += 30; }
      const act = () => {
        if (mode === 'load') { if (s) { overlays.length = 0; loadState(s); } return; }
        const doSave = () => { const sn = snapshot(); if (sn) { LS.set(k, sn); delete cache[k]; toast('Saved'); } };
        if (s) dialog(STR.Config_Save || 'Save Data', STR.BookMarkCell_overwriteLabel || 'Overwrite this data', [['Cancel'], ['OK', doSave]]); else doSave();
      };
      if (r.y + r.h > 64) region(r, act);
      r.act = act; o.cellsList = cells; cells[i].act = act; o.cellY[i] = r.y + o.scroll;
      y += 170;
    });
    host.clip();
    o.contentH = y + o.scroll;
    navBar(mode === 'save' ? (STR.Config_Save || 'Save Data') : (STR.Config_Save || 'Save Data'), 'Back', () => popOverlay(o));
  };
  const show = () => { const cy = o.cellY[o.focus]; if (cy == null) return; if (cy - o.scroll + 170 > H) o.scroll = cy + 170 - H; if (cy - o.scroll < 70) o.scroll = Math.max(0, cy - 90); };
  o.scrollFn = (d) => { o.scroll = clamp(o.scroll + d, 0, Math.max(0, (o.contentH || 0) - H + 20)); };
  o.button = (n) => {
    const nCells = (mode === 'load' ? 1 : 0) + SLOTS.length;
    if (n === 'up') { o.focus = (o.focus + nCells - 1) % nCells; show(); return true; } if (n === 'down') { o.focus = (o.focus + 1) % nCells; show(); return true; }
    if (n === 'ok' && o.cellsList && o.cellsList[o.focus]) { o.cellsList[o.focus].act(); return true; }
    return false;
  };
  o.tap = () => { };
}
function saveCell(r, s, focus) {
  host.roundRect(r.x, r.y, r.w, r.h, 10, 255, 255, 255, s ? 0.96 : 0.9);
  if (focus) host.roundRect(r.x - 4, r.y, 4, r.h, 2, 168, 55, 44, 1);
  const tw0 = r.h * 0.75;
  host.fillRect(r.x + 1 + tw0, r.y, 1, r.h, 60, 60, 60, 1);
  host.fillRect(r.x + 1 + tw0, r.y + r.h * 0.75, r.w - tw0 - 1, 1, 60, 60, 60, 1);
  if (s) { const th = img(thumbKey(s.bg)); if (th) { host.clip(r.x + 4, r.y + 4, tw0 - 6, r.h - 8); drawCover(th, r.x + 4, r.y + 4, tw0 - 6, r.h - 8, 1); host.clip(); } }
  const fmt = STR.ConfigSave_DataCharFormat || 'The Story of %@ and %@', none = STR.ConfigSave_NoDataPlayerName || '**';
  const story = s ? fmt.replace('%@', s.names.main).replace('%@', s.names.sub) : fmt.replace('%@', none).replace('%@', none);
  const avail = r.w - tw0 - 20, fit = (str, px) => { let f = font('m', 0, 0, px); while (px > 10 && tw(f, str) > avail) f = font('m', 0, 0, --px); return f; };
  const fs = font('m', 0, 0, 15);
  text(fit(story, 19), story, r.x + tw0 + 12, r.y + 12, [90, 90, 90], 1);
  if (s && s.title) text(fit(s.title, 19), s.title, r.x + tw0 + 12, r.y + 46, [40, 40, 40], 1);
  const when = s ? new Date(s.time).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '-') : (STR.ConfigSave_NoDataDate || '****-**-** **:**:**');
  text(fs, when, r.x + tw0 + 12, r.y + r.h * 0.75 + 10, [110, 110, 110], 1);
}
function navBar(titleText, backLabel, onBack) {
  host.fillRect(0, 0, W, 64, 12, 12, 13, 1); host.fillRect(0, 63, W, 1, 44, 42, 39, 1);
  const f = uiFont(19), fb = uiFont(15);
  let size = 19, tf = f; while (tw(tf, titleText.toUpperCase()) > W - 220 && size > 11) { size--; tf = uiFont(size); }
  centerText(tf, titleText.toUpperCase(), W / 2, 64 - 12 - tf.h, WHITE, 1);
  if (backLabel) { const r = { x: 0, y: 0, w: 150, h: 64 }; text(fb, '‹ ' + backLabel, 18, 64 - 14 - fb.h, [154, 148, 138], 1); region(r, onBack); }
}

// ---------- settings ----------
const fxLabels = { shake: 'Screen shake', off: 'Off' };
function openSettings() {
  const o = pushOverlay({ name: 'settings', stack: [], focus: 0 });
  const page = (title, rowsFn, extra) => ({ title, rowsFn, extra });
  const choice = (title, key, opts, after) => page(title, () => opts.map(([v, l]) => ({ label: l, check: S[key] === v, fn: () => { S[key] = v; saveSettings(); if (after) after(); } })));
  const slider = (label, key, min, max, step, after) => ({ label, slider: { key, min, max, step }, after });
  const dirL = { R: STR.ConfigPageDirection_Right || 'Right', L: STR.ConfigPageDirection_Left || 'Left' };
  const goreL = [STR.ConfigViolence_Nothing || 'Low', STR.ConfigViolence_Blur || 'Medium', STR.ConfigViolence_Normal || 'High'];
  const relayoutAll = () => { updTH(); if (cur) relayout(cur); };
  const root = page(STR.Config_Title || 'Settings', () => [
    { head: '' },
    { label: STR.Config_Brightness || 'Brightness', fn: () => push(page(STR.Config_Brightness || 'Brightness', () => [{ preview: 1 }, slider(STR.ConfigBrightness_Background || 'Background Brightness', 'bgb', 0, 100, 5, () => applyDim()), slider(STR.ConfigBrightness_Character || 'Text Brightness', 'textb', 30, 100, 5)])) },
    { label: STR.Config_Character || 'Text', fn: () => push(page(STR.Config_Character || 'Text', () => [{ preview: 1 }, slider(STR.Config_Size || 'Size', 'size', 1, 10, 1, relayoutAll),
      { label: 'Font', detail: S.font === 'g' ? 'Gothic' : 'Mincho', fn: () => push(choice('Font', 'font', [['m', 'Mincho'], ['g', 'Gothic']], relayoutAll)) },
      { note: 'Due to port limitations, Mincho shows Libre Baskerville and Gothic shows Lato.' }])) },
    { label: STR.Config_PageDirection || 'Page Direction', detail: dirL[S.dir], fn: () => push(choice(STR.Config_PageDirection || 'Page Direction', 'dir', [['L', dirL.L], ['R', dirL.R]])) },
    { label: STR.Config_Violence || 'Gore Level', detail: goreL[S.gore], fn: () => push(choice(STR.Config_Violence || 'Gore Level', 'gore', [[0, goreL[0]], [1, goreL[1]], [2, goreL[2]]])) },
    { label: STR.Config_Sound || 'Volume', fn: () => push(page(STR.Config_Sound || 'Volume', () => [slider('Volume', 'master', 0, 100, 5), { head: 'Granular control' }, slider('Music', 'bgm', 0, 100, 5), slider('Ambience', 'env', 0, 100, 5), slider('Sound Effects', 'se', 0, 100, 5)])) },
    { label: STR.Config_Save || 'Save Data', fn: () => openSaves(inGame && cur ? 'save' : 'load') },
    { head: '' },
    { label: STR.Config_HowToPlay || 'How to Play', fn: () => openHelp('howtoplay') },
    { label: STR.Config_ProductInfo || 'Product Infomation', fn: () => productInfo() },
    { head: 'Port-specific settings' },
    { label: 'Vibration', detail: fxLabels[S.fx], fn: () => push(choice('Vibration', 'fx', [['shake', 'Screen shake'], ['off', 'Off']])) },
    DUAL ? { label: 'Text screen', detail: S.ts === 'bottom' ? 'Touch screen' : 'Top screen', fn: () => push(choice('Text screen', 'ts', [['top', 'Top screen'], ['bottom', 'Touch screen']], () => { updTH(); relayoutAll(); })) } : null,
    DUAL ? { label: 'Holding the 3DS', detail: S.rot === 270 ? 'Top screen right' : 'Top screen left', fn: () => push(choice('Holding the 3DS', 'rot', [[90, 'Top screen left'], [270, 'Top screen right']], () => host.setRotation(S.rot))) }
      : { label: 'Screen orientation', detail: S.rot === 270 ? 'Rotate left' : 'Rotate right', fn: () => push(choice('Screen orientation', 'rot', [[90, 'Rotate right'], [270, 'Rotate left']], () => host.setRotation(S.rot))) },
    { label: 'Back up saves', fn: backupSaves },
    { label: 'Restore saves', fn: restoreSaves },
    { label: 'Erase progress', danger: 1, fn: resetProgress }
  ]);
  const push = (p) => { o.stack.push(p); o.focus = 0; o.scroll = 0; };
  push(root);
  o.back = () => { o.stack.pop(); o.focus = 0; o.scroll = 0; if (!o.stack.length) { popOverlay(o); if (cur) relayout(cur); } };
  o.draw = () => {
    const p = o.stack[o.stack.length - 1];
    host.fillRect(0, 0, W, H, 12, 12, 13, 1);
    navBar(p.title, o.stack.length > 1 ? o.stack[o.stack.length - 2].title : (STR.Config_ButtonBack || 'Return'), o.back);
    const rows = p.rowsFn().filter(Boolean);
    o.rows = rows.filter(r => r.fn || r.slider);
    let y = 80 - (o.scroll || 0);
    const f = uiFont(20), fd = uiFont(17), fh = uiFont(13);
    host.clip(0, 64, W, H - 64);
    let fi = 0;
    for (const r of rows) {
      if (r.head != null) { y += 20; if (r.head) { text(fh, r.head.toUpperCase(), 22, y, [168, 55, 44], 1); y += 22; } continue; }
      if (r.note) { wrapText(fh, r.note, W - 44).forEach(l => { text(fh, l, 22, y, [119, 114, 106], 1); y += 20; }); y += 6; continue; }
      if (r.preview) { const pr = { x: 22, y, w: W - 44, h: 220 }; drawPreview(pr); y += 236; continue; }
      const focus = o.focus === fi; fi++;
      const rr = { x: 0, y, w: W, h: 56 };
      if (focus) host.fillRect(22, y + 4, 3, 48, 168, 55, 44, 1);
      if (r.slider) {
        const sl = r.slider, v = S[sl.key];
        text(f, r.label, 32, y + 4, WHITE, 1);
        text(fd, String(v), W - 22 - tw(fd, String(v)), y + 6, [154, 148, 138], 1);
        const tx = 32, tw2 = W - 64, ty = y + 40, k = (v - sl.min) / (sl.max - sl.min);
        host.fillRect(tx, ty, tw2, 3, 60, 58, 54, 1); host.fillRect(tx, ty, tw2 * k, 3, 168, 55, 44, 1);
        host.roundRect(tx + tw2 * k - 8, ty - 7, 16, 16, 8, 230, 226, 220, 1);
        region({ x: 0, y: y + 22, w: W, h: 40 }, (x) => { S[sl.key] = clamp(Math.round((sl.min + (x - tx) / tw2 * (sl.max - sl.min)) / sl.step) * sl.step, sl.min, sl.max); saveSettings(); if (r.after) r.after(); });
        r.adjust = (d) => { S[sl.key] = clamp(v + d * sl.step, sl.min, sl.max); saveSettings(); if (r.after) r.after(); };
        y += 66;
      } else {
        text(f, r.label, 32, y + 14, r.danger ? [207, 75, 60] : (r.check ? WHITE : [232, 228, 220]), 1);
        if (r.detail) text(fd, r.detail, W - 44 - tw(fd, r.detail), y + 17, [154, 148, 138], 1);
        if (r.check) host.roundRect(W - 46, y + 21, 14, 14, 7, 168, 55, 44, 1);
        else if (!r.slider) text(f, '›', W - 30, y + 13, [120, 115, 108], 1);
        host.fillRect(22, y + 55, W - 44, 1, 31, 30, 28, 1);
        region(rr, r.fn);
        y += 56;
      }
    }
    host.clip();
    o.contentH = y + (o.scroll || 0);
  };
  o.button = (n) => {
    const rows = o.rows || [];
    if (n === 'up') { o.focus = Math.max(0, o.focus - 1); ensureVisible(); return true; }
    if (n === 'down') { o.focus = Math.min(rows.length - 1, o.focus + 1); ensureVisible(); return true; }
    const r = rows[o.focus];
    if ((n === 'left' || n === 'right') && r && r.adjust) { r.adjust(n === 'left' ? -1 : 1); return true; }
    if (n === 'ok' && r && r.fn) { r.fn(); return true; }
    if (n === 'start') { while (o.stack.length) o.back(); return true; }
    return false;
  };
  const ensureVisible = () => { const y = 80 + o.focus * 60; if (y - (o.scroll || 0) > H - 120) o.scroll = y - H + 160; if (y - (o.scroll || 0) < 80) o.scroll = Math.max(0, y - 100); };
  o.tap = () => { };
  o.scrollFn = (d) => { o.scroll = clamp((o.scroll || 0) + d, 0, Math.max(0, (o.contentH || 0) - H + 40)); };
}
function drawPreview(r) {
  host.clip(r.x, r.y, r.w, r.h);
  drawCover(img(imgKey('gerende2.jpg')), r.x, r.y, r.w, r.h, 1);
  host.fillRect(r.x, r.y, r.w, r.h, 0, 0, 0, Math.min(85, 100 - S.bgb) / 100);
  const fam = S.font === 'g' ? 'g' : 'm', f = font(fam, 0, 0, fontPx() * 0.8);
  const sample = 'It was my first time snowboarding, but somehow I managed to make it to the bottom of the hill.';
  wrapText(f, sample, r.w - 30).forEach((l, i) => text(f, l, r.x + 15, r.y + 14 + i * f.h * 1.4, WHITE, vol01(S.textb / 100), 0.7));
  host.clip();
}
function productInfo() {
  if (D.help.productinfo || D.help.product) { openHelp(D.help.productinfo ? 'productinfo' : 'product'); return; }
  dialog(STR.Config_ProductInfo || 'Product Infomation', "Banshee's Last Cry\n© Spike Chunsoft / Aksys Games.\n\nSlop's Last Cry is an unofficial port that plays your own copy of the game.", [['Close']]);
}
function backupSaves() {
  const data = {};
  for (const k of ['settings', 'global', 'names', 'auto'].concat(SLOTS)) { const v = LS.get(k, null); if (v != null) data['blc_' + k] = JSON.stringify(v); }
  const ok = host.write(DATA + 'backup/slops-last-cry-backup.json', JSON.stringify({ app: 'slops-last-cry', version: 1, data }));
  dialog('Back up saves', ok ? 'Saved to ' + DATA + 'backup/slops-last-cry-backup.json. It uses the same format as the PC and Android versions.' : 'Could not write the backup file.', [['OK']]);
}
function restoreSaves() {
  const s = host.read(DATA + 'backup/slops-last-cry-backup.json');
  if (!s) { dialog('Restore saves', 'Put a backup file at ' + DATA + 'backup/slops-last-cry-backup.json first (from any version of Slop\'s Last Cry).', [['OK']]); return; }
  dialog('Restore saves', 'Replace your saves, progress and settings with the backup?', [['Cancel'], ['Restore', () => {
    try {
      const j = JSON.parse(s), d = j.data || j;
      for (const k in d) if (/^blc_/.test(k)) LS.set(k.slice(4), JSON.parse(d[k]));
      loadProgress(); toast('Saves restored');
      if (cur) relayout(cur);
    } catch (e) { toast('That backup could not be read'); }
  }]]);
}
function resetProgress() {
  dialog('Erase progress', 'Erase all progress (pages read, unlocked choices and saved data)? Settings are kept.', [['Cancel'], ['Erase', () => {
    ['global', 'auto'].concat(SLOTS).forEach(LS.del);
    flags = {}; visited.clear(); chapSeen.length = 0; toast('Progress erased'); toTitle();
  }]]);
}

// ---------- frame ----------
let started = false, stickAcc = 0;
function main() {
  NOW = host.time();
  enterBtn = host.enterCircle ? 'circle' : 'cross'; cancelBtn = host.enterCircle ? 'cross' : 'circle';
  if (!loadStory()) { screen = 'boot'; return; }
  loadProgress();
  started = true;
  playLogos(() => openTitle());
}
function frame(dt, lx, ly, rx, ry) {
  NOW = host.time();
  regions = [];
  if (!started) { drawBoot(); return; }
  runTimers();
  Audio_.tick();
  if (Math.floor(NOW) !== Math.floor(NOW - dt)) sndGC();
  accelStep(); imeStep();
  // analog sticks scroll (mapped to the portrait screen)
  const st = scrollTarget();
  const sy = S.rot === 270 ? lx : -lx, sy2 = S.rot === 270 ? rx : -rx;
  const v = Math.abs(sy) > 0.25 ? sy : Math.abs(sy2) > 0.25 ? sy2 : 0;
  if (v && st) { scrollBy(st, v * 900 * dt); }
  else if (v && overlays.length && overlays[overlays.length - 1].scrollFn) overlays[overlays.length - 1].scrollFn(v * 900 * dt);
  void ly; void ry;
  physicsStep(dt);
  if (cur && cur.dirty) relayout(cur);
  // 3DS has no two-finger tap: holding a finger still on the touch screen opens the Table of Contents
  if (DUAL && gesture && !gesture.moved && !gesture.held && NOW - gesture.t0 > 0.7 && touches.size === 1 && screen === 'game' && !anyOverlay() && cur && !busy) { gesture.held = true; openToc(); }
  for (let i = 0; i < SCR.length; i++) drawScreen(i);
  useScr(UI);
}
function drawScreen(i) {
  useScr(i);
  const ui = i === UI;
  if (ui) regions = [];
  if (screen === 'logos') { if (i === 0) drawLogos(); }
  else if (screen === 'title') drawTitle(DUAL ? (ui ? 'menu' : 'art') : 'all');
  else if (screen === 'names') {
    if (ui) drawNames(); else drawCover(img(imgKey('s_house.jpg')), 0, 0, W, H, 1);
    if (namesSt.leaving) host.fillRect(0, 0, W, H, 0, 0, 0, clamp((NOW - namesSt.leaving) / 1, 0, 1));
  } else if (screen === 'game') drawGame({ text: !DUAL || i === textScr(), ui });
  if (!ui) return;
  // overlays: only the top one takes input (regions drawn earlier are discarded)
  overlays.forEach((o, k) => { if (k === overlays.length - 1) regions = []; o.draw(); });
  if (NOW - toastT < 2.2) {
    const f = uiFont(18), w = tw(f, toastMsg) + 40, a = clamp((2.2 - (NOW - toastT)) / 0.3, 0, 1);
    host.roundRect((W - w) / 2, H * 0.86, w, 44, 22, 0, 0, 0, 0.75 * a); centerText(f, toastMsg, W / 2, H * 0.86 + (44 - f.h) / 2, WHITE, a);
  }
  drawIME();
  if (imeSt) regions = [];
}
function drawBoot() {
  for (let i = 0; i < SCR.length; i++) {
    useScr(i); if (i !== UI) continue;
    const f = uiFont(DUAL ? 17 : 20);
    const msg = DUAL
      ? "Slop's Last Cry needs your game files.\n\nOn a PC, open setup.html from the web version, convert your .ipa, then press \"Make 3DS files\". Copy the slc-3ds folder it makes to your SD card as " + DATA.replace('sdmc:/', '') + ", then start the game again.\n\nPress any button to exit."
      : "Slop's Last Cry needs your game files.\n\nOn a PC, open setup.html from the web version, convert your .ipa, then press \"Make PS Vita files\". Copy the slc-vita folder it makes to this Vita as " + DATA + " (for example with VitaShell), then start the game again.\n\nPress any button to exit.";
    const lines = wrapText(f, msg, W - (DUAL ? 40 : 70));
    lines.forEach((l, k) => text(f, l, DUAL ? 20 : 35, (DUAL ? 30 : 160) + k * f.h * 1.3, WHITE, 1));
  }
}
const _onButton = onButton;
globalThis.onButton = function (n, d) { if (!started) { if (d) host.quit(); return; } _onButton(n, d); };
const _onTouch = onTouch;
globalThis.onTouch = function (k, id, x, y, r) { if (!started) { if (k === 2) host.quit(); return; } _onTouch(k, id, x, y, r); };
globalThis.onIME = onIME;
globalThis.onWheel = onWheel;
globalThis.frame = frame;
globalThis.main = main;

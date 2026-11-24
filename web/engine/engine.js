/*
 * Local engine for Banshee's Last Cry (Kamaitachi no Yoru, iOS 2014, Aksys localization).
 * Reimplements in the browser the native "km" bridge used by the iOS app, and reads the
 * original scenes, images, music and videos from the ink-en.app folder.
 * Personal use with your own copy of the game.
 */
(function () {
  'use strict';
  const D = window.BLC_DATA;
  if (!D) {
    // The game files have not been converted yet: send the player to the setup.
    document.body.innerHTML = '<div style="color:#ddd;font:16px/1.6 Georgia,serif;max-width:32em;margin:15vh auto;padding:0 1.5em;text-align:center">' +
      "<p>The game files haven't been set up yet.</p><p><a href=\"setup.html\" style=\"color:#fff\">Open the setup</a> and choose your copy of the game.</p></div>";
    return;
  }
  // Optional bridge provided by the Android app (share sheet, saving files).
  const NATIVE = window.SLCNative || null;
  // Files converted by an older setup: the app reruns the conversion on what it already extracted.
  const SETUP_VERSION = 2;
  if (NATIVE && (D.setupVersion || 1) < SETUP_VERSION) { location.replace('setup.html?update=1'); return; }

  const APP = 'ink-en.app/';
  const LPROJ = new Set(D.lproj), ROOT = new Set(D.root);
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('blc_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('blc_' + k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { localStorage.removeItem('blc_' + k); } catch (e) { } }
  };
  const log = (...a) => console.log('[BLC]', ...a);
  // Touch devices behave like the original iOS app: swipe to read, one tap at the end turns the page.
  const TOUCH = window.matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  document.documentElement.classList.toggle('touch', TOUCH);
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  // ---------- Assets ----------
  function imgPath(name) {
    if (!name) return null;
    const base = name.replace(/\.(jpg|png)$/i, ''), ext = (name.match(/\.(jpg|png)$/i) || ['.jpg'])[0];
    const hi = base + '@2x~ipad' + ext;
    if (LPROJ.has(hi)) return APP + 'en.lproj/' + hi;
    if (LPROJ.has(name)) return APP + 'en.lproj/' + name;
    if (ROOT.has(hi)) return APP + hi;
    if (ROOT.has(name)) return APP + name;
    return null;
  }
  function audioPath(name) {
    if (!name) return null;
    // .aif (IMA4) and .m4a (Apple Lossless) cannot be played by browsers; the setup converted them
    // (to .webm Opus; older folders made by hand use .ogg).
    if (/\.(aif|m4a)$/i.test(name)) {
      const b = name.replace(/\.(aif|m4a)$/i, '');
      return ROOT.has(name) ? 'engine/audio/' + b + (D.audioExt || '.ogg') : null;
    }
    // .mp4 music converted by newer setups (Android's WebView could not play the originals)
    if (D.audioConv && D.audioConv.indexOf(name) >= 0) return 'engine/audio/' + name + (D.audioExt || '.webm');
    return ROOT.has(name) ? APP + name : null;
  }
  const url = (p) => p ? enc(p) : null;

  // ---------- Settings and progress ----------
  // Defaults follow the original app (KMAppDelegate setDefaultSetting): text size 5 of 10, text brightness 1.0,
  // background brightness 0.7, gore level 1 (Medium), page direction "R".
  const DEF = { size: 5, font: 'm', bgb: 70, textb: 100, gore: 1, dir: 'R', master: 100, bgm: 90, env: 80, se: 100, back: true, saves: true, toc: true };
  const S = Object.assign({}, DEF, LS.get('settings', {}));
  S.saves = true; S.toc = true; S.back = true;   // always on, as in the original game
  // Vibration effect: real vibration on touch devices that support it, screen shake otherwise.
  // The Android app asks the system whether there is a vibration motor (many tablets have none).
  const CAN_VIBRATE = TOUCH && typeof navigator.vibrate === 'function' && (!NATIVE || !NATIVE.hasVibrator || NATIVE.hasVibrator());
  if (!S.fx || (S.fx === 'vibrate' && !CAN_VIBRATE)) S.fx = CAN_VIBRATE ? 'vibrate' : 'shake';
  const G = Object.assign({ flags: {}, visited: [], chapters: [] }, LS.get('global', {}));
  const visited = new Set(G.visited);
  const chapSeen = G.chapters.slice();
  const LOCAL = /^(local_|flag_from_|flag_name_|_main_$|flag_mc4030_1time$)/;
  let flags = Object.assign({}, G.flags);      // all flags (global + local)
  let names = LS.get('names', { main: D.strings.NameInput_MainName || 'Max', sub: D.strings.NameInput_SubName || 'Grace' });
  function saveSettings() { LS.set('settings', S); }
  let gTimer = 0;
  function saveGlobal() {
    clearTimeout(gTimer);
    gTimer = setTimeout(() => {
      const gf = {};
      for (const k in flags) if (!LOCAL.test(k)) gf[k] = flags[k];
      LS.set('global', { flags: gf, visited: Array.from(visited), chapters: chapSeen });
    }, 200);
  }
  function localFlags() { const o = {}; for (const k in flags) if (LOCAL.test(k)) o[k] = flags[k]; return o; }
  function setLocalFlags(o) { for (const k in flags) if (LOCAL.test(k)) delete flags[k]; Object.assign(flags, o || {}); }

  // ---------- Audio ----------
  const vol01 = (v) => Math.max(0, Math.min(1, v));
  class Track {
    constructor(file, ch, vol, rep) {
      this.file = file; this.ch = ch; this.vol = 0; this.target = vol; this.rep = rep; this.fade = null; this.dead = false;
      const p = audioPath(file);
      this.loop = D.loops[file.replace(/\.\w+$/, '')];
      if (this.loop && !(this.loop[1] > this.loop[0] && this.loop[0] >= 0)) this.loop = null;
      this.el = p ? new Audio(url(p)) : null;
      if (!this.el) this.dead = true;
      if (this.el) {
        this.el.preload = 'auto';
        if (rep === -1 && !this.loop) this.el.loop = true;
        this.el.addEventListener('ended', () => {
          if (this.dead) return;
          if (this.rep > 0) { this.rep--; this.el.currentTime = this.loop ? this.loop[0] / this.loop[2] : 0; this.el.play().catch(() => { }); }
          else if (this.rep === -1) { this.el.currentTime = this.loop ? this.loop[0] / this.loop[2] : 0; this.el.play().catch(() => { }); }
          else this.stop(0);
        });
        this.el.addEventListener('error', () => log('audio missing', file));
      }
    }
    // The original opens files instantly, so its fades begin with the sound. Here the file may take a
    // moment to load, so the fade-in (and whatever the new track replaces) waits until playback really
    // starts; otherwise a short fade would be over before anything is heard.
    start(fadeIn, onStart) {
      if (!this.el) { if (onStart) onStart(); return this; }
      this.apply();
      let begun = false;
      const begin = () => {
        if (begun) return; begun = true;
        if (this.dead || this.stopping) { if (onStart) onStart(); return; }   // stopped before it got going
        this.fadeTo(this.target, fadeIn);
        if (onStart) onStart();
      };
      this.el.addEventListener('playing', begin, { once: true });
      setTimeout(begin, 1500);   // never hold the previous track for long if this one is slow or broken
      if (Audio_.suspended) this.held = true;   // the app is in the background: start when it comes back
      else this.el.play().catch(e => { log('play blocked', this.file, e.message); begin(); });
      return this;
    }
    fadeTo(v, t, onEnd) { this.fade = { from: this.vol, to: v, t0: performance.now(), dur: Math.max(0, (t || 0) * 1000), onEnd }; if (!t) this.step(performance.now()); }
    stop(t) { if (this.dead) return; if (!t) { this.kill(); return; } this.fadeTo(0, t, () => this.kill()); this.stopping = true; }
    kill() { this.dead = true; if (this.el) { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); } }
    apply() { if (this.el) this.el.volume = vol01(this.vol * (S.master / 100) * (S[this.ch] / 100)); }
    step(now) {
      if (this.dead || !this.el) return;
      if (this.fade) {
        const f = this.fade, k = f.dur ? Math.min(1, (now - f.t0) / f.dur) : 1;
        this.vol = f.from + (f.to - f.from) * k;
        if (k >= 1) { this.fade = null; if (f.onEnd) f.onEnd(); }
      }
      this.apply();
      if (this.loop && this.rep !== 0 && !this.el.paused) {
        const end = this.loop[1] / this.loop[2];
        if (this.el.currentTime >= end - 0.012) {
          this.el.currentTime = this.loop[0] / this.loop[2] + (this.el.currentTime - end);
          if (this.rep > 0) this.rep--;
        }
      }
    }
  }
  const Audio_ = {
    bgm: null, env: null, se: new Set(), fading: new Set(), suspended: false,
    // Pause everything while the app is in the background (as iOS does) and pick up where it left off.
    suspend() {
      if (this.suspended) return; this.suspended = true;
      for (const t of [this.bgm, this.env, ...this.se, ...this.fading])
        if (t && !t.dead && t.el && !t.el.paused) { t.held = true; t.el.pause(); }
      const mv = document.querySelector('video');
      if (mv && !mv.paused) { mv.dataset.held = '1'; mv.pause(); }
    },
    resume() {
      if (!this.suspended) return; this.suspended = false;
      for (const t of [this.bgm, this.env, ...this.se, ...this.fading])
        if (t && t.held) { t.held = false; if (!t.dead && t.el) t.el.play().catch(() => { }); }
      const mv = document.querySelector('video');
      if (mv && mv.dataset.held) { delete mv.dataset.held; mv.play().catch(() => { }); }
    },
    tick() {
      const n = performance.now();
      for (const t of [this.bgm, this.env, ...this.se, ...this.fading]) if (t) t.step(n);
      for (const t of this.se) if (t.dead) this.se.delete(t);
      for (const t of this.fading) if (t.dead) this.fading.delete(t);
    },
    retire(t, time) { if (!t || t.dead) return; t.stop(time); if (!t.dead) this.fading.add(t); },
    // Original KMViewController playBgm_*: plain play stops the current track at once (unless it is
    // already fading out) and fades the new one in; crossfade fades the new one in over fadeIn while
    // the old one fades out over the crossfade time. Both happen when the new track starts sounding.
    play(ch, file, vol, fadeIn, rep, cross) {
      if (ch === 'se') { const t = new Track(file, 'se', vol, rep).start(fadeIn); this.se.add(t); return; }
      const old = this[ch];
      if (old && !old.dead && !old.stopping) this.fading.add(old);
      const t = new Track(file, ch, vol, rep);
      this[ch] = t;
      t.start(fadeIn || 0, () => { if (old && !old.stopping) this.retire(old, cross || 0); });
    },
    change(ch, file, vol, fadeIn, rep, cross) {
      if (ch === 'se') {
        for (const t of this.se) if (t.file === file && !t.dead && !t.stopping) { t.fadeTo(vol, fadeIn || 0.3); return; }
        return this.play(ch, file, vol, fadeIn, rep, cross);
      }
      // Original changeBgm_*: if the same file is already playing it only updates the repeat count
      // (overwriteLoopFromScript) and leaves the volume alone; otherwise it plays the new file.
      const cur = this[ch];
      if (cur && cur.file === file && !cur.dead && !cur.stopping) {
        cur.rep = rep; if (cur.el) cur.el.loop = rep === -1 && !cur.loop; return;
      }
      this.play(ch, file, vol, fadeIn, rep, cross);
    },
    stop(ch, t) {
      if (ch === 'se') { for (const x of this.se) this.retire(x, t); this.se.clear(); return; }
      this.retire(this[ch], t); this[ch] = null;
      // a track still waiting to be replaced by one that hasn't started yet stops too
      for (const x of this.fading) if (x.ch === ch && !x.stopping) this.retire(x, t);
    },
    stopAll(t) { this.stop('bgm', t); this.stop('env', t); this.stop('se', t); },
    refresh() { for (const t of [this.bgm, this.env, ...this.se, ...this.fading]) if (t) t.apply(); movie.volume = vol01((S.master / 100) * (S.bgm / 100)); }
  };
  setInterval(() => Audio_.tick(), 20);

  // ---------- Stage ----------
  const stage = $('#stage'), bgslide = $('#bgslide'), slideold = $('#slideold'), bgwrap = $('#bgwrap'), bgA = $('#bgA'), bgB = $('#bgB'), movie = $('#movie');
  const dim = $('#dim'), bright = $('#bright'), wipe = $('#wipe'), textlayer = $('#textlayer'), backdrop = $('#backdrop');
  let bgFront = bgA, bgCur = null;
  const branchIcon = document.createElement('img');
  branchIcon.id = 'branchicon'; branchIcon.src = 'engine/img/branch.png'; branchIcon.alt = 'BRANCH';
  stage.appendChild(branchIcon);
  const T = { x: 0, y: 0, sx: 1, sy: 1, cx: 0.5, cy: 0.5, rot: 0 };
  function applyDim() { dim.style.opacity = (Math.min(85, 100 - S.bgb) / 100).toFixed(2); }
  let bgName = '', bgInstant = false;
  function setBgImage(name) {
    const p = imgPath(name);
    if (p === bgCur) return;
    bgCur = p; bgName = name || '';
    const back = bgFront === bgA ? bgB : bgA;
    back.style.backgroundImage = p ? 'url("' + url(p) + '")' : 'none';
    // During a page slide the new background arrives with the page, so it replaces the old one at once.
    const tr = bgInstant ? 'none' : '';
    back.style.transition = bgFront.style.transition = tr;
    back.classList.add('on'); bgFront.classList.remove('on'); bgFront = back;
    if (bgInstant) { void back.offsetWidth; back.style.transition = ''; }
    backdrop.style.backgroundImage = p ? 'url("' + url(p) + '")' : 'none';
  }
  function applyT(t) {
    bgwrap.style.transition = t > 0 ? 'transform ' + t + 's linear' : 'none';
    bgwrap.style.transformOrigin = (T.cx * 100) + '% ' + (T.cy * 100) + '%';
    bgwrap.style.transform = 'translate(' + (T.x * 100) + '%,' + (T.y * 100) + '%) scale(' + T.sx + ',' + T.sy + ') rotate(' + T.rot + 'deg)';
  }
  function resetT() { Object.assign(T, { x: 0, y: 0, sx: 1, sy: 1, cx: 0.5, cy: 0.5, rot: 0 }); applyT(0); }
  function setBright(v, t) {
    bright.style.transition = t > 0 ? 'opacity ' + t + 's linear' : 'none';
    void bright.offsetWidth;
    bright.style.opacity = vol01(+v || 0);
  }
  function shake() {
    if (S.fx === 'vibrate') { try { navigator.vibrate(400); } catch (e) { } return; }
    if (S.fx !== 'shake') return; stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake'); }
  let movieKeep = false;
  function playMovie(file, rep) {
    const p = ROOT.has(file) ? APP + file : null;
    movieKeep = true;
    if (!p) return;
    const u = url(p);
    if (movie.dataset.src !== u) { movie.dataset.src = u; movie.src = u; }
    movie.loop = rep === -1;
    movie.volume = vol01((S.master / 100) * (S.bgm / 100));
    movie.classList.add('on');
    movie.play().catch(e => log('movie blocked', e.message));
  }
  function stopMovie() { movie.pause(); movie.classList.remove('on'); movie.removeAttribute('src'); movie.dataset.src = ''; movie.load(); }
  movie.addEventListener('ended', () => { if (!movie.loop) movie.classList.remove('on'); });

  // ---------- Game state ----------
  const CH = D.chapters;
  let cur = null;            // { id, win, doc, ctx, linear, override, secret }
  let history = [];
  // The trail is the full reading path: history, the current page and, after jumping back with the
  // Table of Contents, the pages that come after it. trail[i] matches history[i]; the original keeps
  // later chapters available until the story takes a different path.
  let trail = [];
  let busy = false;
  let inGame = false;

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

  // ---------- km bridge (called by the scene scripts) ----------
  function parseSel(a) {
    const m = String(a).match(/^((\w+):)?(\w+)?(\s*)?(\S.*)?$/);
    if (!m) return null;
    return { type: m[2], target: m[3], args: m[5] ? m[5].split(/\s+/) : [] };
  }
  function makeKm(win) {
    const doc = win.document;
    const hideArray = [];
    const km = {
      // audio
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
      // background
      setBg: (a) => setBgImage(a || 'wh.jpg'),
      setBgViolence: (a, b, c) => setBgImage([a, b, c][+S.gore] || a || 'wh.jpg'),
      slideBGImage_ox_oy_w_h_tx_ty_dur: (a) => setBgImage(a || 'wh.jpg'),
      setBrightness: (v, t) => setBright(v, t),
      slideBg_x_y_time: (x, y, t) => { T.x = +x; T.y = +y; applyT(t); },
      slideBg_x_y_x_y_time: (x0, y0, x1, y1, t) => { T.x = +x0; T.y = +y0; applyT(0); void bgwrap.offsetWidth; T.x = +x1; T.y = +y1; applyT(t); },
      rotateBg_rot_cx_cy_time: (r, cx, cy, t) => { T.rot = +r; T.cx = +cx; T.cy = +cy; applyT(t); },
      rotateBg_rot_rot_cx_cy_time: (r0, r1, cx, cy, t) => { T.rot = +r0; T.cx = +cx; T.cy = +cy; applyT(0); void bgwrap.offsetWidth; T.rot = +r1; applyT(t); },
      scaleBg_sx_sy_cx_cy_time: (sx, sy, cx, cy, t) => { T.sx = +sx; T.sy = +sy; T.cx = +cx || 0.5; T.cy = +cy || 0.5; applyT(t); },
      scaleBg_sx_sy_time: (sx, sy, t) => { T.sx = +sx; T.sy = +sy; applyT(t); },
      scaleBg_scale_time: (s, t) => { T.sx = T.sy = +s; applyT(t); },
      scaleBg_scale_cx_cy_time: (s, cx, cy, t) => { T.sx = T.sy = +s; T.cx = +cx; T.cy = +cy; applyT(t); },
      playMovie_mw_mh_oy_rep: (f, mw, mh, oy, rep) => playMovie(f, rep),
      playMovie_oy_rep: (f, oy, rep) => playMovie(f, rep),
      // timers
      setTimeout: (fn, ms) => win.setTimeout(typeof fn === 'function' ? fn : () => win.eval(String(fn)), ms),
      clearTimeoutTable: () => { },
      // flags
      getFlag: (n) => n === '_unlocked_' ? 1 : n === '_is_ipad_' ? 0 : n === '_is_gothic_font_' ? (S.font === 'g' ? 1 : 0) : n === '_font_size_' ? fontPx() : (flags[n] || 0),
      setFlag: (n, v) => { flags[n] = v; if (!LOCAL.test(n)) saveGlobal(); },
      debugInitFlags: () => { },
      getf: () => flags._main_ || 0,
      setf: (v) => { flags._main_ = v; },
      isUnlocked: () => 1,
      isIPad: () => 0,
      isFontGothic: () => S.font === 'g' ? 1 : 0,
      getFontSizePx: () => fontPx(),
      // flow
      pushSelectPage: (n) => { if (cur && cur.win === win) cur.override = n; },
      // On phones the secret is reached by shaking the device, like the original; the button remains
      // for computers and for devices that do not report motion.
      pushSecretPage: (s) => { if (cur && cur.win === win) { cur.secret = s; if (!(TOUCH && motionSeen)) $('#secretbtn').classList.add('on'); } },
      altBranch: (t) => choose('alt:' + t),
      fltBranch: (t, x, d) => choose('flt:' + t + ' ' + (d || 1)),
      transitionBranch: (t, x, img, d) => choose('trs:' + t + ' ' + img + ' ' + (d || 0.5)),
      nameInput: () => openKiller(),
      returnTitle: () => toTitle(),
      returnStart: () => restartStory(),
      chargeAlert: () => { },
      refreshCharge: () => { },
      consoleLog: (a) => log('page:', a),
      callPageJavaScriptEnd: () => { },
      // DOM (used by km.js -> removeElementById)
      hideElementById: (id) => { const e = doc.getElementById(id); if (e) { hideArray.push(e); e.remove(); } },
      refreshHide: () => { },
      listToArray: (a) => a ? Array.from(a) : null,
      parseSelectString: (a) => { const p = parseSel(a); return p ? [p.type, p.target, p.args.join(' '), p.args] : null; },
      isBranchPage: () => (cur && !cur.linear) ? '1' : '',
      scriptFlagsFromProg_: flags
    };
    // typos present in some original scene scripts
    km.stopBgm_fadeoust = km.stopBgm_fadeout;
    km.changeSe_Volume_fadein_repeat = km.changeSe_volume_fadein_repeat;
    km.changeBgm_Volume_fadein_repeat = km.changeBgm_volume_fadein_repeat;
    return new Proxy(km, { get: (o, k) => (k in o) ? o[k] : (typeof k === 'string' ? (() => log('km.' + k + ' not implemented')) : undefined) });
  }
  window.ENGINE = { makeKm };

  // ---------- Text ----------
  // Text size uses the original 1 to 10 scale (5 is the default).
  function sizeMul() { const v = +S.size; return (v >= 1 && v <= 10 ? 1 + (v - 5) * 0.1 : 1); }
  // Wide screens (tablets, computers) use the original iPad layout; narrow ones the iPhone layout.
  let WIDE = false;
  function updateWide() {
    const w = Math.min(window.innerWidth, window.innerHeight * 0.75);
    const was = WIDE; WIDE = w >= 600;
    document.documentElement.classList.toggle('wide', WIDE);
    return was !== WIDE;
  }
  updateWide();
  function fontPx() { return Math.round(Math.max(TOUCH ? 16 : 14, stage.clientWidth * (WIDE ? 0.034 : TOUCH ? 0.045 : 0.040)) * sizeMul()); }
  // Fonts offered by the original app: "Marion-Regular" (Mincho setting) and "Euphemia UCAS" (Gothic setting).
  // Marion and Euphemia UCAS are Apple system fonts. Where Marion is missing the port uses its bundled
  // Libre Baskerville (SIL Open Font License, engine/fonts), then common system serifs.
  const FONT_STACKS = {
    m: ['Marion', 'Marion-Regular', 'Libre Baskerville Port', 'Georgia', 'Palatino Linotype', 'Times New Roman'],
    g: ['Euphemia UCAS', 'Euphemia', 'Segoe UI', 'Helvetica Neue', 'Arial']
  };
  const FONT_NAMES = { 'Marion-Regular': 'Marion', 'Libre Baskerville Port': 'Libre Baskerville', 'Euphemia': 'Euphemia UCAS' };
  function fontFamily() {
    return FONT_STACKS[S.font === 'g' ? 'g' : 'm'].map(f => '"' + f + '"').join(', ') + (S.font === 'g' ? ', sans-serif' : ', serif');
  }
  const FONT_FACE_CSS = ['400-normal', '400-italic', '700-normal', '700-italic'].map(v => {
    const [w, st] = v.split('-');
    return "@font-face{font-family:'Libre Baskerville Port';font-style:" + st + ";font-weight:" + w + ";font-display:block;src:url('" +
      new URL('engine/fonts/LibreBaskerville-' + v + '.woff2', location.href).href + "') format('woff2')}";
  }).join('\n');
  // Which font of the current stack this device actually shows (measured against a generic font).
  function fontInUse(kind) {
    const c = document.createElement('canvas').getContext('2d'), txt = 'mmmmmmmmmmlli WQ@#gyj 0123456789';
    for (const f of FONT_STACKS[kind]) {
      if (f === 'Libre Baskerville Port') return 'Libre Baskerville';
      let differs = false;
      for (const g of ['monospace', 'serif', 'sans-serif']) {
        c.font = '40px ' + g; const a = c.measureText(txt).width;
        c.font = '40px "' + f + '", ' + g; if (c.measureText(txt).width !== a) { differs = true; break; }
      }
      if (differs) return FONT_NAMES[f] || f;
    }
    return kind === 'g' ? 'a generic sans-serif font' : 'a generic serif font';
  }
  function frameCss() {
    const fam = fontFamily();
    return `${FONT_FACE_CSS}
html,body{background:transparent!important;margin:0}
body{font-family:${fam};font-size:${fontPx()}px;line-height:1.55;padding:7% 8% 0;color:rgba(255,255,255,${(Math.max(30, S.textb) / 100).toFixed(2)});cursor:default;overflow-wrap:break-word}
p{margin:0 0 1em}
::-webkit-scrollbar{display:none}html{scrollbar-width:none}
#__sbar{position:fixed;right:2px;top:0;width:3px;border-radius:2px;background:rgba(0,0,0,.55);box-shadow:0 0 0 1px rgba(255,255,255,.45);opacity:0;transition:opacity .3s;pointer-events:none;z-index:9999}
#__sbar.on{opacity:1;transition:none}
li[kmsel]{cursor:pointer;transition:filter .15s}li[kmsel]:hover{filter:brightness(1.35)}
li.select,li.selected,li.select_lock{padding:16px 18px!important}
li.select_lock{color:#fff!important}
#__next{display:block;text-align:center;opacity:.65;font-size:.9em;margin:1.2em 0 2.5em;cursor:pointer;user-select:none}
#__next:hover{opacity:1}
html.touch #__next{display:none}
html.touch #__next.deadend{display:block}
#__pad{height:30vh}
.cipher_en,p.cipher_en{white-space:pre-wrap}`;
  }
  function buildDoc(html) {
    const base = new URL(APP, location.href).href;
    return '<!DOCTYPE html><html class="' + (TOUCH ? 'touch' : '') + '"><head><meta charset="utf-8"><base href="' + base + '">' +
      '<style>' + D.css + '</style><style id="__css">' + frameCss() + '</style>' +
      '<script>window.km=parent.ENGINE.makeKm(window);' +
      'try{Object.defineProperty(document,"height",{get:function(){return document.documentElement.scrollHeight}})}catch(e){}' +
      'window.onerror=function(m,s,l){parent.console.warn("[BLC] page error:",m,"line",l)};<\/script>' +
      '<script>' + D.kmjs + '<\/script></head><body>' + html + '</body></html>';
  }

  function goto(id, opt) {
    opt = opt || {};
    if (window.BLC_FAST) { opt.fade = 0; opt.wipe = null; }
    if (!D.pages[id]) { toast('Missing page: ' + id); log('missing page', id); return; }
    if (busy && !opt.force) return;
    busy = true; stage.classList.add('busy');
    const prev = cur;
    if (prev && !opt.noHistory) {
      history.push({ id: prev.id, ctx: prev.ctx, locals: prev.localsAtEntry, branch: !prev.linear });
      if (history.length > 1500) { history.shift(); trail.shift(); }
    }
    if (prev) { try { prev.win.leave && prev.win.leave(); } catch (e) { log('leave error', e); } }
    const fade = opt.fade != null ? +opt.fade : 0.35;
    const old = prev && prev.frame;
    // Original page turn (KMPageScrollView): the whole page, background and text, slides away while the
    // next page's background slides in from the side; its text appears a moment later.
    if (opt.slide && old && !opt.wipe && !window.BLC_FAST) {
      slideold.innerHTML = '';
      const ob = document.createElement('div'), od = document.createElement('div');
      ob.style.backgroundImage = bgCur ? 'url("' + url(bgCur) + '")' : 'none';
      ob.style.transform = bgwrap.style.transform; ob.style.transformOrigin = bgwrap.style.transformOrigin;
      od.className = 'sdim'; od.style.opacity = getComputedStyle(dim).opacity;
      slideold.append(ob, od);
      slideold.style.transition = 'none'; slideold.style.transform = '';
      old.style.transition = 'none';
      entrySlide = { old };
      mount(id, opt, null);
      return;
    }
    if (old) { old.style.transitionDuration = Math.min(fade, 0.6) + 's'; old.classList.remove('on'); }
    // the background shows at full brightness between pages
    if (!window.BLC_FAST) { dim.style.transition = 'opacity ' + Math.min(Math.max(fade, 0.3), 0.6) + 's'; dim.style.opacity = 0; }
    if (opt.wipe) {
      const p = imgPath(opt.wipe);
      if (p) { wipe.style.backgroundImage = 'url("' + url(p) + '")'; wipe.style.transition = 'opacity ' + (fade / 2) + 's'; wipe.style.opacity = 1; }
    }
    const delay = old ? Math.min(fade, 0.6) * 1000 : 0;
    setTimeout(() => mount(id, opt, old), delay);
  }

  let entrySlide = null;
  function mount(id, opt, old) {
    if (old) old.remove();
    const slide = entrySlide; entrySlide = null;
    bgInstant = !!slide;
    branchIcon.classList.remove('on');
    $('#secretbtn').classList.remove('on');
    resetT();
    movieKeep = false;
    const ctx = opt.ctx || locate(id, cur && cur.ctx && cur.ctx.chap);
    const entry = { id, ctx, override: null, secret: null, linear: true, localsAtEntry: localFlags(), slide, revealed: false };
    {
      const pos = history.length;
      if (trail.length < pos) trail = history.map(h => ({ id: h.id, ctx: h.ctx, locals: h.locals }));
      if (!(trail[pos] && trail[pos].id === id)) { trail.length = pos; trail.push({ id, ctx, locals: entry.localsAtEntry }); }
      else trail[pos].ctx = ctx;
    }
    cur = entry;
    const f = document.createElement('iframe');
    f.setAttribute('title', 'story');
    entry.frame = f;
    textlayer.appendChild(f);
    f.addEventListener('load', () => onFrameLoad(entry, opt), { once: true });
    f.srcdoc = buildDoc(D.pages[id]);
    entry.win = f.contentWindow;
    // progress
    visited.add(id);
    const ct = CH[id] && CH[id].t ? id : null;
    if (ct && chapSeen.indexOf(ct) < 0) chapSeen.push(ct);
    saveGlobal();
  }

  function onFrameLoad(entry, opt) {
    if (cur !== entry) return;
    const win = entry.frame.contentWindow, doc = win.document;
    entry.win = win; entry.doc = doc;
    // character names
    $$('var', doc).forEach(v => {
      const s = doc.createElement('span');
      if (v.className === 'char1') s.textContent = names.main;
      else if (v.className === 'char2') s.textContent = names.sub;
      else return;
      v.replaceWith(s);
    });
    // purchase-only content: the game is treated as unlocked
    $$('[name=charge]', doc).forEach(e => e.remove());
    try { win.ready && win.ready(); } catch (e) { log('ready error', entry.id, e); }
    // choices
    const sels = $$('[kmsel]', doc);
    sels.forEach((li, i) => {
      const s = li.getAttribute('kmsel');
      const p = parseSel(s);
      if (li.className === 'select_lock') li.className = 'select';
      if (p && p.target && visited.has(p.target) && li.className === 'select') li.className = 'selected';
      li.dataset.n = i + 1;
      li.addEventListener('click', ev => { ev.stopPropagation(); if (busy || selAnim || anyOpen()) return; if (/^nameInput/.test(s)) choose(s); else animateChoice(li, () => choose(s)); });
    });
    entry.linear = sels.length === 0;
    entry.choices = sels;
    // original "BRANCH" icon: top-right corner on pages with choices
    entry.branch = sels.length > 0 && !sels.some(li => /^returnStart/.test(li.getAttribute('kmsel')));
    branchIcon.classList.toggle('on', entry.branch);
    applyBranchPad(entry);
    const end = doc.createElement('div');
    if (entry.linear) {
      end.id = '__next'; end.textContent = '▼';
      end.addEventListener('click', ev => { ev.stopPropagation(); next(); });
      doc.body.appendChild(end);
    }
    const pad = doc.createElement('div'); pad.id = '__pad'; doc.body.appendChild(pad);
    // events inside the scene document
    doc.addEventListener('click', ev => {
      if (!entry.revealed) { ev.stopPropagation(); reveal(entry); return; }
      if (ev.target.closest && ev.target.closest('a,input,button')) return;
      if (!TOUCH) { advance(); return; }
      // Original controls (KMViewController tapProc): the outer 96 of 320 points on each side turn the page.
      // With page direction "R" the right edge goes forward and the left edge goes back; "L" swaps them
      // (checked against the original on an emulator).
      const x = ev.clientX, w = win.innerWidth, edge = w * 0.3;
      if (x < edge || x > w - edge) {
        const fwd = (x > w - edge) === (S.dir !== 'L');
        if (fwd || !S.back) sideAdvance(); else back();
      } else tapAdvance();
    });
    doc.addEventListener('keydown', onKey);
    // iOS-style scroll indicator: a thin bar on the right that shows while the text scrolls and
    // fades out shortly after it stops, as in the original.
    {
      const bar = doc.createElement('div'); bar.id = '__sbar'; doc.body.appendChild(bar);
      let t = 0;
      win.addEventListener('scroll', () => {
        const de = doc.documentElement, vh = win.innerHeight, sh = de.scrollHeight;
        if (sh <= vh + 2) return;
        const h = Math.max(30, vh * vh / sh), top = (win.scrollY / (sh - vh)) * (vh - h);
        bar.style.height = h + 'px'; bar.style.transform = 'translateY(' + Math.max(0, Math.min(vh - h, top)) + 'px)';
        bar.classList.add('on'); clearTimeout(t); t = setTimeout(() => bar.classList.remove('on'), 250);
      }, { passive: true });
    }
    if (TOUCH) {
      // Original: dragging past the end of the page by 15% of its height turns to the next page
      // (KMPageScrollView scrollEndOverY); past the top goes back when going back is allowed.
      // While dragging past either end the text follows the finger at half speed and springs back
      // when released, like the original page view.
      let sy = null, startBottom = false, startTop = false;
      const body = doc.body;
      const pull = (px, anim) => { body.style.transition = anim ? 'transform .25s ease-out' : 'none'; body.style.transform = px ? 'translateY(' + px + 'px)' : ''; };
      doc.addEventListener('touchstart', ev => {
        if (ev.touches.length !== 1) { sy = null; pull(0, true); return; }
        sy = ev.touches[0].clientY; startBottom = atBottom(); startTop = win.scrollY <= 2;
      }, { passive: true });
      doc.addEventListener('touchmove', ev => {
        if (sy == null || ev.touches.length !== 1) return;
        const dy = ev.touches[0].clientY - sy;
        if (startBottom && dy < 0 && atBottom()) pull(dy * 0.5);
        else if (startTop && dy > 0 && win.scrollY <= 2) pull(dy * 0.5);
        else pull(0);
      }, { passive: true });
      doc.addEventListener('touchend', ev => {
        if (sy == null || !ev.changedTouches.length) return;
        const dy = ev.changedTouches[0].clientY - sy, lim = win.innerHeight * 0.15; sy = null;
        if (startBottom && dy < -lim && atBottom()) sideAdvance();
        else if (startTop && dy > lim && S.back && win.scrollY <= 2) back();
        pull(0, true);
      }, { passive: true });
      let two = false;
      doc.addEventListener('touchstart', ev => { if (ev.touches.length === 2) two = true; }, { passive: true });
      doc.addEventListener('touchend', ev => { if (two && ev.touches.length === 0) { two = false; if (inGame && !anyOpen()) openToc(); } }, { passive: true });
    }
    const stopAuto = () => { try { win.clearTimeout(win.stop_scroll); } catch (e) { } };
    doc.addEventListener('mousedown', stopAuto); doc.addEventListener('wheel', stopAuto, { passive: true });
    doc.addEventListener('contextmenu', ev => { ev.preventDefault(); back(); });
    // show
    const fade = opt.fade != null ? Math.max(0.25, +opt.fade) : 0.35;
    if (opt.wipe) { wipe.style.transition = 'opacity ' + (fade / 2 + 0.2) + 's'; wipe.style.opacity = 0; }
    bgInstant = false;
    try { win.focus(); } catch (e) { }
    // As in the original, the new background is first shown on its own at full brightness; the text
    // (and the background dimming) fades in a moment later. A tap during that pause shows it at once.
    const HOLD = 0.6;
    const begin = () => {
      busy = false; stage.classList.remove('busy');
      if (window.BLC_FAST) reveal(entry);
      else entry.holdT = setTimeout(() => reveal(entry), HOLD * 1000);
      startPage();
    };
    if (entry.slide && !window.BLC_FAST) {
      busy = true; stage.classList.add('busy');
      const old = entry.slide.old;
      const d = (opt.back ? -1 : 1) * (S.dir === 'L' ? -1 : 1);   // "Right": the next page comes in from the right
      dim.style.transition = 'none'; dim.style.opacity = 0;
      bgslide.style.transition = 'none'; bgslide.style.transform = 'translateX(' + (d * 100) + '%)';
      void bgslide.offsetWidth;
      const tr = 'transform .3s ease-out';
      [bgslide, slideold, old].forEach(el => { el.style.transition = tr; });
      bgslide.style.transform = '';
      slideold.style.transform = old.style.transform = 'translateX(' + (-d * 100) + '%)';
      setTimeout(() => {
        old.remove(); slideold.innerHTML = ''; slideold.style.transition = 'none'; slideold.style.transform = '';
        bgslide.style.transition = 'none';
        if (cur === entry) begin();
      }, 320);
    } else {
      // a fade: wait for the background crossfade before the pause
      if (window.BLC_FAST) begin();
      else { busy = false; stage.classList.remove('busy'); startPage(); entry.holdT = setTimeout(() => reveal(entry), (0.6 + HOLD) * 1000); }
    }
    function startPage() {
      setTimeout(() => {
      if (cur !== entry) return;
      if (!opt.back && !opt.load) { try { win.enter && win.enter(); } catch (e) { log('enter error', e); } }
      try { win.play && win.play(); } catch (e) { log('play error', entry.id, e); }
      if (!movieKeep) stopMovie();
      if (entry.linear && !entry.override && !ctxNext(entry)) {
        const mk = entry.doc.getElementById('__next');
        if (mk) { mk.textContent = history.some(h => h.branch) ? '↩ Return to the last choice' : '↩ Return to Title Screen'; mk.classList.add('deadend'); }
      }
      autosave();
      preloadNext(entry);
      }, 60);
    }
  }
  // Shows the page's text and dims the background to the player's setting.
  function reveal(entry) {
    if (!entry || entry.revealed) return;
    entry.revealed = true; clearTimeout(entry.holdT);
    const t = window.BLC_FAST ? 0 : 0.3;
    dim.style.transition = 'opacity ' + t + 's'; applyDim();
    entry.frame.style.transitionDuration = t + 's';
    entry.frame.classList.add('on');
  }

  // Keep the first lines of text clear of the BRANCH icon until the reader scrolls.
  function applyBranchPad(entry) {
    if (!entry || !entry.doc || !entry.doc.body) return;
    const b = entry.doc.body;
    if (!entry.branch) { b.style.paddingTop = ''; return; }
    const r = branchIcon.getBoundingClientRect(), st = stage.getBoundingClientRect();
    const iconBottom = (r.height ? r.bottom - st.top : 12 + Math.min(st.width * 0.15, 110) * 64 / 108);
    b.style.paddingTop = Math.max(st.width * 0.07, iconBottom + 10) + 'px';
  }

  function preloadNext(entry) {
    const ids = [];
    if (entry.override) ids.push(entry.override);
    if (entry.ctx) { const s = seqOf(entry.ctx.chap); if (s && s[entry.ctx.idx + 1]) ids.push(s[entry.ctx.idx + 1]); }
    (entry.choices || []).forEach(li => { const p = parseSel(li.getAttribute('kmsel')); if (p && p.target) ids.push(p.target); });
    ids.forEach(i => { const b = D.pageload[i]; const p = b && imgPath(b); if (p) { const im = new Image(); im.src = url(p); } });
  }

  function ctxNext(entry) {
    const c = entry.ctx, s = c && seqOf(c.chap);
    if (s && c.idx + 1 < s.length) {
      const id = s[c.idx + 1];
      return { id, ctx: (CH[id] && CH[id].p) ? { chap: id, idx: 0 } : { chap: c.chap, idx: c.idx + 1 } };
    }
    // original script directives left as HTML comments (/ifnot N page, /jump page)
    const html = D.pages[entry.id] || '';
    const m = html.match(/\/ifnot\s+(\d+)\s+(\w+)/);
    if (m && !flags['global_' + m[1]] && D.pages[m[2]]) return { id: m[2] };
    const j = html.match(/\/jump\s+(\w+)/);
    if (j && D.pages[j[1]]) return { id: j[1] };
    return null;
  }
  function next() {
    if (!cur || busy || anyOpen()) return;
    if (!cur.linear) { flashChoices(); return; }
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
  function flashChoices() {
    const c = cur && cur.choices && cur.choices[0];
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function atBottom() {
    const w = cur.win, d = w.document.documentElement;
    const pad = w.document.getElementById('__pad');
    const limit = d.scrollHeight - w.innerHeight - (pad ? pad.offsetHeight : 0);
    return w.scrollY >= limit - 6;
  }
  function advance() {
    if (cur && !cur.revealed && !busy) { reveal(cur); return; }
    if (!cur || !cur.win || busy || selAnim || anyOpen()) return;
    if (!atBottom()) { cur.win.scrollBy({ top: cur.win.innerHeight * 0.75, behavior: 'smooth' }); return; }
    if (cur.linear) next(); else flashChoices();
  }
  // Touch: scrolling is done by swiping; a tap only turns the page once the end has been reached.
  function tapAdvance() {
    if (cur && !cur.revealed && !busy) { reveal(cur); return; }
    if (!cur || !cur.win || busy || selAnim || anyOpen()) return;
    if (!atBottom()) return;
    if (cur.linear) next(); else flashChoices();
  }
  function sideAdvance() {
    if (cur && !cur.revealed && !busy) { reveal(cur); return; }
    if (!cur || !cur.win || busy || selAnim || anyOpen()) return;
    if (cur.linear) next(); else flashChoices();
  }
  // Choice selection, as in the original (KMWebSelectRect): the rest of the page fades out while the
  // chosen option glides to the middle of the screen and grows (0.4 s); it stays there for a moment,
  // fades out, and then the next page appears.
  let selAnim = false;
  function animateChoice(li, done) {
    if (window.BLC_FAST || !cur || !cur.doc) return done();
    selAnim = true; stage.classList.add('busy');
    dim.style.transition = 'opacity .3s linear'; dim.style.opacity = 0;
    const doc = cur.doc, win = cur.win, r = li.getBoundingClientRect();
    const wrap = li.parentNode.cloneNode(false);
    const c = li.cloneNode(true);
    c.style.margin = '0';
    wrap.appendChild(c);
    Object.assign(wrap.style, {
      position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', margin: '0', padding: '0',
      listStyle: 'none', zIndex: 99999, transformOrigin: '50% 50%', pointerEvents: 'none',
      transition: 'transform .4s ease-out, opacity .6s linear'
    });
    [...doc.body.children].forEach(el => { el.style.transition = 'opacity .3s linear'; el.style.opacity = '0'; });
    doc.body.appendChild(wrap);
    const vw = win.innerWidth, vh = win.innerHeight;
    const scale = Math.max(1, Math.min(1.6, vw * 0.84 / Math.max(1, r.width)));
    const dx = vw / 2 - (r.left + r.width / 2), dy = vh * 0.5 - (r.top + r.height / 2);
    requestAnimationFrame(() => requestAnimationFrame(() => { wrap.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')'; }));
    setTimeout(() => { wrap.style.opacity = '0'; branchIcon.classList.remove('on'); }, 1400);
    setTimeout(() => { selAnim = false; done(); if (!busy) stage.classList.remove('busy'); }, 2000);
  }
  function choose(s) {
    if (busy || anyOpen()) return;
    const p = parseSel(s);
    if (!p) return;
    switch (p.type) {
      case 'flt': case 'alt': case undefined:
        if (p.target) goto(p.target, { fade: p.args[0] ? +p.args[0] : 0.8 });
        break;
      case 'trs':
        if (p.target) goto(p.target, { wipe: p.args[0], fade: p.args[1] ? +p.args[1] : 0.6 });
        break;
      case 'nameInput': openKiller(); break;
      case 'returnStart': restartStory(); break;
      case 'returnTitle': toTitle(true); break;
      default: log('unknown select', s);
    }
  }
  function back() {
    if (!S.back) return;
    if (busy || selAnim || anyOpen() || !history.length) return;
    const h = history.pop();
    setLocalFlags(h.locals);
    goto(h.id, { noHistory: true, back: true, ctx: h.ctx, slide: true });
  }

  // ---------- Saving ----------
  function snapshot() {
    if (!cur) return null;
    return { id: cur.id, ctx: cur.ctx, locals: cur.localsAtEntry, names, bg: bgName, time: Date.now(), title: chapterTitleFor(cur.id, cur.ctx), hist: history.slice(-400), trail: trail.slice(-600) };
  }
  function autosave() { const s = snapshot(); if (s) LS.set('auto', s); }
  function loadState(s) {
    if (!s || !D.pages[s.id]) { toast('No saved data'); return; }
    names = s.names || names; LS.set('names', names);
    setLocalFlags(s.locals);
    history = Array.isArray(s.hist) ? s.hist.slice() : [];
    trail = Array.isArray(s.trail) && s.trail.length > history.length ? s.trail.slice() : history.map(h => ({ id: h.id, ctx: h.ctx, locals: h.locals }));
    enterGame();
    cur = null;
    goto(s.id, { noHistory: true, load: true, ctx: s.ctx, force: true });
  }

  // ---------- Screens ----------
  const screens = ['title', 'names', 'killer', 'toc', 'chapters', 'cfg', 'help'];
  function show(id) { $('#' + id).classList.add('on'); }
  function hide(id) { $('#' + id).classList.remove('on'); }
  function anyOpen() { return screens.some(s => s !== 'title' && $('#' + s).classList.contains('on')) || $('#title').classList.contains('on') || $('#oghelp').classList.contains('on'); }
  let toastT = 0;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200); }

  function enterGame() { inGame = true; hide('title'); cancelAnimationFrame(titleRaf); clearTimeout(titleTimer); Audio_.stopAll(0.5); }
  function toTitle(fromEnd) {
    screens.forEach(hide);
    if (cur) { try { cur.win.leave && cur.win.leave(); } catch (e) { } if (cur.frame) cur.frame.remove(); }
    cur = null; history = []; trail = []; inGame = false; busy = false; stage.classList.remove('busy');
    stopMovie(); setBright(0, 0); resetT(); branchIcon.classList.remove('on');
    Audio_.stopAll(fromEnd ? 2 : 0.6);
    // The startup logos play every time the title screen is reached.
    playLogos(() => { refreshTitle(); show('title'); titleIntro(0); });
  }

  // Title screen sequence, following the original KMTitleViewController:
  // background fades in (0.5 s), the logo is revealed by a soft left-to-right wipe (1.5 s),
  // then the buttons fade in (1 s). "scare.m4a" loops at 40% volume. After 60 s the screen
  // fades out (1 s) and the sequence plays again.
  let titleRaf = 0, titleTimer = 0;
  function titleIntro(musicDelay) {
    const tl = $('#title'), st = $('.tstage', tl), logo = $('.logo', tl), menu = $('.menu', tl), copy = $('.copy', tl);
    cancelAnimationFrame(titleRaf); clearTimeout(titleTimer);
    const setAlpha = (el, a, t) => { if (!el) return; el.style.transition = t ? 'opacity ' + t + 's linear' : 'none'; el.style.opacity = a; };
    const wipe = (p) => {
      // Soft edge 25% wide, sweeping from fully hidden (p = 0) to fully shown (p = 1).
      const a = p * 125 - 25, b = a + 25;
      const m = 'linear-gradient(to right, #000 ' + a + '%, transparent ' + b + '%)';
      logo.style.webkitMaskImage = logo.style.maskImage = m;
    };
    [st, menu, copy].forEach(el => setAlpha(el, 0, 0));
    wipe(0);
    if (!Audio_.bgm || Audio_.bgm.file !== 'scare.m4a' || Audio_.bgm.stopping) {
      setTimeout(() => { if (!inGame && $('#title').classList.contains('on')) Audio_.play('bgm', 'scare.m4a', 0.4, 1, -1); }, (musicDelay || 0) * 1000);
    }
    void st.offsetWidth;
    setAlpha(st, 1, 0.5); setAlpha(copy, 1, 0.5);
    titleTimer = setTimeout(() => {
      const t0 = performance.now();
      const step = (n) => {
        const p = Math.min(1, (n - t0) / 1500);
        wipe(p);
        if (p < 1) { titleRaf = requestAnimationFrame(step); return; }
        logo.style.webkitMaskImage = logo.style.maskImage = 'none';
        setAlpha(menu, 1, 1);
        titleTimer = setTimeout(titleLoop, 60000);
      };
      titleRaf = requestAnimationFrame(step);
    }, 500);
  }
  function titleLoop() {
    const tl = $('#title');
    if (inGame || !tl.classList.contains('on') || anyOpenOverTitle()) { titleTimer = setTimeout(titleLoop, 60000); return; }
    const st = $('.tstage', tl);
    st.style.transition = 'opacity 1s linear'; st.style.opacity = 0;
    titleTimer = setTimeout(() => titleIntro(0), 1000);
  }
  function anyOpenOverTitle() { return screens.some(s => s !== 'title' && $('#' + s).classList.contains('on')) || $('#oghelp').classList.contains('on'); }
  // Original "How to Play" pages from the iOS app, used on touch devices.
  function ogHelpHtml(id) {
    const html = D.pages[id] || '';
    const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
    const d = document.createElement('div');
    d.innerHTML = body;
    // Drop the purchase paragraph: everything is unlocked here.
    $$('p', d).forEach(p => { if (/PREMIUM/.test(p.textContent)) p.remove(); });
    $$('img', d).forEach(im => { im.src = 'engine/img/' + im.getAttribute('src').split('/').pop(); });
    return d.innerHTML;
  }
  function showOgHelp(id, onClose) {
    const el = $('#oghelp');
    $('.ogbody', el).innerHTML = ogHelpHtml(id);
    el.scrollTop = 0;
    el.onclick = () => { el.classList.remove('on'); if (onClose) onClose(); };
    el.classList.add('on');
  }
  // Touch screens get the original How to Play page with its pictures; computers get a mouse and
  // keyboard version that can still open the original one.
  // How to Play shows the original page (in the Settings right pane on wide screens, as on iPad;
  // full screen otherwise). Without a touch screen the keyboard controls appear on top of it.
  function openHelp() {
    if (D.pages.howtoplay) {
      if (WIDE) { if ($('#cfg').classList.contains('on') && Cfg.wide) Cfg.select(pageHowToPlay); else Cfg.open(pageHowToPlay); }
      else showOgHelp('howtoplay');
    }
    if (!TOUCH) show('help');
  }
  function hasAnySave() { return ['auto', 'slot1', 'slot2', 'slot3'].some(k => LS.get(k, null)); }
  function refreshTitle() {
    const tl = $('#title');
    const setOn = (act, on) => { const b = $('[data-act=' + act + ']', tl); b.disabled = !on; b.hidden = !on; };
    setOn('continue', !!LS.get('auto', null));
  }
  // Name screen, following the original NameInputVC: it shows the saved names, plays "fall.mp4"
  // at 40% volume, and lets the names be edited in place with "Change names".
  const DEF_MAIN = D.strings.NameInput_MainName || 'Max', DEF_SUB = D.strings.NameInput_SubName || 'Grace';
  function newGame() {
    const el = $('#names');
    $('#nmMain').value = names.main; $('#nmSub').value = names.sub;
    $$('input', el).forEach(i => { i.readOnly = true; });
    el.classList.remove('editing', 'helpon', 'leaving');
    cancelAnimationFrame(titleRaf); clearTimeout(titleTimer);
    show('names');
    Audio_.play('bgm', 'fall.mp4', 0.4, 1, -1);
  }
  function nameEditEnd() {
    // charNameCheck: an empty name falls back to the default one.
    if (!$('#nmMain').value.trim()) $('#nmMain').value = DEF_MAIN;
    if (!$('#nmSub').value.trim()) $('#nmSub').value = DEF_SUB;
    $$('#names input').forEach(i => { i.readOnly = true; i.blur(); });
    $('#names').classList.remove('editing');
    names = { main: $('#nmMain').value.trim(), sub: $('#nmSub').value.trim() };
    LS.set('names', names);
  }
  function changeNames() {
    const el = $('#names'), a = $('#nmMain'), b = $('#nmSub');
    el.classList.add('editing');
    a.value = '';
    a.readOnly = false; b.readOnly = false;
    a.focus();
  }
  function namesBack() {
    $('#names').classList.remove('editing');
    hide('names');
    Audio_.stop('bgm', 1);
    playLogos(() => { refreshTitle(); show('title'); titleIntro(0); });
  }
  // Original returnStart_: fade out for 0.5 s and start again from the first page with the same names.
  function restartStory() {
    setLocalFlags({});
    history = []; trail = [];
    Audio_.stopAll(0.5);
    goto(D.start, { noHistory: true, force: true, fade: 0.5 });
  }
  // "Use these names": the original fades in the How to Play introduction over the name screen;
  // a tap fades everything out (1 s) and the story begins.
  function startNew() {
    nameEditEnd();
    const el = $('#names'), help = $('.nhelp', el);
    if (!D.pages.howtoplay_intro || window.BLC_FAST || !el.classList.contains('on')) return beginStory();
    $('.ogbody', help).innerHTML = ogHelpHtml('howtoplay_intro');
    help.scrollTop = 0;
    el.classList.add('helpon');
    help.onclick = () => {
      help.onclick = null;
      el.classList.add('leaving');
      Audio_.stop('bgm', 1);
      setTimeout(() => { el.classList.remove('leaving', 'helpon'); beginStory(); }, 1000);
    };
  }
  function beginStory() {
    hide('names');
    setLocalFlags({});
    history = []; trail = []; cur = null;
    enterGame();
    goto(D.start, { noHistory: true, force: true, fade: 1 });
  }
  // killer's name input
  // Killer's name entry (original KMPageNameInputView): a blue box near the top of the page with a
  // text field; OK stays disabled while the field is empty, and the box fades out over 0.5 s.
  function openKiller() {
    const el = $('#killer'), inp = $('#killerName');
    inp.value = ''; $('[data-act=ok]', el).disabled = true;
    el.classList.remove('closing');
    show('killer');
    setTimeout(() => inp.focus(), 50);
  }
  function closeKiller(then) {
    const el = $('#killer');
    if (!el.classList.contains('on') || el.classList.contains('closing')) return;
    $('#killerName').blur();
    el.classList.add('closing');
    setTimeout(() => { el.classList.remove('closing'); hide('killer'); if (then) then(); }, 500);
  }
  function killerOk() {
    const name = $('#killerName').value.trim();
    if (!name) return;
    closeKiller(() => {
      if (!cur || !cur.win || typeof cur.win.onNameInput !== 'function') return;
      let r = null;
      try { r = cur.win.onNameInput(name); } catch (e) { log('onNameInput error', e); }
      if (r) choose(r);
    });
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // table of contents
  function openChapters() {
    const titled = Object.keys(CH).filter(k => CH[k].t);
    const list = $('#chapList'); list.innerHTML = '';
    $('#chapCount').textContent = chapSeen.length + ' of ' + titled.length + ' chapters discovered. Jumping keeps your current choices.';
    chapSeen.forEach(k => {
      if (!CH[k] || !D.pages[k]) return;
      const b = document.createElement('button'); b.className = 'item'; b.textContent = CH[k].t;
      b.addEventListener('click', () => {
        screens.forEach(s => s !== 'title' && hide(s));
        if (!inGame) { names = LS.get('names', names); enterGame(); }
        history = []; cur = cur || null;
        goto(k, { force: true, noHistory: true, fade: 0.8 });
      });
      list.appendChild(b);
    });
    if (!chapSeen.length) list.innerHTML = '<p class="muted">Nothing yet. Chapters appear here as you read them.</p>';
    show('chapters');
  }
  // ---------- Settings (recreates the original app's grouped-table settings screens) ----------
  const STR = D.strings;
  const Cfg = {
    stack: [],
    root: null,
    host: null, wide: false, firstFn: null,
    open(first, alone) {
      const el = $('#cfg'), wrap = $('.cfgwrap', el); wrap.innerHTML = ''; this.stack = [];
      this.wide = WIDE; this.firstFn = first || null;
      wrap.classList.toggle('split', WIDE);
      show('cfg');
      if (WIDE) {
        // Original iPad ConfigVC: list on the left, the selected page on the right.
        wrap.innerHTML = '<div class="cfgleft"></div><div class="cfgright"></div>';
        const left = $('.cfgleft', wrap);
        const lp = pageRootWide();
        left.innerHTML = '<div class="cfgpage"><div class="cfgnav"><div class="cfgtitle">' + esc(lp.title) +
          '</div></div><div class="cfgbody"></div></div>';
        $('.cfgbody', left).appendChild(lp.body);
        fitNav($('.cfgnav', left));
        this.leftRefresh = lp.refresh;
        this.host = $('.cfgright', wrap);
        this.select(first || pageBrightness);
        return;
      }
      this.host = wrap;
      if (!alone) this.push(pageRoot, true);
      if (first) this.push(first, true);
    },
    select(fn) {
      this.host.innerHTML = ''; this.stack = []; this.current = fn;
      this.push(fn, true);
      if (this.leftRefresh) this.leftRefresh();
    },
    reopenIfLayoutChanged() {
      if (!$('#cfg').classList.contains('on') || this.wide === WIDE) return;
      this.open(this.wide ? this.current : (this.stack[1] ? this.firstFn : null));
    },
    close() { hide('cfg'); if (!inGame) refreshTitle(); },
    push(fn, instant) {
      const wrap = this.host || $('#cfg .cfgwrap');
      const prev = this.stack[this.stack.length - 1];
      const pg = fn();
      const el = document.createElement('div'); el.className = 'cfgpage';
      const backLabel = prev ? prev.title : (STR.Config_ButtonBack || 'Return');
      el.innerHTML = '<div class="cfgnav"><button class="cfgback">' + (prev ? '&#8592; ' : '') + esc(backLabel) +
        '</button><div class="cfgtitle">' + esc(pg.title) + '</div></div><div class="cfgbody"></div>';
      $('.cfgbody', el).appendChild(pg.body);
      $('.cfgback', el).onclick = () => prev ? this.pop() : this.close();
      // iPad: the first page on the right has Return at the top right, as in the original.
      if (this.wide && !prev) $('.cfgback', el).classList.add('right');
      wrap.appendChild(el);
      fitNav($('.cfgnav', el));
      const rec = { title: pg.title, el, refresh: pg.refresh };
      this.stack.push(rec);
      if (!instant && prev) {
        el.classList.add('in'); void el.offsetWidth; el.classList.remove('in');
        prev.el.classList.add('under');
      } else if (prev) prev.el.classList.add('under', 'now');
    },
    pop() {
      const top = this.stack.pop(), prev = this.stack[this.stack.length - 1];
      if (!top) return;
      top.el.classList.add('in');
      if (prev) { prev.el.classList.remove('under', 'now'); if (prev.refresh) prev.refresh(); }
      if (this.leftRefresh) this.leftRefresh();
      setTimeout(() => top.el.remove(), 320);
    }
  };
  // Navigation bar text never gets cut off with "...": the title keeps clear of the buttons and both
  // shrink until they fit.
  function fitNav(nav) {
    if (!nav) return;
    const title = $('.cfgtitle', nav), btn = $('.cfgback', nav);
    const run = () => {
      if (!nav.isConnected || !nav.clientWidth) return;
      [title, btn].forEach(e => { if (e) e.style.fontSize = ''; });
      const w = nav.clientWidth;
      if (btn) {
        let fs = parseFloat(getComputedStyle(btn).fontSize);
        while (btn.scrollWidth > w * 0.3 && fs > 9) { fs -= 0.5; btn.style.fontSize = fs + 'px'; }
      }
      if (title) {
        const side = btn ? btn.offsetWidth + 16 : 0;
        title.style.paddingLeft = title.style.paddingRight = side + 'px';
        let fs = parseFloat(getComputedStyle(title).fontSize);
        while (title.scrollWidth > title.clientWidth && fs > 9) { fs -= 0.5; title.style.fontSize = fs + 'px'; }
      }
    };
    requestAnimationFrame(run);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
  }
  window.addEventListener('resize', () => document.querySelectorAll('#cfg .cfgnav').forEach(fitNav));
  // Small builders for grouped table sections and rows.
  function section(header, rows, footer) {
    const sec = document.createElement('div'); sec.className = 'cfgsec';
    if (header) { const h = document.createElement('div'); h.className = 'cfghead'; h.textContent = header; sec.appendChild(h); }
    const g = document.createElement('div'); g.className = 'cfggroup';
    rows.filter(Boolean).forEach(r => g.appendChild(r));
    sec.appendChild(g);
    if (footer) { const f = document.createElement('div'); f.className = 'cfgfoot'; f.textContent = footer; sec.appendChild(f); }
    sec.foot = sec.lastChild;
    return sec;
  }
  function row(label, opt) {
    opt = opt || {};
    const r = document.createElement(opt.onClick ? 'button' : 'div');
    r.className = 'cfgrow' + (opt.onClick ? ' tap' : '') + (opt.danger ? ' danger' : '');
    const l = document.createElement('span'); l.className = 'cfglabel'; l.textContent = label; r.appendChild(l);
    if (opt.detail != null) { const d = document.createElement('span'); d.className = 'cfgdetail'; d.textContent = opt.detail; r.appendChild(d); }
    if (opt.check) { const c = document.createElement('span'); c.className = 'cfgcheck'; c.textContent = '✓'; r.appendChild(c); }
    if (opt.chevron) { const c = document.createElement('span'); c.className = 'cfgchev'; c.textContent = '›'; r.appendChild(c); }
    if (opt.onClick) r.onclick = opt.onClick;
    return r;
  }
  function switchRow(label, key) {
    const r = row(label);
    const t = document.createElement('button'); t.className = 'cfgtoggle';
    const paint = () => { t.textContent = S[key] ? 'On' : 'Off'; t.classList.toggle('on', !!S[key]); };
    t.onclick = () => { S[key] = !S[key]; saveSettings(); applySettings(); paint(); };
    paint(); r.appendChild(t);
    return r;
  }
  function sliderRow(key, min, max, step, label, onChange) {
    const r = document.createElement('div'); r.className = 'cfgrow slider';
    r.innerHTML = (label ? '<span class="cfglabel">' + esc(label) + '</span>' : '') + '<input type="range"><span class="cfgval"></span>';
    const inp = $('input', r);
    inp.min = min; inp.max = max; inp.step = step; inp.value = S[key];
    const paint = () => { inp.style.setProperty('--p', ((inp.value - min) / (max - min) * 100) + '%'); $('.cfgval', r).textContent = inp.value; };
    paint();
    inp.oninput = () => { S[key] = +inp.value; paint(); saveSettings(); applySettings(); if (onChange) onChange(); };
    return r;
  }
  function choicePage(title, key, options, after, preview, previewIsSection) {
    return () => {
      const body = document.createElement('div');
      const render = () => {
        body.innerHTML = '';
        body.appendChild(section(null, options.map(([v, label]) =>
          row(label, { check: S[key] === v, onClick: () => { S[key] = v; saveSettings(); applySettings(); if (after) after(); render(); if (Cfg.leftRefresh) Cfg.leftRefresh(); } }))));
        if (preview && previewIsSection) body.appendChild(preview());
        else if (preview) { const ps = section(STR.Config_Preview || 'Preview', []); $('.cfggroup', ps).appendChild(preview()); body.appendChild(ps); }
      };
      render();
      return { title, body };
    };
  }
  // Previews the original shows on iPad under Gore Level and Page Direction (iPhone has none).
  const IPAD_PREVIEWS = false;
  // A preview of story text over a background, following the current text settings.
  function textPreview(bgImg, pageKey, extra) {
    const pv = document.createElement('div'); pv.className = 'cfgpreview' + (extra ? ' ' + extra : '');
    pv.innerHTML = '<div class="pvbg"></div><div class="pvdim"></div><div class="pvtext"></div>';
    const p = imgPath(bgImg); if (p) $('.pvbg', pv).style.backgroundImage = 'url("' + url(p) + '")';
    const sec = ((D.pages[pageKey] || '').match(/<section[\s\S]*?<\/section>/i) || [''])[0];
    $('.pvtext', pv).innerHTML = sec.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\bGrace\b/g, esc(names.sub)).replace(/\bMax\b/g, esc(names.main));
    pv.upd = () => {
      const t = $('.pvtext', pv);
      t.style.fontFamily = fontFamily();
      t.style.fontSize = Math.round(fontPx() * (pv.clientWidth || 300) / (stage.clientWidth || 600)) + 'px';
      t.style.color = 'rgba(255,255,255,' + (Math.max(30, S.textb) / 100) + ')';
      $('.pvdim', pv).style.opacity = Math.min(85, 100 - S.bgb) / 100;
    };
    setTimeout(pv.upd, 0);
    return pv;
  }
  // Explains when the device is showing a fallback instead of the font named by the setting.
  function fontNote(note) {
    const show = () => {
      const kind = S.font === 'g' ? 'g' : 'm', want = kind === 'g' ? 'Euphemia UCAS' : 'Marion';
      const got = fontInUse(kind);
      note.textContent = got === want ? '' : 'Due to port limitations, ' + fontLabels[kind] + ' is not available on this device, so the text is shown in ' + got + '.';
      note.style.display = note.textContent ? '' : 'none';
    };
    (document.fonts && document.fonts.load ? document.fonts.load("16px 'Libre Baskerville Port'") : Promise.resolve()).then(show, show);
  }
  function previewSection(pv, withNote) {
    const ps = section(STR.Config_Preview || 'Preview', [], withNote ? ' ' : null);
    $('.cfggroup', ps).appendChild(pv);
    if (withNote) fontNote($('.cfgfoot', ps));
    return ps;
  }
  // iPad pages
  function pageBrightness() {
    const body = document.createElement('div'); let pv;
    const upd = () => pv && pv.upd();
    body.appendChild(section(null, [
      sliderRow('bgb', 15, 100, 5, STR.ConfigBrightness_Background || 'Background Brightness', upd),
      sliderRow('textb', 30, 100, 5, STR.ConfigBrightness_Character || 'Text Brightness', upd)]));
    pv = textPreview('gerende2.jpg', 'preview00', 'tall');
    body.appendChild(previewSection(pv));
    return { title: STR.Config_Brightness || 'Brightness', body };
  }
  function pageTextSize() {
    const body = document.createElement('div'); let pv;
    body.appendChild(section(null, [sliderRow('size', 1, 10, 1, STR.Config_FontSize || 'Text Size', () => pv && pv.upd())]));
    pv = textPreview('gerende2.jpg', 'preview00', 'tall');
    body.appendChild(previewSection(pv, true));
    return { title: STR.Config_FontSize || 'Text Size', body };
  }
  function pageFontWide() {
    return choicePage(STR.Config_Font || 'Font', 'font', [['m', fontLabels.m], ['g', fontLabels.g]], null,
      () => previewSection(textPreview('gerende2.jpg', 'preview00', 'tall'), true), true)();
  }
  function pageDirWide() {
    return choicePage(STR.Config_PageDirection || 'Page Direction', 'dir', [['L', dirLabels.L], ['R', dirLabels.R]], null,
      () => previewSection(previewDirPages()), true)();
  }
  function pageGoreWide() {
    return choicePage(STR.Config_Violence || 'Gore Level', 'gore', goreLabels.map((l, i) => [i, l]), null,
      () => previewSection(previewGore()), true)();
  }
  // Page Direction preview: two sample pages turning back and forth in the chosen direction.
  function previewDirPages() {
    const box = document.createElement('div'); box.className = 'cfgpreview tall dirpv';
    const a = textPreview('gerende2.jpg', 'preview00'), b = textPreview('ss_sky.jpg', 'preview01');
    [a, b].forEach(x => { x.classList.add('pg'); box.appendChild(x); });
    let showB = false;
    const place = (anim) => {
      const sgn = S.dir === 'L' ? -1 : 1;   // "Right": the next page comes in from the right
      [a, b].forEach(x => x.style.transition = anim ? 'transform .5s ease-in-out' : 'none');
      a.style.transform = showB ? 'translateX(' + (-sgn * 100) + '%)' : 'none';
      b.style.transform = showB ? 'none' : 'translateX(' + (sgn * 100) + '%)';
    };
    place(false);
    const t = setInterval(() => { if (!box.isConnected) { clearInterval(t); return; } showB = !showB; place(true); }, 2500);
    setTimeout(() => { a.upd(); b.upd(); }, 0);
    return box;
  }
  function previewGore() {
    const el = document.createElement('div'); el.className = 'cfgpvimg tall';
    const img = ['s_bahtroom_b.jpg', 's_bahtroom_b_ratb.jpg', 's_bahtroom_b_ratc.jpg'][+S.gore] || 's_bahtroom_b.jpg';
    const p = imgPath(img); if (p) el.style.backgroundImage = 'url("' + url(p) + '")';
    return el;
  }
  function previewDir() {
    const el = document.createElement('div'); el.className = 'cfgpvimg slide ' + (S.dir === 'L' ? 'toright' : 'toleft');
    const p = imgPath('ss_sky.jpg');
    el.innerHTML = '<div class="a"></div><div class="b"></div>';
    if (p) $$('div', el).forEach(d => { d.style.backgroundImage = 'url("' + url(p) + '")'; });
    return el;
  }
  const goreLabels = [STR.ConfigViolence_Normal || 'High', STR.ConfigViolence_Blur || 'Medium', STR.ConfigViolence_Nothing || 'Low'];
  const fontLabels = { m: STR.ConfigFont_Mincho || 'Marion-Regular', g: STR.ConfigFont_Gothic || 'Euphemia UCAS' };
  const dirLabels = { R: STR.ConfigPageDirection_Right || 'Right', L: STR.ConfigPageDirection_Left || 'Left' };
  const fxLabels = { vibrate: 'Vibrate', shake: 'Screen shake', off: 'Off' };

  function pageRoot() {
    const body = document.createElement('div');
    const render = () => {
      body.innerHTML = '';
      // Same rows and order as the original ConfigPhoneVC.
      body.appendChild(section(null, [
        row(STR.Config_DisplaySetup || 'Text/Brightness Setting', { chevron: true, onClick: () => Cfg.push(pageDisplay) }),
        row(STR.Config_PageDirection || 'Page Direction', { detail: dirLabels[S.dir], chevron: true, onClick: () => Cfg.push(choicePage(STR.Config_PageDirection || 'Page Direction', 'dir', [['L', dirLabels.L], ['R', dirLabels.R]], null, IPAD_PREVIEWS && previewDir)) }),
        row(STR.Config_Sound || 'Volume', { chevron: true, onClick: () => Cfg.push(pageVolume) }),
        row(STR.Config_Violence || 'Gore Level', { detail: goreLabels[S.gore], chevron: true, onClick: () => Cfg.push(choicePage(STR.Config_Violence || 'Gore Level', 'gore', goreLabels.map((l, i) => [i, l]), null, IPAD_PREVIEWS && previewGore)) }),
        S.saves ? row(STR.Config_Save || 'Save Data', { chevron: true, onClick: () => Cfg.push(() => pageSave()) }) : null
      ]));
      body.appendChild(section(null, [
        row(STR.Config_HowToPlay || 'How to Play', { chevron: true, onClick: () => openHelp() }),
        row(STR.Config_ProductInfo || 'Product Infomation', { chevron: true, onClick: () => Cfg.push(pageProduct) })
      ]));
      body.appendChild(section('Port-specific settings', [
        row('Vibration', { detail: fxLabels[S.fx], chevron: true, onClick: () => Cfg.push(choicePage('Vibration', 'fx', (CAN_VIBRATE ? ['vibrate', 'shake', 'off'] : ['shake', 'off']).map(v => [v, fxLabels[v]]))) }),
        row('Back up saves', { chevron: true, onClick: backupSaves }),
        row('Restore saves', { chevron: true, onClick: restoreSaves }),
        row('Erase progress', { danger: true, onClick: resetProgress })
      ]));
    };
    render();
    return { title: STR.Config_Title || 'Settings', body, refresh: render };
  }

  function pageRootWide() {
    const body = document.createElement('div');
    const item = (label, pageFn) => {
      const r = row(label, { onClick: () => Cfg.select(pageFn) });
      if (Cfg.current === pageFn) r.classList.add('sel');
      return r;
    };
    const go = (fn) => fn;
    const render = () => {
      body.innerHTML = '';
      body.appendChild(section(null, [
        item(STR.Config_Brightness || 'Brightness', go(pageBrightness)),
        item(STR.Config_FontSize || 'Text Size', go(pageTextSize)),
        item(STR.Config_Font || 'Font', go(pageFontWide)),
        item(STR.Config_PageDirection || 'Page Direction', go(pageDirWide)),
        item(STR.Config_Violence || 'Gore Level', go(pageGoreWide)),
        item(STR.Config_Sound || 'Volume', go(pageVolume)),
        item(STR.Config_Save || 'Save Data', go(pageSave))
      ]));
      body.appendChild(section(STR.Config_Other || 'Other', [
        (() => { const r = item(STR.Config_HowToPlay || 'How to Play', pageHowToPlay); if (!TOUCH) r.onclick = () => openHelp(); return r; })(),
        item(STR.Config_ProductInfo || 'Product Infomation', go(pageProduct))
      ]));
      body.appendChild(section('Port-specific settings', [
        item('Vibration', go(pageVibration)),
        row('Back up saves', { onClick: backupSaves }),
        row('Restore saves', { onClick: restoreSaves }),
        row('Erase progress', { danger: true, onClick: resetProgress })
      ]));
    };
    render();
    return { title: STR.Config_Title || 'Settings', body, refresh: render };
  }
  function pageHowToPlay() {
    const body = document.createElement('div'); body.className = 'cfgweb cfghelp';
    body.innerHTML = ogHelpHtml('howtoplay');
    return { title: STR.Config_HowToPlay || 'How to Play', body };
  }
  function pageVibration() { return choicePage('Vibration', 'fx', (CAN_VIBRATE ? ['vibrate', 'shake', 'off'] : ['shake', 'off']).map(v => [v, fxLabels[v]]))(); }

  function pageDisplay() {
    const body = document.createElement('div');
    const pv = document.createElement('div'); pv.className = 'cfgpreview';
    pv.innerHTML = '<div class="pvbg"></div><div class="pvdim"></div><div class="pvtext"></div>';
    const bgp = imgPath('gerende2.jpg');   // the original's preview image (top of the slope picture)
    if (bgp) $('.pvbg', pv).style.backgroundImage = 'url("' + url(bgp) + '")';
    // Preview text comes from the original preview page (first section only).
    const sec = ((D.pages.preview00 || '').match(/<section[\s\S]*?<\/section>/i) || [''])[0];
    $('.pvtext', pv).innerHTML = sec.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\bGrace\b/g, esc(names.sub));
    const upd = () => {
      const t = $('.pvtext', pv);
      t.style.fontFamily = fontFamily();
      t.style.fontSize = Math.round(fontPx() * (pv.clientWidth || 300) / (stage.clientWidth || 600)) + 'px';
      t.style.color = 'rgba(255,255,255,' + (Math.max(30, S.textb) / 100) + ')';
      $('.pvdim', pv).style.opacity = Math.min(85, 100 - S.bgb) / 100;
    };
    const fontRow = () => row(STR.Config_Font || 'Font', { detail: fontLabels[S.font], chevron: true, onClick: () => Cfg.push(choicePage(STR.Config_Font || 'Font', 'font', [['m', fontLabels.m], ['g', fontLabels.g]])) });
    const render = () => {
      body.innerHTML = '';
      body.appendChild(section(STR.Config_Brightness || 'Brightness', [
        sliderRow('bgb', 15, 100, 5, STR.Config_Background || 'Background', upd),
        sliderRow('textb', 30, 100, 5, STR.Config_Character || 'Text', upd)
      ]));
      body.appendChild(section(STR.Config_Character || 'Text', [sliderRow('size', 1, 10, 1, STR.Config_Size || 'Size', upd), fontRow()]));
      const ps = section(null, [], ' ');
      $('.cfggroup', ps).appendChild(pv);
      body.appendChild(ps);
      const note = $('.cfgfoot', ps);
      const showNote = () => {
        // Only shown when the device is using a fallback instead of the font named by the setting.
        const kind = S.font === 'g' ? 'g' : 'm', want = kind === 'g' ? 'Euphemia UCAS' : 'Marion';
        const got = fontInUse(kind);
        note.textContent = got === want ? '' : 'Due to port limitations, ' + fontLabels[kind] + ' is not available on this device, so the text is shown in ' + got + '.';
        note.style.display = note.textContent ? '' : 'none';
      };
      (document.fonts && document.fonts.load ? document.fonts.load("16px 'Libre Baskerville Port'") : Promise.resolve()).then(showNote, showNote);
      setTimeout(upd, 0);
    };
    render();
    return { title: STR.Config_DisplaySetup || 'Text/Brightness Setting', body, refresh: render };
  }

  function pageVolume() {
    const body = document.createElement('div');
    body.appendChild(section(null, [sliderRow('master', 0, 100, 5, null)]));
    body.appendChild(section('Granular control', [
      sliderRow('bgm', 0, 100, 5, 'Music'), sliderRow('env', 0, 100, 5, 'Ambience'), sliderRow('se', 0, 100, 5, 'Sound Effects')]));
    return { title: STR.Config_Sound || 'Volume', body };
  }

  function pageProduct() {
    const body = document.createElement('div'); body.className = 'cfgweb';
    const d = document.createElement('div');
    d.innerHTML = ((D.pages.product || '').match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, ''])[1].replace(/<script[\s\S]*?<\/script>/gi, '');
    $$('img', d).forEach(i => i.remove());
    body.appendChild(d);
    return { title: STR.Config_ProductInfo || 'Product Infomation', body };
  }

  // Save Data: the original lists the auto-save entry and bookmark cells ("The Story of X and Y").
  const SLOTS = ['slot1', 'slot2', 'slot3'];   // the full version of the original has three save slots
  function thumbFor(s) {
    const bg = s.bg || D.pageload[s.id];
    if (!bg) return null;
    const th = bg.replace(/\.jpg$/i, '') + '_th.jpg';
    if (LPROJ.has(th)) return APP + 'en.lproj/' + th;
    return imgPath(bg);
  }
  function saveCell(key, s, onClick) {
    const r = document.createElement('button'); r.className = 'cfgrow tap savecell';
    const th = s && thumbFor(s);
    const fmt = STR.ConfigSave_DataCharFormat || 'The Story of %@ and %@';
    const none = STR.ConfigSave_NoDataPlayerName || '**';
    const story = s ? fmt.replace('%@', s.names.main).replace('%@', s.names.sub) : fmt.replace('%@', none).replace('%@', none);
    const when = s ? new Date(s.time).toLocaleString() : (STR.ConfigSave_NoDataDate || '****-**-** **:**:**');
    r.innerHTML = '<span class="thumb"' + (th ? ' style="background-image:url(&quot;' + url(th) + '&quot;)"' : '') + '></span>' +
      '<span class="savetext"><span class="d">' + esc(story) + '</span><span class="t">' + esc(s && s.title ? s.title : '') + '</span>' +
      '<span class="c">' + esc(when) + '</span></span>';
    if (onClick) r.onclick = onClick; else r.classList.remove('tap');
    return r;
  }
  // Save Data (original ConfigSave): during the story it saves ("Saving story data. Is it okay to
  // overwrite?"); from the title screen ("From saved location") it loads.
  function pageSave(mode) {
    mode = mode || (inGame && cur ? 'save' : 'load');
    const body = document.createElement('div');
    const render = () => {
      body.innerHTML = '';
      if (mode === 'save') { const m = document.createElement('div'); m.className = 'cfghint'; m.textContent = STR.ConfigSave_HeadMessage || 'Saving story data. Is it okay to overwrite?'; body.appendChild(m); }
      // The autosave is only listed when loading; saving from the story only offers the slots.
      if (mode === 'load') {
        const auto = LS.get('auto', null);
        const as = section(WIDE ? (STR.ConfigSave_AutoSaveSectionHeader || 'Current saved data') : null,
          [saveCell('auto', auto, auto ? () => { Cfg.close(); loadState(auto); } : null)],
          STR.ConfigSave_AutoSaveSectionFooter || 'Auto Save');
        as.foot.classList.add('center');
        body.appendChild(as);
      }
      body.appendChild(section(null, SLOTS.map(k => {
        const s = LS.get(k, null);
        if (mode === 'load') return saveCell(k, s, s ? () => { Cfg.close(); loadState(s); } : null);
        return saveCell(k, s, () => {
          const doSave = () => { const sn = snapshot(); if (sn) { LS.set(k, sn); toast('Saved'); render(); } };
          if (s) sheet(null, [[STR.BookMarkCell_overwriteLabel || 'Overwrite this data', doSave]]);
          else doSave();
        });
      })));
    };
    render();
    return { title: STR.Config_Save || 'Save Data', body, refresh: render };
  }
  // iOS-style action sheet
  function sheet(msg, actions) {
    const el = document.createElement('div'); el.className = 'cfgsheet';
    el.innerHTML = '<div class="box">' + (msg ? '<div class="msg">' + esc(msg) + '</div>' : '') + '</div><button class="cancel">' + esc(STR.Store_ButtonNotBuy || 'Cancel') + '</button>';
    const box = $('.box', el);
    actions.forEach(([label, fn]) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { el.remove(); fn(); }; box.appendChild(b); });
    $('.cancel', el).onclick = () => el.remove();
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    $('#cfg .cfgwrap').appendChild(el);
  }
  function resetProgress() {
    sheet('Erase all progress (pages read, unlocked choices and saved data)? Settings are kept.', [['Erase progress', () => {
      ['global', 'auto'].concat(SLOTS).forEach(LS.del);
      flags = {}; visited.clear(); chapSeen.length = 0; toast('Progress erased'); Cfg.close(); toTitle();
    }]]);
  }
  // Backup and restore: everything the port keeps in the browser (saves, autosave, progress, names,
  // settings) goes into one .json file, so it survives clearing browser data or moving to another
  // browser or device.
  function lsDump() {
    const data = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('blc_')) data[k] = localStorage.getItem(k); } } catch (e) { }
    return data;
  }
  function backupSaves() {
    const data = lsDump();
    if (!Object.keys(data).length) { toast('Nothing to back up yet'); return; }
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const name = "Banshee's Last Cry saves " + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.json';
    const json = JSON.stringify({ app: 'banshees-last-cry-port', version: 1, time: d.toISOString(), data }, null, 1);
    if (NATIVE && NATIVE.saveText) { NATIVE.saveText(name, json); return; }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Backup saved');
  }
  function restoreSaves() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        let j = null;
        try { j = JSON.parse(rd.result); } catch (e) { }
        if (!j || j.app !== 'banshees-last-cry-port' || !j.data || typeof j.data !== 'object') { toast('That file is not a saves backup'); return; }
        const keys = Object.keys(j.data).filter(k => k.startsWith('blc_') && typeof j.data[k] === 'string');
        const when = j.time ? new Date(j.time).toLocaleString() : 'an unknown date';
        sheet('Restore the backup from ' + when + '? Your current saves, progress and settings will be replaced.', [['Restore', () => {
          try {
            Object.keys(lsDump()).forEach(k => localStorage.removeItem(k));
            keys.forEach(k => localStorage.setItem(k, j.data[k]));
          } catch (e) { toast('Could not restore the backup'); return; }
          // reload so every part of the port starts from the restored data
          location.reload();
        }]]);
      };
      rd.readAsText(f);
    };
    inp.click();
  }
  function openSettings() { Cfg.open(); }

  // ---------- Table of Contents (original KMPageJumpViewController) ----------
  // Lists the chapters reached in the current story, oldest on the left. The large card shows the
  // selected chapter; swipe, use the arrows or tap a thumbnail to move, tap the card to jump back to
  // the start of that chapter. The background is one of six images picked at random.
  const Toc = { list: [], sel: 0 };
  function tocChapters() {
    const all = trail.map((h, i) => ({ id: h.id, ctx: h.ctx, locals: h.locals, idx: i }));
    const list = [];
    let last = null;
    all.forEach(e => {
      const t = chapterTitleFor(e.id, e.ctx);
      if (!t) return;
      if (!last || last.title !== t) { last = { title: t, start: e, bg: '', end: e.idx }; list.push(last); }
      last.end = e.idx;
      if (!last.bg && D.pageload[e.id]) last.bg = D.pageload[e.id];
    });
    return list;
  }
  function thumbPath(bg, big) {
    if (!bg) return null;
    const th = bg.replace(/\.jpg$/i, '') + '_th.jpg';
    if (!big && LPROJ.has(th)) return APP + 'en.lproj/' + th;
    return imgPath(bg);
  }
  function openToc() {
    const el = $('#toc');
    const bgs = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => 'pagejump_bg_' + c + '@2x~ipad.jpg').filter(f => ROOT.has(f));
    // Original KMPageJumpViewController viewDidLoad: one of the six backgrounds at random (rand() / RAND_MAX * 6)
    // on every device, filling the screen height and centered. It goes behind the whole screen, so on
    // tablets it fills the sides around the 2:3 layout too.
    if (bgs.length) el.style.backgroundImage = 'url("' + url(APP + bgs[Math.floor(Math.random() * bgs.length)]) + '")';
    Toc.list = tocChapters();
    // start on the chapter being read now (it may not be the last one after jumping back)
    const pos = history.length;
    let curSel = Toc.list.findIndex(c => c.start.idx <= pos && pos <= c.end);
    if (curSel < 0) curSel = Toc.list.length - 1;
    Toc.sel = Math.max(0, curSel);
    const track = $('.track', el); track.innerHTML = '';
    Toc.list.forEach((c, i) => {
      const d = document.createElement('div'); d.className = 'th';
      const p = thumbPath(c.bg);
      if (p) d.style.backgroundImage = 'url("' + url(p) + '")';
      d.onclick = (ev) => { ev.stopPropagation(); tocSelect(i); };
      track.appendChild(d);
    });
    show('toc');
    tocSelect(Toc.sel, true);
  }
  // Share (original: the system share sheet with the chapter title and #HowlOfTheBanshee).
  // Uses the browser's or system's share sheet when there is one, otherwise a small dialog.
  function shareChapter() {
    const c = Toc.list[Toc.sel];
    const title = c ? c.title.replace(/%@/, names.main).replace(/%@/, names.sub) : '';
    const text = (title ? "Banshee's Last Cry: " + title + ' ' : "Banshee's Last Cry ") + '#BansheesLastCry';
    if (NATIVE && NATIVE.share) { NATIVE.share(text); return; }
    if (navigator.share) { navigator.share({ text }).catch(() => { }); return; }
    const el = document.createElement('div'); el.className = 'tshare';
    el.innerHTML = '<div class="box"><div class="h">' + esc(STR.PageJump_Share || 'Share') + '</div><textarea readonly></textarea>' +
      '<div class="b"><button data-s="copy">Copy</button><button data-s="x">Post on X</button><button data-s="close">' + esc(STR.Sns_Button_Cancel || 'Cancel') + '</button></div></div>';
    $('textarea', el).value = text;
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-s]');
      if (e.target === el || (b && b.dataset.s === 'close')) { el.remove(); return; }
      if (!b) return;
      if (b.dataset.s === 'copy') {
        const ta = $('textarea', el); ta.select();
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).catch(() => { try { document.execCommand('copy'); } catch (x) { } })
          .finally(() => { b.textContent = 'Copied'; });
      } else if (b.dataset.s === 'x') {
        window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text), '_blank', 'noopener');
      }
    });
    $('#toc .tbox').appendChild(el);
  }
  function closeToc() { hide('toc'); applySettings(); }
  function tocSelect(i, instant) {
    const el = $('#toc');
    if (!Toc.list.length) { $('.chap', el).textContent = ''; $('.tcard .pic', el).style.backgroundImage = 'none'; return; }
    Toc.sel = Math.max(0, Math.min(Toc.list.length - 1, i));
    const c = Toc.list[Toc.sel];
    $('.chap', el).textContent = c.title.replace(/%@/, names.main).replace(/%@/, names.sub);
    const p = thumbPath(c.bg, true);
    const pic = $('.tcard .pic', el);
    pic.style.backgroundImage = p ? 'url("' + url(p) + '")' : 'none';
    // keep the selected thumbnail in the middle of the strip
    const track = $('.track', el);
    track.style.transition = instant ? 'none' : 'transform .25s ease-out';
    track.style.transform = 'translateX(' + (-(Toc.sel + 0.5) * 18) + 'cqw)';
    $('.tarrow.l', el).style.visibility = Toc.sel > 0 ? '' : 'hidden';
    $('.tarrow.r', el).style.visibility = Toc.sel < Toc.list.length - 1 ? '' : 'hidden';
  }
  function tocJump() {
    const c = Toc.list[Toc.sel]; if (!c || !S.toc) return;
    const e = c.start;
    hide('toc');
    history = trail.slice(0, e.idx).map(h => ({ id: h.id, ctx: h.ctx, locals: h.locals, branch: false }));
    setLocalFlags(e.locals);
    goto(e.id, { noHistory: true, ctx: e.ctx, force: true, fade: 0.8 });
  }
  (function () {
    const el = $('#toc'), jump = $('.tjump', el);
    $('.tcard', el).addEventListener('click', () => { if (!dragMoved) tocJump(); });
    $('.tarrow.l', el).addEventListener('click', () => tocSelect(Toc.sel - 1));
    $('.tarrow.r', el).addEventListener('click', () => tocSelect(Toc.sel + 1));
    let sx = null, dragMoved = false;
    jump.addEventListener('pointerdown', e => { sx = e.clientX; dragMoved = false; });
    jump.addEventListener('pointerup', e => {
      if (sx == null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 30) { dragMoved = true; tocSelect(Toc.sel + (dx < 0 ? 1 : -1)); setTimeout(() => { dragMoved = false; }, 50); }
    });
  })();
  function openSaves() { Cfg.open(WIDE ? pageSave : () => pageSave('load'), true); }

  function applySettings() {
    applyDim(); Audio_.refresh();
    $('#hudBack').style.display = S.back ? '' : 'none';
    // Optional extras (off by default to stay close to the original app)
    $('#toc [data-act=save]').hidden = !S.saves;
    $('#toc .tjump').style.visibility = S.toc ? '' : 'hidden';
    if ($('#title').classList.contains('on')) refreshTitle();
    if (cur && cur.doc) { const st = cur.doc.getElementById('__css'); if (st) st.textContent = frameCss(); applyBranchPad(cur); }
  }

  // ---------- Input ----------
  // Background audio: the Android app calls these from onPause/onResume; mobile browsers use page visibility.
  window.SLCPause = () => Audio_.suspend();
  window.SLCResume = () => Audio_.resume();
  document.addEventListener('visibilitychange', () => { if (TOUCH || NATIVE) document.hidden ? Audio_.suspend() : Audio_.resume(); });
  // Android back button: behaves like Esc; returns false when there is nothing to close (the app then exits).
  window.SLCBack = function () {
    const atTitle = $('#title').classList.contains('on') && !anyOpenOverTitle() && !$('#names').classList.contains('on');
    if (atTitle || $('#logos')) return false;
    onKey({ key: 'Escape', target: document.body, preventDefault() { } });
    return true;
  };
  function onKey(e) {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
      if (e.key === 'Enter') { if ($('#names').classList.contains('on')) { if (!$('#names').classList.contains('editing')) startNew(); } else if ($('#killer').classList.contains('on')) killerOk(); }
      if (e.key === 'Escape' && $('#killer').classList.contains('on')) { closeKiller(); }
      return;
    }
    const k = e.key;
    if (k === 'f' || k === 'F') { toggleFull(); e.preventDefault(); return; }
    if (k === 'd' || k === 'D') { dbgOn = !dbgOn; dbg.style.display = dbgOn ? 'block' : 'none'; updDbg(); return; }
    if (k === 'Escape') {
      e.preventDefault();
      if ($('#names').classList.contains('on') && !$('#names').classList.contains('helpon')) { namesBack(); return; }
      // Inside settings, Esc behaves like the navigation bar's back button.
      const sh = $('#cfg .cfgsheet');
      if (sh) { sh.remove(); return; }
      if ($('#cfg').classList.contains('on') && !$('#help').classList.contains('on') && !$('#oghelp').classList.contains('on')) {
        if (Cfg.stack.length > 1) Cfg.pop(); else Cfg.close();
        return;
      }
      if ($('#cfg').classList.contains('on')) { hide('help'); $('#oghelp').classList.remove('on'); return; }
      const open = screens.filter(s => s !== 'title' && $('#' + s).classList.contains('on'));
      if (open.length) { open.forEach(hide); if (!inGame) show('title'); return; }
      if (inGame) openToc();
      return;
    }
    if ($('#toc').classList.contains('on') && !$('#cfg').classList.contains('on')) {
      if (k === 'ArrowLeft') tocSelect(Toc.sel - 1);
      else if (k === 'ArrowRight') tocSelect(Toc.sel + 1);
      else if (k === 'Enter') tocJump();
      return;
    }
    if (!inGame || anyOpen() || !cur || !cur.win) return;
    if ((k === 's' || k === 'S') && cur.secret && $('#secretbtn').classList.contains('on')) { choose(cur.secret); return; }
    if ([' ', 'Enter', 'ArrowDown', 'PageDown', 'ArrowRight'].includes(k)) { e.preventDefault(); advance(); }
    else if (k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); cur.win.scrollBy({ top: -cur.win.innerHeight * 0.75, behavior: 'smooth' }); }
    else if (k === 'ArrowLeft' || k === 'Backspace') { e.preventDefault(); back(); }
    else if (/^[1-9]$/.test(k) && !cur.linear) {
      const li = cur.choices[+k - 1]; if (li && li.isConnected) li.click();
    }
  }
  document.addEventListener('keydown', onKey);
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    else document.documentElement.requestFullscreen().catch(() => { });
  }
  window.addEventListener('resize', () => applySettings());

  // buttons
  $('#hudMenu').onclick = () => inGame && openToc();
  $('#hudBack').onclick = () => back();
  $('#hudFull').onclick = () => toggleFull();
  $('#secretbtn').onclick = () => { if (cur && cur.secret) choose(cur.secret); };
  $('#title').addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a || a.disabled) return;
    ({
      new: newGame,
      continue: openSaves,
      load: openSaves,
      chapters: openChapters,
      settings: openSettings,
      help: openHelp
    })[a.dataset.act]();
  });
  $('#names').addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'ok') startNew();
    else if (a.dataset.act === 'change') changeNames();
    else namesBack();
  });
  $('#nmMain').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.readOnly) { e.preventDefault(); e.stopPropagation(); $('#nmSub').value = ''; $('#nmSub').focus(); } });
  $('#nmSub').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.readOnly) { e.preventDefault(); e.stopPropagation(); nameEditEnd(); } });
  $('#killer').addEventListener('click', e => { const a = e.target.closest('[data-act]'); if (!a) return; if (a.dataset.act === 'ok') killerOk(); else closeKiller(); });
  $('#killerName').addEventListener('input', () => { $('#killer [data-act=ok]').disabled = !$('#killerName').value.trim(); });
  $('#toc').addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'return') closeToc();
    else if (act === 'save') Cfg.open(WIDE ? pageSave : () => pageSave('save'), true);
    else if (act === 'settings') openSettings();
    else if (act === 'share') shareChapter();
    else if (act === 'title') { hide('toc'); toTitle(); }
  });
  ['chapters', 'help'].forEach(id => $('#' + id).addEventListener('click', e => { const a = e.target.closest('[data-act=close]'); if (a) hide(id); }));
  textlayer.addEventListener('wheel', () => { }, { passive: true });

  // ---------- Diagnostics overlay (D key) ----------
  let dbgOn = false;
  const dbg = document.createElement('div');
  dbg.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:70;background:rgba(0,0,0,.8);color:#9f9;font:12px/1.4 Consolas,monospace;padding:6px 9px;border-radius:6px;display:none;pointer-events:none;white-space:pre';
  document.body.appendChild(dbg);
  function updDbg() {
    if (!dbgOn) return;
    const nm = (t) => t ? t.file + (t.stopping ? ' (fading)' : '') : '-';
    dbg.textContent = 'page: ' + (cur ? cur.id : '-') + '\nbg:   ' + (bgCur ? decodeURIComponent(bgCur.split('/').pop()) : '-') +
      '\nbgm:  ' + nm(Audio_.bgm) + '\nenv:  ' + nm(Audio_.env) + '\nse:   ' + Audio_.se.size + '  fading: ' + Audio_.fading.size;
  }
  setInterval(updDbg, 300);

  // ---------- Boot ----------
  const tl = $('#title');
  // The original title screen always uses s_house.jpg (titlebg@2x~ipad.jpg is not used by it).
  const tbg = imgPath('s_house.jpg');
  // The name screen uses namescreen.jpg as its background, as in the original nib.
  const nbg = imgPath('namescreen.jpg');
  if (nbg) $('#names .nstage').style.backgroundImage = 'url("' + url(nbg) + '")';
  $('.tstage', tl).style.backgroundImage = tbg ? 'url("' + url(tbg) + '")' : 'none';
  tl.style.backgroundImage = tbg ? 'url("' + url(tbg) + '")' : 'none';
  tl.style.backgroundColor = '#000';
  $('.logo', tl).src = 'engine/img/titlelogo.png';
  $('.copy', tl).src = 'engine/img/title_copyright.png';
  $('.logo', tl).onerror = function () { this.remove(); }; $('.copy', tl).onerror = function () { this.remove(); };
  tl.style.backgroundSize = 'cover'; tl.style.filter = '';
  if (TOUCH) $('#hudFull').hidden = true;
  window.addEventListener('resize', () => {
    if (updateWide()) { applySettings(); Cfg.reopenIfLayoutChanged(); }
  });
  applySettings();
  refreshTitle();
  // Startup logos, as in the original KMLogoViewController: each one fades in for 1 s, stays 1 s
  // and fades out for 1 s, then the title screen appears.
  function playLogos(done) {
    if (window.BLC_FAST) return done();
    hide('title');
    const old = $('#logos'); if (old) old.remove();
    const el = document.createElement('div'); el.id = 'logos';
    document.body.appendChild(el);
    const seq = [['engine/img/logo_aksys.png', '#000', 480], ['engine/img/logo_spike.png', '#fff', 503]];
    let i = 0;
    const step = () => {
      if (i >= seq.length) { el.remove(); done(); return; }
      const [src, bg, w] = seq[i++];
      el.style.background = bg;
      el.innerHTML = '<img alt="" style="width:calc(min(100vw, 75dvh) * ' + (w / 640) + ')">';
      const img = $('img', el);
      img.onerror = () => step();
      img.src = src;
      img.style.opacity = 0; void img.offsetWidth;
      img.style.transition = 'opacity 1s linear'; img.style.opacity = 1;
      setTimeout(() => { img.style.opacity = 0; setTimeout(step, 1000); }, 2000);
    };
    step();
  }
  // Shake detection for secret pages (the original turns the accelerometer on in pushSecretPage_).
  // In the Android app the system says up front whether there is an accelerometer; in a browser a
  // device counts as able to shake once it reports real motion data.
  let motionSeen = !!(NATIVE && NATIVE.hasAccelerometer && NATIVE.hasAccelerometer()), shakes = [], lastMag = 0;
  window.addEventListener('devicemotion', ev => {
    const a = ev.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    motionSeen = true;
    if (!cur || !cur.secret || busy || anyOpen()) return;
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / 9.81;
    const now = performance.now();
    if (Math.abs(mag - 1) > 1 && Math.abs(mag - lastMag) > 0.5) shakes.push(now);
    lastMag = mag;
    shakes = shakes.filter(t => now - t < 1500);
    if (shakes.length >= 3) { shakes = []; choose(cur.secret); }
  });
  const cover = $('#startcover');
  // The Android app allows audio without a tap, so it starts straight away like the original.
  if (NATIVE) { cover.remove(); toTitle(); }
  else cover.addEventListener('click', () => {
    // iOS asks for permission before motion events are delivered; it must happen inside a tap.
    try { if (TOUCH && window.DeviceMotionEvent && DeviceMotionEvent.requestPermission) DeviceMotionEvent.requestPermission().catch(() => { }); } catch (e) { }
    cover.remove(); toTitle();
  });
  // Hooks for automated tests
  window.BLC = { goto, next, choose, back, toTitle, startNew, state: () => cur, flags: () => flags, Audio: Audio_, loadState, snapshot };
})();

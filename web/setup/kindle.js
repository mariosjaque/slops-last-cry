/*
 * Kindle export: turns an already set-up Slop's Last Cry folder into a KUAL extension for jailbroken
 * Kindles (made for the Paperwhite 3, firmware 5.12 or newer). Runs in the setup page on PC, after
 * vita.js (it shares its page parser).
 *
 * The extension starts a small web app (a "WAF") in the Kindle's own browser engine:
 *   slc-kindle/config.xml, menu.json, run.sh   the KUAL entry, and the script that registers and opens the app
 *   slc-kindle/waf/                            the app: index.html, engine.js, story.js, grayscale pictures
 * The reader is deliberately plain for e-ink: grayscale pictures behind white text, no animations,
 * no sound, whole-screen pages turned by tapping the sides.
 * Nothing here is sent anywhere; it all stays in the folder the player chose.
 */
(function () {
  'use strict';
  const C = window.SLCConvert;
  const APP = 'ink-en.app/', OUT = 'slc-kindle/', FOLDER = 'slopslastcry', APP_ID = 'xyz.mariosjaque.slopslastcry';
  const td = new TextDecoder();

  // ===================================================================================================
  // The engine that runs on the Kindle. Written as plain ES5 (the Kindle's WebKit is old) and saved
  // to waf/engine.js by turning this function back into source text.
  // ===================================================================================================
  function kindleEngine() {
    var D = window.STORY, CH = D.chapters, STR = D.strings || {};
    var IMGSET = {}, i;
    for (i = 0; i < D.images.length; i++) IMGSET[D.images[i]] = 1;
    var $ = function (id) { return document.getElementById(id); };
    var W = window.innerWidth || 1072, H = window.innerHeight || 1448;
    function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function merge(a, b) { var o = {}, k; for (k in a) if (has(a, k)) o[k] = a[k]; for (k in b) if (has(b, k)) o[k] = b[k]; return o; }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function log(s) { if (window.console) console.log(s); }
    function imgKey(name) {
      if (!name) return null;
      if (IMGSET['en.lproj/' + name]) return 'en.lproj/' + name;
      if (IMGSET[name]) return name;
      return null;
    }
    function imgUrl(key) { return 'img/' + key.split('/').map(encodeURIComponent).join('/'); }

    // ---------- storage ----------
    var LS = {
      get: function (k, d) { try { var s = window.localStorage.getItem('blc_' + k); if (s == null) return d; var v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } },
      set: function (k, v) { try { window.localStorage.setItem('blc_' + k, JSON.stringify(v)); } catch (e) { log('save failed ' + e); } },
      del: function (k) { try { window.localStorage.removeItem('blc_' + k); } catch (e) { } }
    };
    var DEF = { size: 5, font: 'm', bgb: 35, gore: 1, dir: 'R' };
    var LOCAL = /^(local_|flag_from_|flag_name_|_main_$|flag_mc4030_1time$)/;
    var S, G, visited, chapSeen, flags, names;
    function loadProgress() {
      S = merge(DEF, LS.get('settings', {}));
      G = merge({ flags: {}, visited: [], chapters: [] }, LS.get('global', {}));
      visited = {}; for (var k = 0; k < G.visited.length; k++) visited[G.visited[k]] = 1;
      chapSeen = G.chapters.slice();
      flags = merge({}, G.flags);
      names = LS.get('names', { main: STR.NameInput_MainName || 'Max', sub: STR.NameInput_SubName || 'Grace' });
    }
    function saveSettings() { LS.set('settings', S); }
    var gTimer = 0;
    function saveGlobal() {
      clearTimeout(gTimer);
      gTimer = setTimeout(function () {
        var gf = {}, k, v = [];
        for (k in flags) if (has(flags, k) && !LOCAL.test(k)) gf[k] = flags[k];
        for (k in visited) if (has(visited, k)) v.push(k);
        LS.set('global', { flags: gf, visited: v, chapters: chapSeen });
      }, 300);
    }
    function localFlags() { var o = {}, k; for (k in flags) if (has(flags, k) && LOCAL.test(k)) o[k] = flags[k]; return o; }
    function setLocalFlags(o) { var k; for (k in flags) if (has(flags, k) && LOCAL.test(k)) delete flags[k]; for (k in (o || {})) if (has(o, k)) flags[k] = o[k]; }

    // ---------- timers owned by a page (cleared when it is left) ----------
    var timers = [];
    function setTimer(fn, ms, owner) {
      var t = { owner: owner, id: 0 };
      t.id = setTimeout(function () { timers.splice(timers.indexOf(t), 1); try { fn(); } catch (e) { log('timer ' + e); } after(); }, ms || 0);
      timers.push(t); return t.id;
    }
    function clearTimer(id) { for (var k = 0; k < timers.length; k++) if (timers[k].id === id) { clearTimeout(id); timers.splice(k, 1); return; } }
    function clearOwner(o) { for (var k = timers.length - 1; k >= 0; k--) if (timers[k].owner === o) { clearTimeout(timers[k].id); timers.splice(k, 1); } }
    function after() { if (cur && cur.dirty && screen === 'game') render(true); }

    // ---------- picture behind the text ----------
    var bgName = '', bright = 0;
    function setBg(name) {
      var key = name && name.indexOf('movies/') === 0 ? name : imgKey(name);
      bgName = name || '';
      $('bg').style.backgroundImage = key ? 'url("' + (key.indexOf('movies/') === 0 ? key : imgUrl(key)) + '")' : 'none';
    }
    function shade() { $('shade').style.opacity = Math.max(Math.min(85, 100 - S.bgb) / 100, bright); }

    // ---------- text ----------
    function sizeMul() { var v = +S.size; return v >= 1 && v <= 10 ? 1 + (v - 5) * 0.1 : 1; }
    function fontPx() { return Math.round(W * 0.042 * sizeMul()); }
    function applyFont() {
      document.body.style.fontFamily = S.font === 'g' ? 'Futura, Helvetica, Arial, sans-serif' : 'Baskerville, "Libre Baskerville", Georgia, serif';
      $('text').style.fontSize = fontPx() + 'px';
    }
    function runsHtml(runs) {
      var out = '', k, r, s;
      for (k = 0; k < (runs || []).length; k++) {
        r = runs[k];
        if (r.br) { out += '<br>'; continue; }
        s = r.v ? (r.v === 1 ? names.main : names.sub) : r.s;
        if (!s) continue;
        s = esc(s);
        if (r.b) s = '<b>' + s + '</b>';
        if (r.i) s = '<i>' + s + '</i>';
        if (r.col) s = '<span style="color:' + esc(r.col) + '">' + s + '</span>';
        out += s;
      }
      return out;
    }
    function blocksHtml(blocks, pg) {
      var out = '', k, b, j, it, cls;
      for (k = 0; k < blocks.length; k++) {
        b = blocks[k];
        if (b.k === 'sp') { out += '<div class="sp"></div>'; continue; }
        if (b.k === 'hr') { out += '<hr' + (b.c === 'credit_hr' ? ' class="credit_hr"' : '') + '>'; continue; }
        if (b.k === 'img') {
          var key = imgKey(b.src); if (!key) continue;
          var sz = D.imgsize && D.imgsize[key], w = sz ? Math.min(100, sz[0] / 640 * 100 / 0.84) : 60;
          out += '<div class="pimg"><img src="' + imgUrl(key) + '" style="width:' + w.toFixed(1) + '%"></div>'; continue;
        }
        if (b.k === 'ul') {
          out += '<div class="choices' + (/end_select/.test(b.c) ? ' end' : '') + '">';
          for (j = 0; j < b.items.length; j++) {
            it = b.items[j];
            out += '<a class="ch' + (it.c === 'selected' ? ' visited' : '') + '" data-a="' + act(choiceAction(it, pg)) + '">' + runsHtml(it.r) + '</a>';
          }
          out += '</div>'; continue;
        }
        cls = (b.c || '').replace(/[^\w ]/g, '');
        out += '<p class="' + cls + '">' + runsHtml(b.r) + '</p>';
      }
      return out;
    }
    function choiceAction(it, pg) { return function () { if (cur === pg) choose(it.sel); }; }

    // ---------- actions behind taps: data-a on the page, data-u in menus ----------
    var actions = [], uacts = [];
    function act(fn) { actions.push(fn); return actions.length - 1; }
    function uact(fn) { uacts.push(fn); return uacts.length - 1; }

    // ---------- pages ----------
    var cur = null, history = [], trail = [], screen = 'title';
    function seqOf(k) { return CH[k] && CH[k].p ? [k].concat(CH[k].p) : null; }
    function locate(id, prefer) {
      if (CH[id] && CH[id].p) return { chap: id, idx: 0 };
      var s, k, ix;
      if (prefer && seqOf(prefer)) { ix = seqOf(prefer).indexOf(id); if (ix > 0) return { chap: prefer, idx: ix }; }
      for (k in CH) if (has(CH, k)) { s = seqOf(k); if (s) { ix = s.indexOf(id); if (ix > 0) return { chap: k, idx: ix }; } }
      return null;
    }
    function chapterTitleFor(id, ctx) {
      if (CH[id] && CH[id].t) return CH[id].t;
      if (ctx && CH[ctx.chap] && CH[ctx.chap].t) return CH[ctx.chap].t;
      return '';
    }
    function parseSel(a) {
      var m = String(a).match(/^((\w+):)?(\w+)?(\s*)?(\S.*)?$/);
      if (!m) return null;
      return { type: m[2], target: m[3], args: m[5] ? m[5].split(/\s+/) : [] };
    }
    var KMJS = 'function removeElementById(id){ km.hideElementById(id); }\n' +
      'var bgm_vol_high=0.5,bgm_vol_normal=0.4,bgm_vol_low=0.3,env_vol_high=0.4,env_vol_normal=0.30,env_vol_low=0.20,se_vol_high=1.0,se_vol_normal=1.0,se_vol_low=0.5;\n' +
      'var fade_time_long=5.0,fade_time_normal=3.0,fade_time_short=1.0,fade_time_very_short=0.5,fade_time_very2_short=0.2,fade_time_none=0.0;\n' +
      'var name_mikimoto=100,name_tanaka=101,name_kobayashi=102,name_kyoko=103,name_toshio=104,name_midori=105,name_kayama=106,name_haruko=107,name_kanako=108,name_aki=109,name_keiko=110,name_ol3=111;\n' +
      'var from_be0220=0,from_be0290=1;\n';
    function noop() { }
    function makeKm(pg) {
      var own = function (fn) { return function () { if (cur === pg) return fn.apply(null, arguments); }; };
      var km = {
        setBg: function (a) { setBg(a || 'wh.jpg'); },
        setBgViolence: function (a, b, c) { setBg([a, b, c][+S.gore] || a || 'wh.jpg'); },
        slideBGImage_ox_oy_w_h_tx_ty_dur: function (a) { setBg(a || 'wh.jpg'); },
        setBrightness: function (v) { bright = clamp(+v || 0, 0, 1); shade(); },
        playMovie_mw_mh_oy_rep: function (f) { if (D.posters && D.posters[f]) setBg('movies/' + D.posters[f]); },
        playMovie_oy_rep: function (f) { if (D.posters && D.posters[f]) setBg('movies/' + D.posters[f]); },
        setTimeout: function (fn, ms) { return setTimer(typeof fn === 'function' ? fn : function () { pg.fns.__eval(String(fn)); }, ms, pg); },
        getFlag: function (n) { return n === '_unlocked_' ? 1 : n === '_is_ipad_' ? 0 : n === '_is_gothic_font_' ? (S.font === 'g' ? 1 : 0) : n === '_font_size_' ? fontPx() : (flags[n] || 0); },
        setFlag: function (n, v) { flags[n] = v; if (!LOCAL.test(n)) saveGlobal(); },
        getf: function () { return flags._main_ || 0; },
        setf: function (v) { flags._main_ = v; },
        isUnlocked: function () { return 1; }, isIPad: function () { return 0; }, isFontGothic: function () { return S.font === 'g' ? 1 : 0; }, getFontSizePx: function () { return fontPx(); },
        pushSelectPage: own(function (n) { pg.override = n; }),
        pushSecretPage: own(function (s) { pg.secret = s; pg.dirty = true; }),
        altBranch: function (t) { choose('alt:' + t); },
        fltBranch: function (t) { choose('flt:' + t); },
        transitionBranch: function (t) { choose('trs:' + t); },
        nameInput: function () { openKiller(); }, returnTitle: function () { toTitle(); }, returnStart: function () { restartStory(); },
        consoleLog: function (a) { log('page: ' + a); },
        hideElementById: function (id) { removeElement(pg, id); },
        listToArray: function (a) { return a ? Array.prototype.slice.call(a) : null; },
        parseSelectString: function (a) { var p = parseSel(a); return p ? [p.type, p.target, p.args.join(' '), p.args] : null; },
        isBranchPage: function () { return (pg && pg.choices && pg.choices.length) ? '1' : ''; },
        scriptFlagsFromProg_: flags
      };
      // sound, vibration and moving pictures do nothing on the Kindle
      var quiet = ['playBgm_volume_fadein_repeat', 'playBgm_volume_crossfade_repeat', 'changeBgm_volume_fadein_repeat', 'changeBgm_volume_crossfade_repeat',
        'playEnv_volume_fadein_repeat', 'playEnv_volume_crossfade_repeat', 'changeEnv_volume_fadein_repeat', 'changeEnv_volume_crossfade_repeat',
        'playSe_volume_fadein_repeat', 'changeSe_volume_fadein_repeat', 'stopBgm_fadeout', 'stopEnv_fadeout', 'stopSe_fadeout', 'stopSound', 'playVibrate',
        'slideBg_x_y_time', 'slideBg_x_y_x_y_time', 'rotateBg_rot_cx_cy_time', 'rotateBg_rot_rot_cx_cy_time', 'scaleBg_sx_sy_cx_cy_time', 'scaleBg_sx_sy_time',
        'scaleBg_scale_time', 'scaleBg_scale_cx_cy_time', 'clearTimeoutTable', 'debugInitFlags', 'chargeAlert', 'refreshCharge', 'callPageJavaScriptEnd', 'refreshHide',
        'stopBgm_fadeoust', 'changeSe_Volume_fadein_repeat', 'changeBgm_Volume_fadein_repeat'];
      for (var k = 0; k < quiet.length; k++) km[quiet[k]] = noop;
      return km;
    }
    function removeElement(pg, id) {
      var hasId = function (x) { return x.ids && x.ids.indexOf(id) >= 0; };
      pg.blocks = pg.blocks.filter(function (b) { return !hasId(b); });
      pg.blocks.forEach(function (b) { if (b.k === 'ul') b.items = b.items.filter(function (it) { return it.id !== id && !hasId(it); }); });
      pg.blocks = pg.blocks.filter(function (b) { return b.k !== 'ul' || b.items.length; });
      pg.dirty = true;
    }
    function elementProxy(pg, id) {
      var o = { style: {}, setAttribute: noop, getAttribute: function () { return null; } };
      var set = function (v) {
        var s = String(v).replace(/<[^>]*>/g, '');
        var fix = function (runs) { var done = false, k; for (k = 0; k < runs.length; k++) if (runs[k].id === id) { if (!done) { runs[k] = { s: s, id: id }; done = true; } else { runs.splice(k, 1); k--; } } };
        pg.blocks.forEach(function (b) { if (b.r) fix(b.r); if (b.items) b.items.forEach(function (it) { fix(it.r); }); if (b.ids && b.ids[b.ids.length - 1] === id && b.r) b.r = [{ s: s, id: id }]; });
        pg.dirty = true;
      };
      if (Object.defineProperty) Object.defineProperty(o, 'innerHTML', { set: set, get: function () { return ''; } });
      return o;
    }
    function compileScript(pg) {
      var doc = { getElementById: function (id) { return elementProxy(pg, id); }, addEventListener: noop, write: noop, body: {} };
      if (Object.defineProperty) Object.defineProperty(doc, 'height', { get: function () { return Math.round(($('text').offsetHeight || H) * 320 / W); } });
      var st = function (f, t) { return setTimer(f, t, pg); }, ct = function (id) { clearTimer(id); };
      var f;
      try {
        f = new Function('km', 'document', '__st', '__ct', 'scrollBy', 'window',
          KMJS + 'var setTimeout=function(f,t){if(typeof f!=="function"){var __s=String(f);f=function(){eval(__s)}}return __st(f,t)};var clearTimeout=__ct;\n' +
          pg.src.s + '\n;return {ready:typeof ready=="function"?ready:null,play:typeof play=="function"?play:null,enter:typeof enter=="function"?enter:null,leave:typeof leave=="function"?leave:null,onNameInput:typeof onNameInput=="function"?onNameInput:null,__eval:function(s){return eval(s)}};');
      } catch (e) { log('script error in ' + pg.id + ' ' + e); return {}; }
      try { return f(pg.km, doc, st, ct, noop, {}) || {}; } catch (e2) { log('script run error in ' + pg.id + ' ' + e2); return {}; }
    }
    function callPage(pg, name, arg) { var fn = pg.fns && pg.fns[name]; if (fn) { try { return fn(arg); } catch (e) { log(name + ' error in ' + pg.id + ' ' + e); } } }
    function goto(id, opt) {
      opt = opt || {};
      if (!D.pages[id]) { toast('Missing page: ' + id); return; }
      var prev = cur;
      if (prev && !opt.noHistory) {
        history.push({ id: prev.id, ctx: prev.ctx, locals: prev.localsAtEntry, branch: !prev.linear });
        if (history.length > 1500) { history.shift(); trail.shift(); }
      }
      if (prev) { callPage(prev, 'leave'); clearOwner(prev); }
      mount(id, opt);
    }
    function mount(id, opt) {
      var ctx = opt.ctx || locate(id, cur && cur.ctx && cur.ctx.chap);
      var pg = { id: id, ctx: ctx, src: D.pages[id], blocks: JSON.parse(JSON.stringify(D.pages[id].b)), override: null, secret: null, linear: true,
        localsAtEntry: localFlags(), choices: [], dirty: true, page: opt.back ? -1 : 0 };
      var pos = history.length;
      if (trail.length < pos) trail = history.map(function (h) { return { id: h.id, ctx: h.ctx, locals: h.locals }; });
      if (!(trail[pos] && trail[pos].id === id)) { trail.length = pos; trail.push({ id: id, ctx: ctx, locals: pg.localsAtEntry }); }
      else trail[pos].ctx = ctx;
      cur = pg; screen = 'game'; closeUI();
      pg.km = makeKm(pg);
      bright = 0;
      pg.fns = compileScript(pg);
      callPage(pg, 'ready');
      pg.blocks.forEach(function (b) {
        if (b.k !== 'ul') return;
        b.items.forEach(function (it) {
          var p = parseSel(it.sel);
          if (it.c === 'select_lock') it.c = 'select';
          if (p && p.target && visited[p.target] && it.c === 'select') it.c = 'selected';
        });
      });
      visited[id] = 1;
      var ct = CH[id] && CH[id].t ? id : null;
      if (ct && chapSeen.indexOf(ct) < 0) chapSeen.push(ct);
      saveGlobal();
      if (!opt.back && !opt.load) callPage(pg, 'enter');
      callPage(pg, 'play');
      render(false);
      autosave();
    }
    function ctxNext(pg) {
      var c = pg.ctx, s = c && seqOf(c.chap), id;
      if (s && c.idx + 1 < s.length) { id = s[c.idx + 1]; return { id: id, ctx: (CH[id] && CH[id].p) ? { chap: id, idx: 0 } : { chap: c.chap, idx: c.idx + 1 } }; }
      var src = D.pages[pg.id];
      if (src.ifnot && !flags['global_' + src.ifnot[0]] && D.pages[src.ifnot[1]]) return { id: src.ifnot[1] };
      if (src.jump && D.pages[src.jump]) return { id: src.jump };
      return null;
    }
    function next() {
      if (!cur) return;
      if (!cur.linear) return;
      if (cur.override) { goto(cur.override); return; }
      var n = ctxNext(cur);
      if (n) { goto(n.id, n.ctx ? { ctx: n.ctx } : {}); return; }
      backToChoice();
    }
    function backToChoice() {
      while (history.length) {
        var h = history.pop();
        if (h.branch) { setLocalFlags(h.locals); goto(h.id, { noHistory: true, ctx: h.ctx }); return; }
      }
      toTitle();
    }
    function back() {
      if (!history.length || !cur) return;
      var h = history.pop();
      setLocalFlags(h.locals);
      goto(h.id, { noHistory: true, back: true, ctx: h.ctx });
    }
    function choose(s) {
      var p = parseSel(s);
      if (!p) return;
      switch (p.type) {
        case 'alt': case 'flt': case 'trs': case undefined: if (p.target) goto(p.target); break;
        case 'nameInput': openKiller(); break;
        case 'returnStart': restartStory(); break;
        case 'returnTitle': toTitle(); break;
        default: log('unknown select ' + s);
      }
    }

    // ---------- the reading view: whole screens, turned by tapping ----------
    // A page of the story is split into screens at paragraph (or, inside a long paragraph, line)
    // boundaries, so no line is ever cut in half; each screen shows only what fits entirely.
    var view = { pages: [[0, 0]], at: 0 };
    function render(keep) {
      var pg = cur; if (!pg) return;
      pg.dirty = false;
      actions = [];
      applyFont(); shade();
      pg.choices = [];
      pg.blocks.forEach(function (b) { if (b.k === 'ul') b.items.forEach(function (it) { pg.choices.push(it); }); });
      pg.linear = pg.choices.length === 0;
      var html = blocksHtml(pg.blocks, pg);
      if (pg.linear && !pg.override && !ctxNext(pg)) {
        var anyBranch = history.some(function (h) { return h.branch; });
        html += '<div class="choices"><a class="ch" data-a="' + act(function () { backToChoice(); }) + '">' + (anyBranch ? 'Return to the last choice' : 'Return to Title Screen') + '</a></div>';
      }
      if (pg.secret) html += '<div class="choices"><a class="ch" data-a="' + act(function () { var s = pg.secret; pg.secret = null; choose(s); }) + '">???</a></div>';
      $('text').innerHTML = html;
      layoutPages(keep ? null : (pg.page < 0 ? 'last' : 0));
    }
    // the blocks a screen may end after; a list of choices stays together when it fits on one screen
    function units(vh) {
      var out = [], kids = $('text').children, k, j;
      for (k = 0; k < kids.length; k++) {
        if (/\bchoices\b/.test(kids[k].className) && kids[k].offsetHeight > vh) { for (j = 0; j < kids[k].children.length; j++) out.push(kids[k].children[j]); }
        else out.push(kids[k]);
      }
      return out;
    }
    function layoutPages(to) {
      var vh = Math.round(H * 0.94), us = units(vh), pages = [], start = 0, guard = 0, k, u, top, bot, end, lh;
      var total = $('text').offsetHeight;
      var box = us.map(function (el) { return { top: el.offsetTop, bot: el.offsetTop + el.offsetHeight, el: el }; });
      while (start < total - 2 && guard++ < 500) {
        var more = false;
        for (k = 0; k < box.length; k++) if (box[k].bot > start + 1) { more = true; break; }
        if (!more) break;   // only the bottom padding is left
        var limit = start + vh; end = start;
        for (k = 0; k < box.length; k++) { u = box[k]; if (u.bot <= start + 1) continue; if (u.top >= start - 1 && u.bot <= limit) end = Math.max(end, u.bot); else break; }
        if (end <= start) {   // a paragraph taller than what is left: break it between lines
          u = null; for (k = 0; k < box.length; k++) if (box[k].bot > start + 1) { u = box[k]; break; }
          lh = u ? parseFloat(window.getComputedStyle(u.el, null).lineHeight) || 40 : 40;
          top = u ? Math.max(u.top, 0) : start;
          end = top + Math.floor((limit - top) / lh) * lh;
          if (end <= start) end = limit;
        }
        pages.push([start, end]);
        // the next screen starts at the next thing to show (skipping the margin between paragraphs)
        bot = end;
        for (k = 0; k < box.length; k++) if (box[k].top >= end - 1) { bot = box[k].top; break; } else if (box[k].bot > end + 1) { bot = end; break; }
        start = Math.max(bot, end);
        if (start >= total) break;
      }
      if (!pages.length) pages.push([0, Math.min(total, vh)]);
      // pages start below the top padding of the first screen
      pages[0][0] = 0;
      view.pages = pages;
      if (to === 'last') view.at = pages.length - 1; else if (to === 0) view.at = 0;
      showPage();
    }
    function showPage() {
      view.at = clamp(view.at, 0, view.pages.length - 1);
      var p = view.pages[view.at], pad = view.at === 0 ? 0 : Math.round(H * 0.04);
      $('view').style.top = pad + 'px';
      $('view').style.height = (p[1] - p[0]) + 'px';
      $('text').style.top = -p[0] + 'px';
      $('pageno').innerHTML = view.pages.length > 1 ? (view.at + 1) + ' / ' + view.pages.length : '';
    }
    function forward() {
      if (screen !== 'game' && screen !== 'help') return;
      if (view.at < view.pages.length - 1) { view.at++; showPage(); return; }
      if (screen === 'help') { helpDone(); return; }
      next();
    }
    function backward() {
      if (screen !== 'game' && screen !== 'help') return;
      if (view.at > 0) { view.at--; showPage(); return; }
      if (screen === 'game') back();
    }

    // ---------- saving ----------
    var SLOTS = ['slot1', 'slot2', 'slot3'];
    function snapshot() {
      if (!cur) return null;
      return { id: cur.id, ctx: cur.ctx, locals: cur.localsAtEntry, names: names, bg: bgName, time: Date.now(), title: chapterTitleFor(cur.id, cur.ctx), hist: history.slice(-400), trail: trail.slice(-600) };
    }
    function autosave() { var s = snapshot(); if (s) LS.set('auto', s); }
    function loadState(s) {
      if (!s || !D.pages[s.id]) { toast('No saved data'); return; }
      names = s.names || names; LS.set('names', names);
      setLocalFlags(s.locals);
      history = s.hist && s.hist.slice ? s.hist.slice() : [];
      trail = s.trail && s.trail.length > history.length ? s.trail.slice() : history.map(function (h) { return { id: h.id, ctx: h.ctx, locals: h.locals }; });
      cur = null;
      goto(s.id, { noHistory: true, load: true, ctx: s.ctx });
    }

    // ---------- menus and dialogs (drawn over the page) ----------
    function openUI(html, cls) { $('ui').innerHTML = html; $('ui').className = cls || 'panel'; $('ui').style.display = 'block'; }
    function closeUI() { $('ui').style.display = 'none'; $('ui').innerHTML = ''; }
    function uiOpen() { return $('ui').style.display === 'block'; }
    function button(label, fn, cls) { return '<a class="btn' + (cls ? ' ' + cls : '') + '" data-u="' + uact(fn) + '">' + esc(label) + '</a>'; }
    var toastT = 0;
    function toast(m) { var t = $('toast'); t.innerHTML = esc(m); t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, 1800); }
    function dialog(title, body, buttons) {
      uacts = [];
      var h = '<div class="dlg"><h2>' + esc(title) + '</h2><p>' + esc(body).replace(/\n/g, '<br>') + '</p><div class="row">';
      buttons.forEach(function (b) { h += button(b[0], function () { closeUI(); if (b[1]) b[1](); else if (screen === 'game' && cur) render(true); }); });
      openUI(h + '</div></div>', 'modal');
    }
    function gameMenu() {
      uacts = [];
      var h = '<h1>' + esc(cur ? chapterTitleFor(cur.id, cur.ctx) : '') + '</h1>';
      h += button(STR.PageJump_Title0 || 'Table of Contents', openToc);
      h += button(STR.Config_Save || 'Save Data', function () { openSaves('save'); });
      h += button('Load', function () { openSaves('load'); });
      h += button(STR.Config_Title || 'Settings', openSettings);
      h += button('Return to Title Screen', function () { dialog('Return to Title Screen', 'Return to the title screen?', [['Cancel'], ['OK', toTitle]]); });
      h += button('Back to the story', closeUI, 'dim');
      openUI(h);
    }
    function tocChapters() {
      var list = [], last = null;
      trail.forEach(function (h, k) {
        var t = chapterTitleFor(h.id, h.ctx); if (!t) return;
        if (!last || last.title !== t) { last = { title: t, start: { id: h.id, ctx: h.ctx, locals: h.locals, idx: k }, end: k }; list.push(last); }
        last.end = k;
      });
      return list;
    }
    function openToc() {
      uacts = [];
      var list = tocChapters(), pos = history.length;
      var h = '<h1>' + esc(STR.PageJump_Title0 || 'Table of Contents') + '</h1><p class="note">' + esc(STR.PageJump_Title1 || '(Jump to Chapter Start)') + '</p>';
      list.forEach(function (c) {
        var here = c.start.idx <= pos && pos <= c.end;
        h += button(c.title, function () {
          history = trail.slice(0, c.start.idx).map(function (x) { return merge({}, x); });
          setLocalFlags(c.start.locals);
          goto(c.start.id, { noHistory: true, ctx: c.start.ctx });
        }, here ? 'here' : '');
      });
      h += button('Back', gameMenu, 'dim');
      openUI(h);
    }
    function fmtDate(t) {
      var d = new Date(t), p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function openSaves(mode) {
      uacts = [];
      var h = '<h1>' + esc(mode === 'save' ? (STR.Config_Save || 'Save Data') : 'Load') + '</h1>';
      var cells = mode === 'load' ? ['auto'].concat(SLOTS) : SLOTS.slice();
      var fmt = STR.ConfigSave_DataCharFormat || 'The Story of %@ and %@';
      cells.forEach(function (k) {
        var s = LS.get(k, null);
        var who = s ? fmt.replace('%@', s.names.main).replace('%@', s.names.sub) : fmt.replace('%@', '**').replace('%@', '**');
        var label = (k === 'auto' ? (STR.ConfigSave_AutoSaveSectionFooter || 'Auto Save') + ': ' : '') + who + (s ? ' · ' + (s.title || '') + ' · ' + fmtDate(s.time) : '');
        h += button(label, function () {
          if (mode === 'load') { if (s) loadState(s); return; }
          var doSave = function () { var sn = snapshot(); if (sn) { LS.set(k, sn); toast('Saved'); } closeUI(); if (cur) render(true); };
          if (s) dialog(STR.Config_Save || 'Save Data', STR.BookMarkCell_overwriteLabel || 'Overwrite this data?', [['Cancel'], ['OK', doSave]]); else doSave();
        }, s ? '' : 'empty');
      });
      h += button('Back', screen === 'title' ? openTitle : gameMenu, 'dim');
      openUI(h);
    }
    function openSettings() {
      uacts = [];
      var h = '<h1>' + esc(STR.Config_Title || 'Settings') + '</h1>';
      var row = function (label, opts, key, after) {
        var r = '<div class="set"><span>' + esc(label) + '</span><div class="row">';
        opts.forEach(function (o) { r += button(o[1], function () { S[key] = o[0]; saveSettings(); if (after) after(); openSettings(); }, S[key] === o[0] ? 'on' : ''); });
        return r + '</div></div>';
      };
      h += row(STR.Config_Size || 'Text size', [[3, 'Small'], [5, 'Medium'], [7, 'Large'], [9, 'Huge']], 'size');
      h += row('Font', [['m', 'Mincho'], ['g', 'Gothic']], 'font');
      h += row(STR.ConfigBrightness_Background || 'Background brightness', [[15, 'Dark'], [35, 'Dim'], [55, 'Bright']], 'bgb', shade);
      h += row(STR.Config_PageDirection || 'Page Direction', [['L', STR.ConfigPageDirection_Left || 'Left'], ['R', STR.ConfigPageDirection_Right || 'Right']], 'dir');
      h += row(STR.Config_Violence || 'Gore Level', [[0, STR.ConfigViolence_Nothing || 'Low'], [1, STR.ConfigViolence_Blur || 'Medium'], [2, STR.ConfigViolence_Normal || 'High']], 'gore');
      h += '<p class="note">Mincho uses the Kindle\'s Baskerville, Gothic uses Futura. Page Direction: the side you tap to read on.</p>';
      h += button(STR.Config_HowToPlay || 'How to Play', function () { showHelp('howtoplay', function () { if (cur) { screen = 'game'; render(false); } else openTitle(); }); });
      h += button('Erase progress', function () {
        dialog('Erase progress', 'Erase all progress (pages read, unlocked choices and saved data)? Settings are kept.', [['Cancel'], ['Erase', function () {
          ['global', 'auto'].concat(SLOTS).forEach(LS.del); flags = {}; visited = {}; chapSeen = []; toast('Progress erased'); toTitle();
        }]]);
      });
      h += button('Back', function () { if (cur && screen === 'game') { render(true); gameMenu(); } else openTitle(); }, 'dim');
      openUI(h);
    }

    // ---------- killer's name ----------
    function openKiller() {
      uacts = [];
      var h = '<div class="dlg"><h2>' + esc(STR.NameInput_KillerTitle || "Enter the killer's name.") + '</h2><input id="killer" type="text" maxlength="16"><div class="row">';
      h += button('Cancel', function () { closeUI(); });
      h += button('OK', function () {
        var v = ($('killer').value || '').replace(/^\s+|\s+$/g, ''); if (!v) return;
        closeUI();
        if (!cur || !cur.fns || !cur.fns.onNameInput) return;
        var r = null; try { r = cur.fns.onNameInput(v); } catch (e) { log('onNameInput ' + e); }
        if (r) choose(r);
      });
      openUI(h + '</div></div>', 'modal');
      try { $('killer').focus(); } catch (e) { }
    }

    // ---------- title, names, help ----------
    function toTitle() {
      if (cur) { callPage(cur, 'leave'); clearOwner(cur); }
      cur = null; history = []; trail = []; bright = 0;
      openTitle();
    }
    function restartStory() { setLocalFlags({}); history = []; trail = []; goto(D.start, { noHistory: true }); }
    function beginStory() { setLocalFlags({}); history = []; trail = []; cur = null; goto(D.start, { noHistory: true }); }
    function openTitle() {
      screen = 'title'; uacts = [];
      setBg('s_house.jpg'); bright = 0; shade(); $('text').innerHTML = ''; $('pageno').innerHTML = '';
      var logo = imgKey('engine/titlelogo.png') || null;
      var hasSave = !!LS.get('auto', null) || SLOTS.some(function (k) { return !!LS.get(k, null); });
      var h = (logo ? '<img class="logo" src="' + imgUrl(logo) + '">' : '<h1 class="logo">Banshee\'s Last Cry</h1>');
      h += '<div class="menu">' + button('From the beginning', openNames) + (hasSave ? button('From saved location', function () { openSaves('load'); }) : '') +
        button(STR.Config_Title || 'Settings', openSettings) + button('Quit', quit, 'dim') + '</div>';
      openUI(h, 'title');
    }
    function quit() { try { window.kindle.appmgr.start('app://com.lab126.booklet.home'); } catch (e) { try { window.kindle.appmgr.back(); } catch (e2) { window.close(); } } }
    function openNames() {
      uacts = [];
      var h = '<h1>' + esc(STR.NameInput_Title || 'Main characters') + '</h1>';
      h += '<label>' + esc(STR.NameInput_MainLabel || 'You') + '</label><input id="nm" type="text" maxlength="16" value="' + esc(names.main) + '">';
      h += '<label>' + esc(STR.NameInput_SubLabel || 'Your girlfriend') + '</label><input id="ns" type="text" maxlength="16" value="' + esc(names.sub) + '">';
      h += button(STR.NameInput_Start || 'Use these names', function () {
        var a = ($('nm').value || '').replace(/^\s+|\s+$/g, ''), b = ($('ns').value || '').replace(/^\s+|\s+$/g, '');
        if (a) names.main = a; if (b) names.sub = b; LS.set('names', names);
        closeUI();
        if (D.help && D.help.howtoplay_intro) showHelp('howtoplay_intro', beginStory); else beginStory();
      });
      h += button(STR.NameInput_Back || 'Return to Title Screen', openTitle, 'dim');
      openUI(h);
    }
    var helpDone = noop;
    function showHelp(key, done) {
      closeUI(); screen = 'help'; actions = [];
      helpDone = function () { helpDone = noop; done(); };
      applyFont();
      $('shade').style.opacity = 0.85;
      $('text').innerHTML = blocksHtml(D.help[key] || [], null) + '<div class="choices"><a class="ch" data-a="' + act(function () { helpDone(); }) + '">Continue</a></div>';
      layoutPages(0);
    }

    // ---------- input ----------
    function onTap(e) {
      var t = e.target;
      while (t && t !== document.body) {
        if (t.getAttribute) {
          var u = t.getAttribute('data-u'), a = t.getAttribute('data-a');
          if (u != null) { if (uacts[+u]) uacts[+u](); return; }
          if (a != null && !uiOpen()) { if (actions[+a]) actions[+a](); return; }
        }
        t = t.parentNode;
      }
      if (uiOpen()) return;
      var x = e.clientX != null ? e.clientX : (e.pageX || 0);
      var fwdSide = S.dir === 'L' ? x < W * 0.35 : x > W * 0.65, backSide = S.dir === 'L' ? x > W * 0.65 : x < W * 0.35;
      if (fwdSide) forward();
      else if (backSide) backward();
      else if (screen === 'game') gameMenu();
      else if (screen === 'help') forward();
    }
    document.addEventListener('click', onTap, false);
    try {
      if (window.kindle && window.kindle.gestures) {
        window.kindle.gestures.onswipe = function (dir) {
          if (uiOpen()) return;
          if (dir === 'left' || dir === 'up') forward(); else if (dir === 'right' || dir === 'down') backward();
        };
      }
    } catch (e) { }
    document.addEventListener('keydown', function (e) {   // page-turn keys (and a PC keyboard while testing)
      if (uiOpen() && e.target && e.target.tagName === 'INPUT') return;
      var k = e.keyCode;
      if (k === 34 || k === 39 || k === 32) forward(); else if (k === 33 || k === 37) backward(); else if (k === 27 && screen === 'game') { uiOpen() ? closeUI() : gameMenu(); }
    }, false);

    loadProgress();
    applyFont();
    openTitle();
    window.SLC = { goto: goto, state: function () { return { cur: cur && cur.id, screen: screen, view: view, choices: cur ? cur.choices.length : 0 }; } };
  }

  // ===================================================================================================
  // Files around the engine
  // ===================================================================================================
  const INDEX = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>Slop's Last Cry</title>
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; color: #fff; }
body { font-family: Baskerville, "Libre Baskerville", Georgia, serif; -webkit-user-select: none; }
#bg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; background: #000 center center no-repeat; -webkit-background-size: cover; background-size: cover; }
#shade { position: absolute; left: 0; top: 0; width: 100%; height: 100%; background: #000; opacity: 0.65; }
#view { position: absolute; left: 0; top: 0; width: 100%; height: 94%; overflow: hidden; }
#text { -webkit-box-sizing: border-box; box-sizing: border-box; }
#text { position: absolute; left: 8%; width: 84%; top: 0; padding: 7% 0 4% 0; line-height: 1.55; }
#text p { margin: 0 0 1em 0; }
#text .sp { height: 1.55em; }
#text hr { border: 0; border-top: 2px solid #aaa; margin: 1em 0; }
#text hr.credit_hr { margin-bottom: 6em; }
#text .pimg { text-align: center; margin: 0 0 0.5em 0; }
#text .bottom, #text .bottom_center { margin-bottom: 40%; }
#text .center, #text .bottom_center { text-align: center; }
#text .h1, #text .credit_h1 { font-size: 1.6em; font-weight: bold; margin: 0.67em 0; }
#text .h4 { font-weight: bold; margin: 1.33em 0; }
#text .dt, #text .credit_dt, #text .credit_dt3 { font-size: 0.75em; color: #bbb; margin-bottom: 0.2em; }
#text .credit_dt2 { font-size: 0.9em; margin-bottom: 0.2em; }
#text .dd, #text .credit_dd { font-size: 0.8em; margin-left: 1em; margin-bottom: 0.4em; }
#text .credit_dd2 { font-size: 0.75em; margin-bottom: 0.4em; }
#text .end_title { font-size: 0.75em; text-align: right; padding: 0.5em 0; }
#text .end_logo { font-size: 1.5em; text-align: right; padding: 1em 0; }
#text .end_info, #text .end_info_en { font-size: 0.75em; padding: 0.5em 0; }
.choices { margin: 1.2em 0 0 0; }
a.ch { display: block; margin: 0 0 0.6em 0; padding: 0.6em 0.8em; border: 3px solid #fff; background: #000; color: #fff; text-decoration: none; }
a.ch.visited { border-color: #888; color: #bbb; }
.choices.end a.ch { border-width: 2px; }
#pageno { position: absolute; right: 4%; bottom: 1.5%; font-size: 2.4vw; font-size: 26px; color: #ccc; }
#ui { display: none; position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; font-size: 40px; }
#ui.panel { background: #000; }
#ui.panel, #ui.title { padding: 6% 8%; -webkit-box-sizing: border-box; box-sizing: border-box; }
#ui.modal { background: rgba(0, 0, 0, 0.6); }
#ui h1 { font-size: 1.3em; margin: 0 0 0.8em 0; }
#ui h2 { font-size: 1.1em; margin: 0 0 0.6em 0; }
#ui .note { font-size: 0.75em; color: #ccc; }
#ui label { display: block; margin: 0.8em 0 0.3em 0; font-size: 0.85em; color: #ddd; }
#ui input { display: block; width: 100%; font-size: 1.2em; padding: 0.3em; margin: 0 0 0.6em 0; border: 3px solid #fff; background: #fff; color: #000; -webkit-box-sizing: border-box; box-sizing: border-box; font-family: inherit; }
a.btn { display: block; margin: 0 0 0.5em 0; padding: 0.55em 0.7em; border: 3px solid #fff; background: #000; color: #fff; text-decoration: none; }
a.btn.dim { border-color: #777; color: #ccc; }
a.btn.on, a.btn.here { background: #fff; color: #000; }
a.btn.empty { color: #999; border-color: #666; }
.set { margin: 0 0 0.8em 0; }
.set span { display: block; margin: 0 0 0.3em 0; }
.row a.btn { display: inline-block; margin: 0 0.4em 0.4em 0; }
.dlg { position: absolute; left: 7%; right: 7%; top: 25%; padding: 1em; background: #000; border: 4px solid #fff; }
#ui.title .logo { display: block; width: 100%; margin: 18% 0 25% 0; text-align: center; }
#ui.title .menu { margin: 0 6%; }
#toast { display: none; position: absolute; left: 20%; right: 20%; bottom: 8%; padding: 0.6em; text-align: center; background: #fff; color: #000; font-size: 36px; }
</style></head>
<body>
<div id="bg"></div><div id="shade"></div>
<div id="view"><div id="text"></div></div><div id="pageno"></div>
<div id="ui"></div><div id="toast"></div>
<script src="story.js"></script>
<script src="engine.js"></script>
</body></html>
`;
  const WAF_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:kindle="http://kindle.amazon.com/ns/widget-extensions" id="${APP_ID}" version="1.0" viewmodes="application">
  <name>Slop's Last Cry</name>
  <description>Slop's Last Cry</description>
  <content src="index.html" />
  <kindle:gestures>
    <kindle:param name="tap" value="yes"/>
    <kindle:param name="swipe" value="yes"/>
  </kindle:gestures>
  <kindle:messaging>
    <kindle:app name="com.lab126.chromebar" value="yes" />
    <kindle:app name="com.lab126.pillow" value="yes" />
    <kindle:app name="com.lab126.appmgrd" value="yes" />
    <kindle:app name="${APP_ID}" value="yes" />
  </kindle:messaging>
  <kindle:chrome>
    <kindle:asset key="configureSearchBar" value="system" />
  </kindle:chrome>
  <kindle:cookiejar>
    <kindle:asset key="persistent" value="true" />
  </kindle:cookiejar>
  <feature name="http://kindle.amazon.com/apis" required="true">
    <param name="appmgr" value="yes"/>
    <param name="chrome" value="yes"/>
    <param name="gestures" value="yes"/>
    <param name="messaging" value="yes"/>
    <param name="swipe" value="yes"/>
    <param name="tap" value="yes"/>
    <param name="viewport" value="yes"/>
  </feature>
</widget>
`;
  const KUAL_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<extension>
  <information>
    <name>Slop's Last Cry</name>
    <version>1.0</version>
    <author>Slop's Last Cry</author>
    <id>${FOLDER}</id>
  </information>
  <menus>
    <menu type="json" dynamic="true">menu.json</menu>
  </menus>
</extension>
`;
  const MENU = JSON.stringify({ items: [{ name: "Slop's Last Cry", action: '/bin/sh /mnt/us/extensions/' + FOLDER + '/run.sh' }] }, null, 2) + '\n';
  // registers the web app with the Kindle's app manager (once) and opens it
  const RUN = `#!/bin/sh
DB=/var/local/appreg.db
APP=${APP_ID}
sqlite3 "$DB" "INSERT OR IGNORE INTO handlerIds VALUES ('$APP')"
sqlite3 "$DB" "DELETE FROM properties WHERE handlerId='$APP'"
sqlite3 "$DB" "INSERT INTO properties (handlerId, name, value) VALUES ('$APP','command','/usr/bin/mesquite -l $APP -c file:///mnt/us/extensions/${FOLDER}/waf/')"
sqlite3 "$DB" "INSERT INTO properties (handlerId, name, value) VALUES ('$APP','unloadPolicy','unloadOnPause')"
sqlite3 "$DB" "INSERT INTO properties (handlerId, name, value) VALUES ('$APP','framework','')"
sqlite3 "$DB" "INSERT INTO properties (handlerId, name, value) VALUES ('$APP','lipcId','$APP')"
lipc-set-prop com.lab126.appmgrd start app://$APP
`;
  const README = `Slop's Last Cry for Kindle (KUAL extension)

Copy this whole folder to the Kindle as extensions/${FOLDER}
(so this file is at /mnt/us/extensions/${FOLDER}/README.txt), then open KUAL
and choose "Slop's Last Cry".

Tap the right side of the screen to read on, the left side to go back, and the
middle for the menu (Table of Contents, saving, settings). Saves stay on the Kindle.
Made from your own copy of the game: don't share this folder.
`;

  // ---------- pictures: grayscale, never larger than the Paperwhite's 1072x1448 screen ----------
  async function gray(bytes, name, vitaMax) {
    let bmp; try { bmp = await createImageBitmap(new Blob([bytes])); } catch (e) { return null; }
    const lw = bmp.width > vitaMax ? vitaMax : bmp.width, lh = bmp.width > vitaMax ? Math.round(bmp.height * vitaMax / bmp.width) : bmp.height;
    const s = Math.min(1, 1072 / bmp.width, 1448 / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h); bmp.close();
    const id = g.getImageData(0, 0, w, h), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = y; }
    g.putImageData(id, 0, 0);
    const png = /\.png$/i.test(name);
    const out = await cv.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.85 });
    return { bytes: new Uint8Array(await out.arrayBuffer()), size: [lw, lh] };
  }
  // one still frame from each movie, shown in its place
  async function poster(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4' }));
    try {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('cannot decode ' + name)); });
      v.currentTime = Math.min(1, v.duration / 2); await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      const cv = new OffscreenCanvas(v.videoWidth, v.videoHeight); cv.getContext('2d').drawImage(v, 0, 0);
      const jpg = new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
      return (await gray(jpg, 'x.jpg', 100000)).bytes;
    } finally { URL.revokeObjectURL(url); }
  }

  // ---------- main ----------
  async function exportKindle(fs, log) {
    log = log || (() => { });
    const step = (name, i, n) => log({ step: name, i, n });
    const parsePage = window.SLCVita.parsePage, enc = new TextEncoder();
    const dataSrc = await fs.read('engine/data.js');
    if (!dataSrc) throw new Error('Run the normal setup in this folder first (engine/data.js is missing).');
    const js = td.decode(dataSrc), D = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(';')));
    const root = await fs.list(APP), lproj = await fs.list(APP + 'en.lproj/'), eng = await fs.list('engine/img/');
    const pages = {}, ids = Object.keys(D.pages);
    for (let i = 0; i < ids.length; i++) { if (i % 25 === 0) step('kindle story', i, ids.length); pages[ids[i]] = parsePage(D.pages[ids[i]]); }
    const help = {};
    for (const h of ['howtoplay', 'howtoplay_intro']) { const b = await fs.read(APP + 'en.lproj/' + h + '.html'); if (b) help[h] = parsePage(td.decode(b)).b; }
    const movies = new Set();
    for (const k in D.pages) for (const m of D.pages[k].matchAll(/playMovie\w*\(\s*['"]([^'"]+)['"]/g)) movies.add(m[1]);
    const story = { start: D.start, chapters: D.chapters, strings: D.strings, pages, help, images: [], imgsize: {}, posters: {} };
    // pictures: backgrounds, pictures inside pages and the title logo (the interface is drawn in HTML)
    const imgs = [];
    lproj.filter(n => /\.(jpe?g|png)$/i.test(n) && !/~ipad|pagejump|^pj_/i.test(n)).forEach(n => imgs.push(['en.lproj/' + n, APP + 'en.lproj/' + n, 640]));
    root.filter(n => /\.(jpe?g|png)$/i.test(n) && !/^(Default|Icon|iTunes)|pagejump|~ipad/i.test(n)).forEach(n => imgs.push([n, APP + n, 1024]));
    eng.filter(n => /^titlelogo\.png$/i.test(n)).forEach(n => imgs.push(['engine/' + n, 'engine/img/' + n, 1024]));
    for (let i = 0; i < imgs.length; i++) {
      if (i % 10 === 0) step('kindle images', i, imgs.length);
      const [key, src, vitaMax] = imgs[i];
      const b = await fs.read(src); if (!b || C.isCgBI(b)) continue;
      const r = await gray(b, key, vitaMax); if (!r) continue;
      await fs.write(OUT + 'waf/img/' + key, r.bytes);
      story.imgsize[key] = r.size;
      story.images.push(key);
    }
    const mv = Array.from(movies).filter(m => root.includes(m));
    for (let i = 0; i < mv.length; i++) {
      step('kindle movies', i, mv.length);
      const b = await fs.read(APP + mv[i]); if (!b) continue;
      try { const p = await poster(b, mv[i]); const n = mv[i] + '.jpg'; await fs.write(OUT + 'waf/movies/' + n, p); story.posters[mv[i]] = n; } catch (e) { log({ warn: mv[i] + ': ' + e.message }); }
    }
    await fs.write(OUT + 'waf/story.js', enc.encode('window.STORY = ' + JSON.stringify(story) + ';\n'));
    await fs.write(OUT + 'waf/engine.js', enc.encode('/* Slop\'s Last Cry for Kindle: the reader (generated by setup/kindle.js) */\n(' + kindleEngine.toString() + ')();\n'));
    await fs.write(OUT + 'waf/index.html', enc.encode(INDEX));
    await fs.write(OUT + 'waf/config.xml', enc.encode(WAF_CONFIG));
    await fs.write(OUT + 'config.xml', enc.encode(KUAL_CONFIG));
    await fs.write(OUT + 'menu.json', enc.encode(MENU));
    await fs.write(OUT + 'run.sh', enc.encode(RUN));
    await fs.write(OUT + 'README.txt', enc.encode(README));
    step('done', 1, 1);
  }
  window.SLCKindle = { exportKindle, engineSource: () => '(' + kindleEngine.toString() + ')();' };
})();

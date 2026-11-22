/* app.js — 番茄下载器 UI */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var A = window.Android || null;

  /* ---------------- 基础工具 ---------------- */
  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function u8ToB64(u) {
    var s = [], i, n = u.length;
    for (i = 0; i < n; i += 3) {
      var b0 = u[i], b1 = u[i + 1], b2 = u[i + 2];
      s.push(B64C[b0 >> 2]);
      s.push(B64C[((b0 & 3) << 4) | ((b1 || 0) >> 4)]);
      s.push(i + 1 < n ? B64C[((b1 & 15) << 2) | ((b2 || 0) >> 6)] : '=');
      s.push(i + 2 < n ? B64C[b2 & 63] : '=');
    }
    return s.join('');
  }
  function b64ToU8(str) {
    var s = String(str).replace(/[^A-Za-z0-9+/]/g, '');
    var total = Math.floor(s.length * 3 / 4);
    while (s.length % 4 || s.length === 0) s += 'A';
    var out = new Uint8Array(total), o = 0, i;
    for (i = 0; i < s.length; i += 4) {
      var n0 = B64C.indexOf(s[i]) << 18 | B64C.indexOf(s[i + 1]) << 12 | B64C.indexOf(s[i + 2]) << 6 | B64C.indexOf(s[i + 3]);
      if (o < total) out[o++] = (n0 >> 16) & 255;
      if (o < total) out[o++] = (n0 >> 8) & 255;
      if (o < total) out[o++] = n0 & 255;
    }
    return out;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function saveJobs() {
    try {
      var keep = [];
      state.jobs.forEach(function (j) {
        if (j.status === 'ok') return;
        keep.push({
          id: String(j.id), name: j.name || String(j.id), total: j.total || 0, done: j.done || 0,
          pct: j.pct || 0, err: j.err || '', status: j.status === 'run' ? 'pause' : j.status,
          written: j.written || 0, saveRef: j.saveRef || '',
          rangeFrom: j.rangeFrom || 0, rangeTo: j.rangeTo || 0
        });
      });
      LS.set('fq_jobs', keep);
    } catch (e) { }
  }

  function upsAdd(name, ref) {
    try {
      if (!ref) return;
      var a = LS.get('fq_ups', []) || [];
      a = a.filter(function (x) { return x && x.name !== name; });
      a.unshift({ name: name, ref: ref, up: 'wait' });
      LS.set('fq_ups', a.slice(0, 50));
    } catch (e) { }
  }

  function upsSet(name, st) {
    try {
      var a = LS.get('fq_ups', []) || [];
      a.forEach(function (x) { if (x && x.name === name) x.up = st; });
      LS.set('fq_ups', a);
    } catch (e) { }
  }

  function upsPending() {
    try {
      return (LS.get('fq_ups', []) || []).filter(function (x) { return x && x.up !== 'ok'; });
    } catch (e) { return []; }
  }

  function upsOne(name, ref) {
    if (!(A && A.uploadFile)) { toast('这个版本不支持手动上传'); return; }
    state.jobs.forEach(function (j) { if (j.name === name) { j.up = 'run'; j.step = '正在上传到书库…'; } });
    upsSet(name, 'run');
    renderDownloads();
    var r = A.uploadFile(name + (/\.txt$/.test(name) ? '' : '.txt'), ref || '');
    if (r && String(r).indexOf('ERR') === 0) {
      toast(String(r).slice(4));
      state.jobs.forEach(function (j) { if (j.name === name) j.up = 'fail'; });
      upsSet(name, 'fail');
      renderDownloads();
    }
  }

  function upsAll() {
    var list = upsPending().filter(function (x) { return x.up !== 'run'; });
    if (!list.length) { toast('没有待上传的书'); return; }
    list.forEach(function (x) { upsOne(x.name, x.ref); });
    toast('开始上传 ' + list.length + ' 本');
  }

  window.fqUpDone = function (name, res) {
    name = String(name || '').replace(/\.txt$/, '');
    var ok = String(res || '').indexOf('OK:') === 0;
    state.jobs.forEach(function (j) {
      if (j.name !== name) return;
      j.up = ok ? 'ok' : 'fail';
      j.step = ok ? ('\u2713 已入库' + String(res).slice(2).replace('|', ' · ') + ' 章')
                  : ('没入库：' + String(res || '').replace(/^[A-Z]+:/, ''));
    });
    upsSet(name, ok ? 'ok' : 'fail');
    var changed = false;
    state.dls.forEach(function (d) { if (d.name === name) { d.up = ok ? 'ok' : 'fail'; changed = true; } });
    if (changed) LS.set('fq_dls', state.dls);
    renderDownloads();
  };

  function restoreJobs() {
    var saved = LS.get('fq_jobs', []);
    if (!saved || !saved.length) return;
    saved.forEach(function (s) {
      if (!s.id) return;
      var dup = null;
      state.jobs.forEach(function (j) { if (String(j.id) === String(s.id)) dup = j; });
      if (dup) return;
      var w = Number(s.written || 0);
      state.jobs.push({
        id: String(s.id), name: s.name || String(s.id), status: 'pause', paused: true,
        done: Number(s.done || 0), total: Number(s.total || 0), pct: Number(s.pct || 0),
        phase: '已中断', err: s.err || '', written: w, saveRef: s.saveRef || '',
        resumeFrom: (s.saveRef ? w : 0),
        rangeFrom: Number(s.rangeFrom || 0), rangeTo: Number(s.rangeTo || 0),
        step: (s.saveRef && w > 0)
          ? '上次中断时已写 ' + w + ' 章，点「继续」从第 ' + (w + 1) + ' 章接着下'
          : '上次没下完，点「继续」重新开始'
      });
    });
    renderDownloads();
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }
  function fmtDur(sec) {
    sec = Math.round(Number(sec) || 0);
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60), s2 = sec % 60;
    if (m < 60) return m + ' 分' + (s2 ? s2 + ' 秒' : '');
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  function fmtSize(n) {
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('on'); }, 1900);
  }

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };

  /* ---------------- 网络桥 ---------------- */
  var seq = 0, pending = {};
  window.__net = function (id, status, b64) {
    var r = pending[id];
    if (!r) return;
    delete pending[id];
    try { r({ status: status | 0, body: b64 ? b64ToU8(b64) : new Uint8Array(0) }); }
    catch (e) { r({ status: 0, body: new Uint8Array(0) }); }
  };
  function net(req) {
    return new Promise(function (res, rej) {
      if (!A || !A.http) { rej(new Error('网络桥不可用')); return; }
      var id = ++seq;
      pending[id] = res;
      var body = '';
      if (req.body) {
        body = (typeof req.body === 'string') ? u8ToB64(new TextEncoder().encode(req.body)) : u8ToB64(req.body);
      }
      try { A.http(String(id), req.method || 'GET', req.url, JSON.stringify(req.headers || {}), body); }
      catch (e) { delete pending[id]; rej(e); }
      setTimeout(function () { if (pending[id]) { delete pending[id]; res({ status: 0, body: new Uint8Array(0) }); } }, 45000);
    });
  }

  FQ.init({ net: net, store: { get: function (k) { return LS.get(k, null); }, set: function (k, v) { LS.set(k, v); } } });

  /* ---------------- 文件保存 ---------------- */
  function saveText(name, text) {
    return new Promise(function (res, rej) {
      var bytes = new TextEncoder().encode(text);
      if (A && A.saveStart) {
        var tok = A.saveStart(name);
        if (!tok || String(tok).indexOf('ERR') === 0) { rej(new Error(String(tok).slice(4) || '保存失败')); return; }
        try {
          var CH = 192 * 1024;
          for (var i = 0; i < bytes.length; i += CH) {
            A.saveAppend(u8ToB64(bytes.subarray(i, i + CH)));
          }
          var out = A.saveEnd();
          if (!out || String(out).indexOf('ERR') === 0) { rej(new Error(String(out).slice(4) || '写入失败')); return; }
          res({ path: out, size: bytes.length });
        } catch (e) { rej(e); }
        return;
      }
      // 浏览器预览回退
      var blob = new Blob([bytes], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      res({ path: '浏览器下载/' + name, size: bytes.length });
    });
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    view: 'search',
    rankGender: 1,
    results: [],
    dls: LS.get('fq_dls', []),
    jobs: [],
    busy: false,
    lastQuery: ''
  };
  var MIN_GAP = 1100, BATCH = 30;
  var lastReq = 0;
  function pace() {
    var now = Date.now(), wait = lastReq + MIN_GAP - now;
    lastReq = now + Math.max(0, wait);
    return wait > 0 ? sleep(wait) : Promise.resolve();
  }

  /* ---------------- 系统栏 inset（native 注入） ---------------- */
  window.__insets = function (top, bottom, ime) {
    try {
      var st = document.documentElement.style;
      if (st && st.setProperty) {
        st.setProperty('--inset-top', (top | 0) + 'px');
        st.setProperty('--inset-bottom', (bottom | 0) + 'px');
        st.setProperty('--ime', (ime | 0) + 'px');
      }
    } catch (e) { }
  };
  function haptic(ms) { try { if (A && A.haptic) A.haptic(ms || 10); } catch (e) { } }

  /* ---------------- 视图切换 ---------------- */
  function switchView(v) {
    state.view = v;
    $$('.view').forEach(function (el) { el.classList.toggle('active', el.id === 'view-' + v); });
    var idx = ['search', 'rank', 'dl'].indexOf(v);
    $$('.tab').forEach(function (b, i) { b.classList.toggle('active', i === idx); });
    var pill = $('#tabPill');
    if (pill && pill.style) pill.style.transform = 'translateX(' + (idx * 100) + '%)';
    if (v === 'dl') renderDownloads();
    if (v === 'rank' && !$('#rankList').childElementCount) loadRank();
  }
  $$('.tab').forEach(function (b) { b.addEventListener('click', function () { switchView(b.dataset.view); }); });
  $$('.subtab').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('.subtab').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); state.rankGender = Number(b.dataset.g);
      loadRank();
    });
  });

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    var b = document.body;
    if (!b || !b.classList) return;
    b.classList.remove('theme-dark'); b.classList.remove('theme-light');
    b.classList.add(t === 'theme-light' ? 'theme-light' : 'theme-dark');
    state.theme = t;
    LS.set('fq_theme', t);
    try { if (A && A.setBars) A.setBars(t === 'theme-light'); } catch (e) { }
    try {
      var m = document.querySelector('meta[name="theme-color"]');
      if (m && m.setAttribute) m.setAttribute('content', t === 'theme-light' ? '#F4F6FA' : '#08090D');
    } catch (e) { }
  }
  function toggleTheme() {
    haptic(12);
    applyTheme(state.theme === 'theme-light' ? 'theme-dark' : 'theme-light');
    toast(state.theme === 'theme-light' ? '浅色模式' : '深色模式');
  }

  /* ---------------- 搜索 ---------------- */
  var hotWords = ['斩神', '十日终焉', '我在精神病院学斩神', '我不是戏神', '诡舍', '异兽迷城'];
  var hist = LS.get('fq_hist', []);
  function pushHist(kw) {
    if (!kw) return;
    hist = [kw].concat(hist.filter(function (x) { return x !== kw; })).slice(0, 8);
    LS.set('fq_hist', hist);
  }
  function chip(w) { return '<button class="kw" data-w="' + esc(w) + '">' + esc(w) + '</button>'; }
  function renderHot() {
    var h = $('#hot');
    var resultBox = $('#searchResults');
    if (resultBox && resultBox.childElementCount) { h.innerHTML = ''; return; }
    var html = '';
    if (hist.length) {
      html += '<div class="lab">最近搜索<button class="kw" data-clear="1" style="float:right;padding:3px 10px;font-size:11px">清空</button></div>';
      html += hist.map(chip).join('');
    }
    html += '<div class="lab" style="margin-top:6px">热门</div>' + hotWords.map(chip).join('');
    h.innerHTML = html;
  }
  $('#hot').addEventListener('click', function (e) {
    var b = e.target.closest('.kw'); if (!b) return;
    haptic(8);
    if (b.dataset.clear) { hist = []; LS.set('fq_hist', hist); renderHot(); return; }
    $('#q').value = b.dataset.w; doSearch();
  });

  function skeleton(n) {
    return Array(n || 4).fill('<div class="sk"></div>').join('');
  }

  function doSearch() {
    var kw = $('#q').value.trim();
    if (!kw) { toast('先输入书名或作者'); return; }
    state.lastQuery = kw;
    pushHist(kw);
    $('#hot').innerHTML = '';
    var box = $('#searchResults');
    box.innerHTML = skeleton(4);
    if (A && A.toast) A.toast('');
    FQ.search(kw, 0).then(function (books) {
      state.results = books;
      if (!books.length) {
        box.innerHTML = emptyBox('没搜到相关书籍', '换个关键词试试，比如书名的一部分');
        return;
      }
      box.innerHTML = books.map(cardHtml).join('');
      bindCards(box);
    }).catch(function (e) {
      box.innerHTML = emptyBox('搜索失败', esc(errMsg(e)));
    });
  }

  function errMsg(e) {
    var m = String(e && e.message || e);
    if (/HTTP 0|不可用|Failed|timeout/i.test(m)) return '网络连接失败，检查一下网络再试';
    return m;
  }

  function coverHtml(book) {
    var c = book.cover && /^https?:/.test(book.cover) ? book.cover.replace(/^http:/, 'https:') : '';
    if (c) return '<img class="cover" loading="lazy" src="' + esc(c) + '" onerror="this.outerHTML=\'<div class=&quot;cover ph&quot;>番</div>\'">';
    return '<div class="cover ph">番</div>';
  }

  function jobFor(id) {
    for (var i = 0; i < state.jobs.length; i++) {
      var j = state.jobs[i];
      if (j.id === String(id) && (j.status === 'run' || j.status === 'wait')) return j;
    }
    return null;
  }
  function dlFor(id) {
    for (var i = 0; i < state.dls.length; i++) if (String(state.dls[i].id) === String(id)) return state.dls[i];
    return null;
  }
  function cardHtml(b) {
    var j = jobFor(b.id), d = dlFor(b.id);
    var pill = j ? '<span class="pill warn">' + (j.status === 'wait' ? '排队中' : (j.pct || 0) + '%') + '</span>'
      : d ? '<span class="pill ok">已下载</span>' : '';
    var bar = j ? '<div class="cardbar"><i style="width:' + (j.pct || 0) + '%"></i></div>' : '';
    return '<div class="card" data-id="' + esc(b.id) + '">' +
      coverHtml(b) +
      '<div class="cbody">' +
      '<h3 class="ctitle">' + esc(b.name) + '</h3>' +
      '<div class="cmeta">' +
      (b.author ? '<b>' + esc(b.author) + '</b>' : '') +
      (b.category ? '<span class="pill">' + esc(b.category) + '</span>' : '') +
      (b.finished ? '<span class="pill ok">完结</span>' : '<span class="pill hot">连载</span>') +
      (b.words ? '<span>' + fmtNum(b.words) + '字</span>' : '') +
      pill +
      '</div>' +
      '<div class="cmeta" style="margin-top:4px"><span class="cid">ID ' + esc(b.id) + '</span></div>' +
      bar +
      '<div class="cfoot"><div class="spacer"></div>' +
      '<button class="btn mini" data-act="dl">' + (d ? '重新下载' : '下载 TXT') + '</button></div>' +
      '</div></div>';
  }

  // 只更新进度条，不整页重绘
  function syncProgress() {
    state.jobs.forEach(function (j) {
      if (j.status !== 'run' && j.status !== 'wait') return;
      var els = $$('.card[data-id="' + j.id + '"]');
      els.forEach(function (el) {
        var bar = el.querySelector('.cardbar i');
        if (bar && bar.style) bar.style.width = (j.pct || 0) + '%';
      });
    });
  }

  function bindCards(root) {
    var pressTimer = null, pressed = false;
    root.addEventListener('pointerdown', function (e) {
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (!card) return;
      pressed = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        pressed = true; haptic(18);
        var id = card.dataset.id;
        if (A && A.copy) { A.copy(String(id)); toast('bookId 已复制：' + id); }
        else toast(String(id));
      }, 550);
    });
    root.addEventListener('pointerup', function () { clearTimeout(pressTimer); });
    root.addEventListener('pointercancel', function () { clearTimeout(pressTimer); });
    root.addEventListener('click', function (e) {
      if (pressed) { pressed = false; return; }
      var btn = e.target.closest('[data-act="dl"]');
      var card = e.target.closest('.card');
      if (!card) return;
      var id = card.dataset.id;
      var b = findBook(id) || { id: id, name: id };
      if (btn) { e.stopPropagation(); quickDownload(b); return; }
      openDetail(id);
    });
  }
  function findBook(id) {
    var all = state.results.concat(state.rankBooks || []);
    for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(id)) return all[i];
    return null;
  }

  function emptyBox(t, p) {
    return '<div class="empty"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5A2.5 2.5 0 016.5 3H19v18H6.5A2.5 2.5 0 014 18.5z"/><path d="M4 17.5h15"/></svg><h4>' + t + '</h4><p>' + (p || '') + '</p></div>';
  }

  /* ---------------- 详情 ---------------- */
  var sheetBusy = false;
  function openDetail(id) {
    if (sheetBusy) return;
    haptic(8);
    sheetBusy = true;
    var body = $('#sheetBody');
    body.innerHTML = '<div style="padding:24px 0;text-align:center;color:var(--muted)">加载详情…</div>';
    showSheet(true);
    FQ.bookDetail(id).then(function (b) {
      body.innerHTML =
        '<div class="dhead">' + coverHtml(b) +
        '<div style="flex:1;min-width:0"><h3>' + esc(b.name) + '</h3>' +
        '<div class="cmeta" style="margin-bottom:6px">' + (b.author ? '<b>' + esc(b.author) + '</b>' : '') +
        (b.finished ? '<span class="pill ok">完结</span>' : '<span class="pill hot">连载</span>') + '</div>' +
        '<div class="cid">ID ' + esc(b.id) + '</div>' +
        (b.readInfo ? '<div class="cmeta" style="margin-top:6px">' + esc(b.readInfo) + '</div>' : '') +
        '</div></div>' +
        '<div class="dstats">' +
        '<div class="dstat"><b>' + (b.words ? fmtNum(b.words) : '—') + '</b><span>字数</span></div>' +
        '<div class="dstat"><b>' + (b.category || '—') + '</b><span>分类</span></div>' +
        '<div class="dstat"><b>' + (b.finished ? '完结' : '连载中') + '</b><span>状态</span></div>' +
        '</div>' +
        (b.tags && b.tags.length ? '<div class="dtags">' + b.tags.map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        '<p class="dabs">' + esc(b.abstract || '暂无简介') + '</p>' +
        '<div class="dact">' +
        '<button class="btn" data-dl="' + esc(b.id) + '">下载整本 TXT</button>' +
        '<button class="btn ghost" data-copy="' + esc(b.id) + '">复制 ID</button>' +
        '</div>';
      body.querySelector('[data-dl]').addEventListener('click', function () {
        showSheet(false); quickDownload(b);
      });
      body.querySelector('[data-copy]').addEventListener('click', function () {
        if (A && A.copy) { A.copy(String(b.id)); toast('bookId 已复制'); }
        else toast(String(b.id));
      });
    }).catch(function (e) {
      body.innerHTML = emptyBox('详情加载失败', esc(errMsg(e)));
    }).then(function () { sheetBusy = false; });
  }

  function showSheet(on) {
    $('#mask').classList.toggle('on', on);
    $('#sheet').classList.toggle('on', on);
    if (A && A.setSheet) { try { A.setSheet(!!on); } catch (e) { } }
  }
  $('#mask').addEventListener('click', function () { showSheet(false); });

  /* ---------------- 榜单 ---------------- */
  var rankCache = {};
  function loadRank() {
    var g = state.rankGender, key = 'g' + g;
    if (rankCache[key]) { renderRank(rankCache[key]); return; }
    var box = $('#rankList');
    box.innerHTML = skeleton(5);
    FQ.rank(g, 1).then(function (items) {
      state.rankBooks = items;
      renderRank(items);
      rankCache[key] = items;
      // 榜单里的书名被字体混淆，逐本补真名（并发 4）
      var i = 0;
      function worker() {
        if (i >= items.length) return Promise.resolve();
        var it = items[i++];
        return FQ.bookDetail(it.id).then(function (d) {
          it.name = d.name; it.author = d.author; it.cover = d.cover;
          it.words = d.words; it.finished = d.finished; it.category = d.category;
          renderRank(items);
        }).catch(function () { }).then(function () { return worker(); });
      }
      return Promise.all([worker(), worker(), worker(), worker()]);
    }).catch(function (e) {
      box.innerHTML = emptyBox('榜单加载失败', esc(errMsg(e)));
    });
  }
  function renderRank(items) {
    var box = $('#rankList');
    if (!items.length) { box.innerHTML = emptyBox('榜单为空', '稍后再试'); return; }
    box.innerHTML = items.map(function (b, i) {
      var rank = i + 1;
      var badge = rank <= 3 ? '<span class="pill hot">NO.' + rank + '</span>' : '<span class="pill">' + rank + '</span>';
      return '<div class="card" data-id="' + esc(b.id) + '">' + coverHtml(b) +
        '<div class="cbody"><h3 class="ctitle">' + esc(b.name || '加载中…') + '</h3>' +
        '<div class="cmeta">' + badge + (b.author ? '<b>' + esc(b.author) + '</b>' : '') +
        (b.category ? '<span class="pill">' + esc(b.category) + '</span>' : '') +
        (b.words ? '<span>' + fmtNum(b.words) + '字</span>' : '') + '</div>' +
        '<div class="cmeta" style="margin-top:4px"><span class="cid">ID ' + esc(b.id) + '</span></div>' +
        '<div class="cfoot"><div class="spacer"></div><button class="btn mini" data-act="dl">下载 TXT</button></div>' +
        '</div></div>';
    }).join('');
    bindCards(box);
  }

  /* ---------------- 下载 ---------------- */
  var running = false, queue = [], currentJob = null;

  function quickDownload(book, from, to) {
    haptic(12);
    var exist = state.jobs.filter(function (j) { return j.id === String(book.id) && (j.status === 'run' || j.status === 'wait'); })[0];
    if (exist) { switchView('dl'); toast('这本已经在队列里了'); return; }
    var job = {
      id: String(book.id), name: book.name || String(book.id), cover: book.cover || '',
      status: 'wait', done: 0, total: 0, pct: 0, path: '', size: 0, err: '',
      rangeFrom: Number(from) || 0, rangeTo: Number(to) || 0
    };
    state.jobs.unshift(job);
    queue.push(job);
    switchView('dl');
    renderDownloads();
    toast('已加入下载队列');
    pump();
  }

  function pump() {
    if (running) return;
    var job = queue.shift();
    if (!job) return;
    running = true;
    currentJob = job;
    job.status = 'run';
    try { if (A && A.fgStart) A.fgStart(job.name); } catch (e0) { }
    try { if (A && A.keepAwake) A.keepAwake(true); } catch (e) { }
    runJob(job).catch(function (e) {
      job.status = 'err';
      job.err = errMsg(e);
    }).then(function () {
      try { if (A && A.notifyClear) A.notifyClear(); } catch (e6) { }
      running = false;
      currentJob = null;
      try { if (A && A.fgStop) A.fgStop(); } catch (e8) { }
      saveJobs();
      try { if (A && A.keepAwake) A.keepAwake(false); } catch (e) { }
      renderDownloads();
      syncProgress();
      pump();
    });
  }

  function fmtNum(n) {
    var s = String(Math.round(Number(n) || 0)), out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) { out = s[i] + out; if (++c % 3 === 0 && i > 0) out = ',' + out; }
    return out;
  }

  function buildHead(job, meta, count) {
    var name = (meta && meta.name) || job.name || '';
    var lines = ['《' + name + '》'];
    if (meta) {
      if (meta.author) lines.push('作者：' + meta.author);
      if (meta.categories && meta.categories.length) lines.push('分类：' + meta.categories.join(' / '));
      lines.push('状态：' + (meta.finished ? '完结' : '连载中'));
      if (meta.words) lines.push('字数：' + fmtNum(meta.words) + ' 字');
    }
    lines.push('bookId：' + job.id);
    lines.push('共 ' + count + ' 章');
    return lines.join('\n') + '\n\n\n\n';
  }

  async function runJob(job) {
    job.phase = '获取目录';
    job.step = '正在获取目录…';
    renderDownloads();
    var dir = await FQ.directory(job.id);
    var chs = dir.chapters;
    if (!chs || !chs.length) throw new Error('目录为空');
    if (job.rangeTo) {
      var rf = Math.max(0, Number(job.rangeFrom) || 0);
      var rt = Math.min(chs.length, Number(job.rangeTo) || chs.length);
      if (rt > rf) chs = chs.slice(rf, rt);
    }
    if (!chs.length) throw new Error('所选范围没有章节');
    // 作者/分类/字数等元数据：取 /page 页的 __INITIAL_STATE__.page，失败不影响下载
    var meta = null;
    try {
      job.phase = '获取书籍信息';
      renderDownloads();
      syncProgress();
      meta = await FQ.bookMeta(job.id);
      if (meta && meta.name) job.name = meta.name;
    } catch (e) { meta = null; }
    job.total = chs.length;
    job.done = 0;
    job.phase = '下载中';
    job.step = '目录共 ' + chs.length + ' 章，准备开下';
    renderDownloads();

    var dev = await FQ.ensureDevice();
    var key = await FQ.getV1Key(dev);
    var backoff = [1500, 3500, 7000, 15000, 30000, 45000];
    var CONC = Math.max(1, Math.min(3, Number(LS.get('fq_conc', 1)) || 1));
    var streaming = !!(A && A.saveStart && A.saveAppend && A.saveEnd);
    var safe = String(job.name).replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
    var fname = safe + '.txt';
    var head = buildHead(job, meta, chs.length);
    var totalBytes = 0;
    var parts = [];
    var resuming = false;

    function pushText(str) {
      if (!str) return;
      if (streaming) {
        var bytes = new TextEncoder().encode(str);
        totalBytes += bytes.length;
        var CH = 192 * 1024;
        for (var q = 0; q < bytes.length; q += CH) {
          A.saveAppend(u8ToB64(bytes.subarray(q, q + CH)));
        }
      } else {
        parts.push(str);
        totalBytes += new TextEncoder().encode(str).length;
      }
    }

    if (!job.saveRef) job.resumeFrom = 0;
    if (streaming) {
      if (job.resumeFrom && job.saveRef && A.saveResume) {
        var rr = A.saveResume(job.saveRef);
        if (rr && String(rr).indexOf('ERR') !== 0) resuming = true;
      }
      if (!resuming) {
        var tok = A.saveStart(fname);
        if (!tok || String(tok).indexOf('ERR') === 0) {
          streaming = false;
        } else {
          var tk = String(tok);
          job.saveRef = tk.indexOf('|') > 0 ? tk.split('|')[1] : '';
          job.written = 0;
          job.resumeFrom = 0;
        }
      }
    }
    if (!resuming) pushText(head);

    var pendingTexts = {}, flushAt = 0;
    function flushReady() {
      while (Object.prototype.hasOwnProperty.call(pendingTexts, flushAt)) {
        var s2 = pendingTexts[flushAt];
        delete pendingTexts[flushAt];
        pushText(s2);
        flushAt += BATCH;
        job.written = Math.min(chs.length, flushAt);
        saveJobs();
      }
    }

    async function waitIfPaused() {
      while (job.paused) {
        if (job.cancel) throw new Error('已取消');
        await sleep(400);
      }
    }

    async function fetchBatch(batchIds) {
      var lastErr = null;
      for (var t = 0; t < 6; t++) {
        await waitIfPaused();
        try {
          job.phase = t === 0 ? '下载中' : ('网络重试 ' + t + '/6');
          if (t > 0) {
            job.step = '网络重试 ' + t + '/6 · 等 ' + Math.round(backoff[t - 1] / 1000) + ' 秒后再试';
            renderDownloads();
          }
          await pace();
          return await FQ.batchFull(dev, job.id, batchIds, key);
        } catch (e) {
          lastErr = e;
          if (/registerkey|code=|v1|解密|密文/.test(String(e.message))) {
            try { key = await FQ.getV1Key(dev, true); } catch (e2) { }
          }
          if (t === 5) break;
          await sleep(backoff[t]);
        }
      }
      throw lastErr || new Error('下载失败');
    }

    async function doBatch(i) {
      var ids = chs.slice(i, i + BATCH).map(function (c) { return String(c.itemId); });
      var batchNo = Math.floor(i / BATCH) + 1;
      var batchAll = Math.ceil(chs.length / BATCH);
      job.step = '正在下载第 ' + (i + 1) + '–' + (i + ids.length) + ' 章（第 ' + batchNo + '/' + batchAll + ' 批）';
      renderDownloads();
      var res = await fetchBatch(ids);
      var need = ids.filter(function (id) { var c = res[id]; return !c || !c.text || !String(c.text).trim(); });
      for (var rt = 0; rt < 3 && need.length; rt++) {
        job.phase = '补取空章';
        job.step = '有 ' + need.length + ' 章正文是空的（被限流），第 ' + (rt + 1) + ' 轮补取，先等 '
                  + (2.5 + rt * 4) + ' 秒';
        renderDownloads();
        await sleep(2500 + rt * 4000);
        var more = await fetchBatch(need);
        for (var m = 0; m < need.length; m++) {
          var mc = more[need[m]];
          if (mc && mc.text && String(mc.text).trim()) res[need[m]] = mc;
        }
        need = need.filter(function (id) { var c = res[id]; return !c || !c.text || !String(c.text).trim(); });
      }
      if (need.length) throw new Error('有 ' + need.length + ' 章正文为空（大概率被限流），过几分钟重试即可');
      var block = '';
      for (var k = 0; k < ids.length; k++) {
        var c = res[ids[k]];
        var ttl = (c && c.title) || chs[i + k].title || '';
        var txt = (c && c.text) || '';
        block += ttl + '\n\n' + txt + '\n\n\n';
      }
      job.done = Math.min(chs.length, job.done + ids.length);
      job.pct = Math.round(job.done / chs.length * 100);
      if (!job.t0) job.t0 = Date.now();
      job.elapsed = (Date.now() - job.t0) / 1000;
      job.speed = job.elapsed > 0.5 ? job.done / job.elapsed : 0;
      if (A && A.notifyProgress) {
        var nt = Date.now();
        if (!job.lastNt || nt - job.lastNt > 2000) {
          job.lastNt = nt;
          try {
            A.notifyProgress('《' + job.name + '》' + job.pct + '%',
              job.done + ' / ' + job.total + ' 章' + (job.speed > 0 ? ' · ' + job.speed.toFixed(1) + ' 章/秒' : ''),
              job.pct);
          } catch (e5) { }
        }
      }
      pendingTexts[i] = block;
      flushReady();
      renderDownloads();
      syncProgress();
    }

    var cursor = resuming ? Math.min(chs.length, job.resumeFrom || 0) : 0;
    job.done = cursor;
    job.pct = chs.length ? Math.round(cursor / chs.length * 100) : 0;
    async function worker() {
      while (true) {
        if (job.cancel) throw new Error('已取消');
        await waitIfPaused();
        var i = cursor;
        if (i >= chs.length) return;
        cursor += BATCH;
        await doBatch(i);
      }
    }
    var ws = [];
    for (var w = 0; w < CONC; w++) ws.push(worker());
    try {
      await Promise.all(ws);
    } catch (e) {
      if (streaming && A && A.saveAbort) { try { A.saveAbort(); } catch (e4) { } }
      throw e;
    }

    job.phase = '写入文件';
    job.step = streaming ? '正在把剩余内容落盘…' : '正在编码并写入文件…';
    renderDownloads();
    var r;
    if (streaming) {
      var out = A.saveEnd();
      if (!out || String(out).indexOf('ERR') === 0) {
        throw new Error('写入失败：' + (String(out || 'saveEnd 返回空').replace(/^ERR:/, '')));
      }
      r = { path: out, size: totalBytes };
    } else {
      r = await saveText(fname, parts.join(''));
    }
    job.status = 'ok';
    job.written = 0;
    job.resumeFrom = 0;
    job.resumable = false;
    if (!job.up) job.up = 'wait';
    if (job.saveRef && job.up !== 'ok') upsAdd(job.name, job.saveRef);
    saveJobs();
    job.step = '完成 · ' + chs.length + ' 章 · ' + fmtSize(r.size || 0) + ' · 用时 ' + fmtDur(job.elapsed || 0);
    job.pct = 100;
    job.path = r.path;
    job.size = r.size;
    job.phase = '完成';
    var rec = { id: job.id, name: job.name, path: r.path, size: r.size, chapters: chs.length, time: Date.now() };
    state.dls = [rec].concat(state.dls.filter(function (x) { return x.id !== job.id; })).slice(0, 80);
    LS.set('fq_dls', state.dls);
    if (A && A.notify) A.notify('下载完成：' + job.name, chs.length + ' 章 · ' + fmtSize(r.size));
    toast('《' + job.name + '》下载完成');
  }

  var dlSig = '', dlBuilt = false, dlRefs = {};

  function setText(el, v) {
    if (el && el.textContent !== v) el.textContent = v;
  }

  function dlSignature() {
    var pend = state.jobs.length ? upsPending().filter(function (x) { return x.up !== 'run'; }).length : 0;
    return state.jobs.map(function (j) { return j.id + ':' + j.status + ':' + (j.up || ''); }).join(',')
      + '|' + state.dls.map(function (d) { return d.id + ':' + (d.up || ''); }).join(',')
      + '|' + pend;
  }

  function buildDlList() {
    var box = $('#dlList');
    var html = '';
    if (state.jobs.length) {
      var pend = upsPending().filter(function (x) { return x.up !== 'run'; }).length;
      if (pend > 0) {
        html += '<div style="display:flex;align-items:center;gap:8px;padding:4px 2px 8px">'
              + '<span style="font-size:12px;color:var(--muted);flex:1">有 ' + pend + ' 本还没上传到书库</span>'
              + '<button class="btn mini" id="upAllBtn">一键上传</button></div>';
      }
      html += '<div class="lab" style="font-size:12px;color:var(--muted);padding:2px 2px 4px">进行中 / 排队</div>';
      html += state.jobs.map(function (j) {
        var bar = j.status === 'ok' ? ' ok' : '';
        return '<div class="card" data-jid="' + esc(j.id) + '" style="flex-direction:column;align-items:stretch;gap:0">' +
          '<div class="cbody">' +
          '<div style="display:flex;align-items:center;gap:8px">' +
          '<h3 class="ctitle" style="margin:0;flex:1">' + esc(j.name) + '</h3>' +
          '<span class="pill stpill ' + (j.status === 'ok' ? 'ok' : j.status === 'err' ? 'hot' : '') + '">' +
          (j.status === 'wait' ? '排队' : j.status === 'run' ? (j.phase || '下载中') : j.status === 'pause' ? '已暂停' : j.status === 'ok' ? '完成' : '失败') + '</span></div>' +
          '<div class="prog"><div class="bar' + bar + '"><i style="width:' + (j.pct || 0) + '%"></i></div>' +
          '<div class="ptxt pt1"><span>' + (j.total ? j.done + ' / ' + j.total + ' 章' : '准备中…') + '</span>' +
          '<span>' + (j.status === 'ok' ? fmtSize(j.size) : (j.pct || 0) + '%') + '</span></div>' +
          '<div class="ptxt pt2"' + (j.status === 'run' && j.speed > 0 ? '' : ' style="display:none"') + '><span></span><span></span></div></div>' +
          '<div class="jbox">' + esc(j.step || j.phase || '准备中…') + '</div>' +
          (j.status === 'err' ? '<div class="cmeta" style="color:#FF8B9B;margin-top:6px">' + esc(j.err) + '</div>' : '') +
          '<div class="cfoot">' +
          (j.status === 'ok' ? '<span class="cid" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(j.path || '') + '</span>' : '<div class="spacer"></div>') +
          (j.status === 'ok'
            ? (j.up === 'ok'
                ? '<span class="pill ok" style="margin-right:4px">\u2713 已入库</span>'
                : '<button class="btn mini" data-up="' + esc(j.id) + '"' + (j.up === 'run' ? ' disabled' : '') + '>'
                  + (j.up === 'run' ? '上传中…' : '上传到书库') + '</button>')
            : '') +
          (j.status === 'run'
            ? '<button class="btn ghost mini" data-pause="' + esc(j.id) + '">暂停</button>'
              + '<button class="btn ghost mini" data-cancel="' + esc(j.id) + '">取消</button>'
            : j.status === 'pause'
              ? '<button class="btn ' + 'mini" data-resume="' + esc(j.id) + '">继续</button>'
                + '<button class="btn ghost mini" data-cancel="' + esc(j.id) + '">取消</button>'
              : j.status === 'wait'
                ? '<button class="btn ghost mini" data-cancel="' + esc(j.id) + '">取消</button>'
                : j.status === 'err'
                  ? '<button class="btn mini" data-retry="' + esc(j.id) + '">重试</button>'
                    + '<button class="btn ghost mini" data-remove="' + esc(j.id) + '">移除</button>'
                  : '<button class="btn ghost mini" data-remove="' + esc(j.id) + '">移除</button>') +
          '</div></div></div>';
      }).join('');
    }
    if (state.dls.length) {
      html += '<div class="lab" style="font-size:12px;color:var(--muted);padding:14px 2px 4px">已下载（' + state.dls.length + '）</div>';
      html += state.dls.map(function (d) {
        return '<div class="card"><div class="cbody">' +
          '<h3 class="ctitle" style="margin:0 0 3px">' + esc(d.name) + '</h3>' +
          '<div class="cmeta"><span class="pill ok">' + d.chapters + ' 章</span><span>' + fmtSize(d.size) + '</span>' +
          '<span>' + new Date(d.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</span></div>' +
          '<div class="cmeta" style="margin-top:5px"><span class="cid" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(d.path) + '</span></div>' +
          '<div class="cfoot"><div class="spacer"></div>' +
          (d.up === 'ok'
            ? '<span class="pill ok" style="margin-right:4px">\u2713 已入库</span>'
            : '<button class="btn mini" data-upname="' + esc(d.name) + '"' + (d.up === 'run' ? ' disabled' : '') + '>'
              + (d.up === 'run' ? '上传中…' : '上传到书库') + '</button>') +
          '<button class="btn ghost mini" data-copy="' + esc(d.id) + '">复制 ID</button></div>' +
          '</div></div>';
      }).join('');
    }
    if (!html) html = emptyBox('还没有下载任务', '去搜索或榜单里挑一本，点「下载 TXT」');
    box.innerHTML = html;
    dlRefs = {};
    state.jobs.forEach(function (j) {
      var el = box.querySelector('[data-jid="' + j.id + '"]');
      if (!el) return;
      dlRefs[j.id] = {
        bar: el.querySelector('.bar > i'),
        p1a: el.querySelector('.pt1 span:nth-of-type(1)'),
        p1b: el.querySelector('.pt1 span:nth-of-type(2)'),
        p2: el.querySelector('.pt2'),
        p2a: el.querySelector('.pt2 span:nth-of-type(1)'),
        p2b: el.querySelector('.pt2 span:nth-of-type(2)'),
        jbox: el.querySelector('.jbox')
      };
    });
    dlBuilt = true;
  }

  function patchDlList() {
    for (var i = 0; i < state.jobs.length; i++) {
      var j = state.jobs[i], r = dlRefs[j.id];
      if (!r) continue;
      var pct = Math.max(0, Math.min(100, j.pct || 0));
      var w = pct + '%';
      if (r.bar && r.bar.style.width !== w) r.bar.style.width = w;
      var l1 = j.total ? (j.done + ' / ' + j.total + ' 章') : '准备中…';
      if (j.status === 'run' && j.speed > 0) l1 += ' · ' + j.speed.toFixed(1) + ' 章/秒';
      setText(r.p1a, l1);
      setText(r.p1b, j.status === 'ok' ? fmtSize(j.size) : pct + '%');
      var running = (j.status === 'run' && j.speed > 0);
      if (r.p2) {
        var disp = running ? '' : 'none';
        if (r.p2.style.display !== disp) r.p2.style.display = disp;
      }
      if (running) {
        setText(r.p2a, '已用 ' + fmtDur(j.elapsed));
        setText(r.p2b, '剩约 ' + fmtDur((j.total - j.done) / j.speed));
      }
      setText(r.jbox, j.step || j.phase || '准备中…');
    }
  }

  function renderDownloads() {
    var box = $('#dlList');
    if (!box) return;
    var sig = dlSignature();
    if (!dlBuilt || sig !== dlSig) {
      dlSig = sig;
      buildDlList();
    } else {
      patchDlList();
    }
  }

  setInterval(function () {
    if (document.hidden) return;
    for (var i = 0; i < state.jobs.length; i++) {
      if (state.jobs[i].status === 'run') { renderDownloads(); return; }
    }
  }, 1000);

  (function () {
    var btn = $('#concBtn');
    function paint() {
      var c = Math.max(1, Math.min(3, Number(LS.get('fq_conc', 1)) || 1));
      if (btn) btn.textContent = '并发 ' + c;
    }
    if (btn) btn.addEventListener('click', function () {
      var c = Math.max(1, Math.min(3, Number(LS.get('fq_conc', 1)) || 1));
      c = c >= 2 ? 1 : c + 1;
      LS.set('fq_conc', c);
      paint();
      toast(c === 1 ? '单路下载（最稳）' : ('并发 ' + c + ' 路，速度更快但更容易被限流'));
    });
    paint();
  })();

  $('#dlList').addEventListener('click', function (e) {
    var pz = e.target.closest('[data-pause]');
    if (pz) {
      var pid = pz.dataset.pause;
      state.jobs.forEach(function (j) {
        if (j.id === pid && j.status === 'run') {
          j.paused = true; j.status = 'pause'; j.phase = '已暂停';
          try { if (A && A.notifyProgress) A.notifyProgress('《' + j.name + '》已暂停', j.done + ' / ' + j.total + ' 章，点「继续」接着下', j.pct || 0); } catch (e7) { }
        }
      });
      renderDownloads();
      toast('已暂停，点「继续」接着下');
      return;
    }
    var rs = e.target.closest('[data-resume]');
    if (rs) {
      var rid = rs.dataset.resume, jo = null;
      state.jobs.forEach(function (j) { if (j.id === rid) jo = j; });
      if (!jo) return;
      jo.paused = false; jo.cancel = false;
      if (jo === currentJob) {
        jo.status = 'run'; jo.phase = '下载中'; jo.step = '继续下载…';
        renderDownloads();
      } else {
        jo.status = 'wait'; jo.phase = '排队';
        jo.step = jo.resumeFrom ? ('排队中，将从第 ' + (jo.resumeFrom + 1) + ' 章接着下') : '排队中';
        queue.push(jo); saveJobs(); renderDownloads(); pump();
        toast('已加入队列');
      }
      return;
    }
    var rt = e.target.closest('[data-retry]');
    if (rt) {
      var tid = rt.dataset.retry;
      state.jobs.forEach(function (j) {
        if (j.id !== tid) return;
        j.status = 'wait'; j.err = ''; j.paused = false; j.cancel = false;
        j.done = 0; j.pct = 0; j.speed = 0; j.elapsed = 0; j.t0 = 0;
        j.written = 0; j.resumeFrom = 0; j.saveRef = ''; j.sheetDone = 0;
        j.phase = '排队'; j.step = '排队中，马上重新下';
        queue.push(j);
      });
      saveJobs(); renderDownloads(); toast('重新排队了'); pump();
      return;
    }
    var c = e.target.closest('[data-cancel]');
    if (c) {
      var id = c.dataset.cancel;
      state.jobs.forEach(function (j) { if (j.id === id && (j.status === 'run' || j.status === 'pause')) { j.cancel = true; j.paused = false; j.phase = '取消中'; } });
      queue = queue.filter(function (j) { if (j.id === id) { j.status = 'err'; j.err = '已取消'; } return j.id !== id; });
      saveJobs();
      renderDownloads();
      syncProgress();
      return;
    }
    var r = e.target.closest('[data-remove]');
    if (r) {
      state.jobs = state.jobs.filter(function (j) { return j.id !== r.dataset.remove; });
      saveJobs();
      renderDownloads();
      syncProgress();
      return;
    }
    var up = e.target.closest('[data-up]');
    if (up) {
      var uid = up.dataset.up, uj = null;
      state.jobs.forEach(function (j) { if (j.id === uid) uj = j; });
      if (uj) upsOne(uj.name, uj.saveRef);
      return;
    }
    var upAll = e.target.closest('#upAllBtn');
    if (upAll) { upsAll(); return; }
    var upn = e.target.closest('[data-upname]');
    if (upn) {
      var un = upn.dataset.upname;
      if (!(A && A.uploadByName)) { toast('这个版本不支持'); return; }
      var rr = A.uploadByName(un);
      if (rr && String(rr).indexOf('ERR') === 0) { toast(String(rr).slice(4)); return; }
      state.dls.forEach(function (d) { if (d.name === un) d.up = 'run'; });
      renderDownloads();
      toast('开始上传《' + un + '》');
      return;
    }
    var cp = e.target.closest('[data-copy]');
    if (cp) { if (A && A.copy) { A.copy(cp.dataset.copy); toast('已复制'); } }
  });

  /* ---------------- 搜索事件 ---------------- */
  $('#q').addEventListener('input', function () {
    $('#clearQ').hidden = !this.value;
    renderHot();
  });
  $('#q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { this.blur(); doSearch(); } });
  $('#clearQ').addEventListener('click', function () {
    $('#q').value = ''; $('#clearQ').hidden = true; $('#searchResults').innerHTML = ''; renderHot(); $('#q').focus();
  });

  /* ---------------- 顶栏按钮 / 打开目录 ---------------- */
  var tb = $('#themeBtn');
  if (tb) tb.addEventListener('click', toggleTheme);
  var od = $('#openDir');
  if (od) od.addEventListener('click', function () {
    haptic(10);
    if (A && A.openDownloads) { try { A.openDownloads(); return; } catch (e) { } }
    toast('预览模式没有下载目录');
  });

  /* ---------------- 启动 ---------------- */
  function boot() {
    var th = LS.get('fq_theme', null);
    if (!th) {
      try { th = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'theme-light' : 'theme-dark'; }
      catch (e) { th = 'theme-dark'; }
    }
    applyTheme(th);
    renderHot();
    restoreJobs();
    switchView('search');
    $('#statusLine').textContent = A ? '就绪 · 番茄 App 协议' : '预览模式（无 Android 桥）';
    FQ.ensureDevice().then(function (d) {
      $('#statusLine').textContent = '就绪 · 设备已注册';
    }).catch(function (e) {
      $('#statusLine').textContent = '设备注册失败：' + errMsg(e);
    });
  }
  // 调试/自动化钩子（不暴露任何内部状态给网络，仅同页面可用）
  window.FQApp = { download: quickDownload, state: state, net: net, saveText: saveText };
  window.fqRangeLast = function (id, name, n) {
    var cnt = Number(n) || 50;
    (async function () {
      try {
        var dir = await FQ.directory(String(id));
        var total = (dir.chapters || []).length;
        quickDownload({ id: String(id), name: name || String(id) },
          Math.max(0, total - cnt), total);
      } catch (e) {
        toast('取目录失败：' + ((e && e.message) || e));
      }
    })();
    return 'ok';
  };
  window.fqUp = function (name, pct) {
    name = String(name || '').replace(/\.txt$/, '');
    for (var i = 0; i < state.jobs.length; i++) {
      var j = state.jobs[i];
      if (j.name !== name) continue;
      j.up = 'run';
      j.step = (pct >= 100) ? '\\u2713 已上传到书库' : ('正在上传到书库… ' + pct + '%');
      renderDownloads();
      return 'ok';
    }
    return 'no';
  };
  window.fqRange = function (id, name, from, to) {
    try { quickDownload({ id: String(id), name: name || String(id) }, from, to); return 'ok'; }
    catch (e) { return 'err:' + e.message; }
  };
  if (A && A.ready) { try { A.ready(); } catch (e) { } }
  boot();
})();

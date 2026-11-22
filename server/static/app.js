/* 我的书库 · 前端交互（零依赖） */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function toast(msg, bad) {
    const t = $("#toast");
    if (!t) return alert(msg);
    t.textContent = msg;
    t.style.color = bad ? "#ffb4b4" : "#fff";
    t.classList.add("on");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("on"), 2000);
  }
  window.toast = toast;

  /* 抽屉 */
  const navBtn = $("#btnNav");
  if (navBtn) navBtn.onclick = () => document.body.classList.toggle("navOpen");
  const scrim = $("#scrim");
  if (scrim) scrim.onclick = () => document.body.classList.remove("navOpen");

  /* 表格 / 卡片 视图 */
  const seg = $$(".seg a[data-mode]");
  if (seg.length) {
    const saved = localStorage.getItem("nm_mode") || (window.matchMedia("(max-width:899px)").matches ? "cards" : "table");
    apply(saved);
    seg.forEach(a => a.onclick = e => {
      e.preventDefault();
      apply(a.dataset.mode);
      localStorage.setItem("nm_mode", a.dataset.mode);
    });
  }
  function apply(mode) {
    const tbl = $("#scroll .tbl"), cards = $("#scroll .cards");
    if (!tbl || !cards) return;
    tbl.style.display = mode === "table" ? "" : "none";
    cards.style.display = mode === "table" ? "none" : "flex";
    seg.forEach(x => x.classList.toggle("on", x.dataset.mode === mode));
  }

  /* 阅读页：字号 / 行距 */
  const rbody = $("#rbody");
  if (rbody) {
    const bidKey = "nm_fs_" + (rbody.dataset.bid || "");
    const fsSaved = localStorage.getItem(bidKey) || localStorage.getItem("nm_fs3");
    const fs = +(fsSaved || 17);
    const lh = +(localStorage.getItem("nm_lh3") || 1.95);
    const setFs = v => { rbody.style.setProperty("--fs", v + "px"); localStorage.setItem("nm_fs3", v);
      if (rbody.dataset.bid) localStorage.setItem(bidKey, v);
      const e = $("#fsVal"); if (e) e.textContent = v; };
    const setLh = v => { rbody.style.setProperty("--lh", v); localStorage.setItem("nm_lh3", v); const e = $("#lhVal"); if (e) e.textContent = v; };
    setFs(fs); setLh(lh);

    const fsBtn = $("#fsBtn");
    if (fsBtn) fsBtn.onclick = e => { e.preventDefault(); document.body.classList.toggle("fsOpen"); };
    const fr = $("#fsRange"), lr = $("#lhRange");
    if (fr) { fr.value = fs; fr.oninput = e => setFs(+e.target.value); }
    if (lr) { lr.value = lh; lr.oninput = e => setLh(+e.target.value); }

    /* 背景 / 字体 */
    const curPaper = () => document.documentElement.dataset.paper || localStorage.getItem("nm_paper") || "p0";
    const curFf = () => document.documentElement.dataset.ff || localStorage.getItem("nm_ff") || "sans";
    const paintSkin = () => {
      $$(".pp").forEach(b => b.classList.toggle("on", b.dataset.paper === curPaper()));
      $$(".ff").forEach(b => b.classList.toggle("on", b.dataset.ff === curFf()));
    };
    $$(".pp").forEach(b => { b.onclick = () => {
      const v = b.dataset.paper;
      document.documentElement.dataset.paper = v;
      localStorage.setItem("nm_paper", v);
      paintSkin();
    }; });
    $$(".ff").forEach(b => { b.onclick = () => {
      const v = b.dataset.ff;
      document.documentElement.dataset.ff = v;
      localStorage.setItem("nm_ff", v);
      paintSkin();
    }; });
    paintSkin();


    /* 双击正文：隐藏/显示工具条 */
    rbody.addEventListener("dblclick", (e) => {
      if (String(getSelection() || "").trim()) return;
      document.body.classList.toggle("hideChrome");
    });
    /* 段落级阅读位置 */
    const bid = rbody.dataset.bid || "", cidx = rbody.dataset.idx || "";
    const para0 = +(rbody.dataset.para || 0), rs = +(rbody.dataset.rs || 0);
    const key = "nm_pos_" + location.pathname.replace(/\/read\//, "").replace(/\//g, "_");
    const goPara = i => {
      const ps = rbody.querySelectorAll(".para");
      if (!ps.length) return false;
      const el = ps[Math.min(Math.max(i, 0), ps.length - 1)];
      const top = el.getBoundingClientRect().top + window.scrollY - 76;
      window.scrollTo(0, Math.max(0, top));
      return true;
    };
    let restored = false;
    if (rs && para0 > 0) restored = goPara(para0);
    if (!restored) {
      const y = +(sessionStorage.getItem(key) || 0);
      if (y > 40) window.scrollTo(0, y);
    }
    const topPara = () => {
      const ps = rbody.querySelectorAll(".para");
      let best = 0;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].getBoundingClientRect().top <= 120) best = i; else break;
      }
      return best;
    };
    let t, t2;
    const sendPos = () => {
      if (!bid) return;
      try {
        fetch("/api/pos?book=" + encodeURIComponent(bid) + "&idx=" + encodeURIComponent(cidx)
              + "&para=" + topPara(), { method: "POST", keepalive: true }).catch(() => {});
      } catch (e) {}
    };
    window.addEventListener("scroll", () => {
      clearTimeout(t);
      t = setTimeout(() => sessionStorage.setItem(key, window.scrollY), 200);
      clearTimeout(t2);
      t2 = setTimeout(sendPos, 1200);
    }, { passive: true });
    window.addEventListener("pagehide", sendPos);
  }

  /* 管理密码记住在本机 */
  const keyEl0 = $("#key");
  if (keyEl0) {
    keyEl0.value = localStorage.getItem("nm_key") || "";
    keyEl0.addEventListener("input", () => localStorage.setItem("nm_key", keyEl0.value.trim()));
  }

  /* 快捷键 */
  document.addEventListener("keydown", e => {
    if (e.key === "/" && document.activeElement !== $(".search input")) {
      const q = $(".search input");
      if (q) { e.preventDefault(); q.focus(); q.select(); }
    }
    if (e.key === "Escape") document.body.classList.remove("navOpen", "fsOpen");
    if (rbody && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const a = $(e.key === "ArrowLeft" ? ".tz-l" : ".tz-r");
      const href = a && (a.dataset.href || a.getAttribute("href"));
      if (href && href !== "#") location.href = href;
    }
  });

  /* ---------- 主题 ---------- */
  const btnTheme = $("#btnTheme");
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("nm_theme", t);
  }
  if (btnTheme) btnTheme.onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

  /* ---------- 每页条数 ---------- */
  const perSel = $("#perPage");
  if (perSel) perSel.onchange = () => {
    const u = new URL(location.href);
    u.searchParams.set("per", perSel.value);
    u.searchParams.delete("p");
    location.href = u.toString();
  };

  /* ---------- 多选 / 批量 ---------- */
  const rows = $$(".ckRow");
  const bulk = $("#bulk");
  if (rows.length) {
    const sync = () => {
      const n = rows.filter(r => r.checked).length;
      if (bulk) bulk.classList.toggle("on", n > 0);
      const e = $("#bulkN");
      if (e) e.textContent = n;
      const all = $("#ckAll");
      if (all) all.checked = n === rows.length && n > 0;
    };
    rows.forEach(r => r.addEventListener("change", sync));
    const all = $("#ckAll");
    if (all) all.onchange = () => { rows.forEach(r => r.checked = all.checked); sync(); };
    const bt = $("#bulkTxt");
    if (bt) bt.onclick = e => {
      e.preventDefault();
      const ids = rows.filter(r => r.checked).map(r => r.value);
      if (!ids.length) return;
      if (ids.length === 1) { location.href = "/dl/" + ids[0]; return; }
      location.href = "/dl/txt?ids=" + encodeURIComponent(ids.join(","));
    };
    const bd = $("#bulkDl");
    if (bd) bd.onclick = e => {
      e.preventDefault();
      const ids = rows.filter(r => r.checked).map(r => r.value).join(",");
      if (ids) location.href = "/dl/all?ids=" + encodeURIComponent(ids);
    };
    const bn = $("#bulkNone");
    if (bn) bn.onclick = () => { rows.forEach(r => r.checked = false); sync(); };
    const bcat = $("#bulkCat");
    if (bcat) bcat.onclick = async () => {
      const ids = rows.filter(r => r.checked).map(r => r.value);
      if (!ids.length) return;
      const cat = (prompt("把这 " + ids.length + " 本改成哪个分类？\n（玄幻/奇幻/武侠/仙侠/都市/现实/历史/军事/科幻/悬疑/灵异/游戏/体育/二次元/短篇/现代言情/古代言情/幻情/仙侠奇缘/豪门总裁/青春校园/浪漫青春/种田/年代/快穿/综漫/娱乐圈/出版/文学/名著/传记/未分类）") || "").trim();
      if (!cat) return;
      let k = (localStorage.getItem("nm_key") || "").trim();
      if (!k) {
        k = (prompt("输入管理密码") || "").trim();
        if (!k) return;
        localStorage.setItem("nm_key", k);
      }
      bcat.disabled = true;
      try {
        const r = await fetch("/api/bulk?op=cat&cat=" + encodeURIComponent(cat)
          + "&key=" + encodeURIComponent(k) + "&ids=" + ids.join(","), { method: "POST" });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok) { location.reload(); return; }
        alert(r.status === 403 ? "密码不对" : (j.err || "操作失败"));
      } catch (e) { alert("网络错误"); }
      bcat.disabled = false;
    };
    const bdel = $("#bulkDel");
    if (bdel) bdel.onclick = async () => {
      const ids = rows.filter(r => r.checked).map(r => r.value);
      if (!ids.length) return;
      if (!confirm("删除选中的 " + ids.length + " 本？会进回收站，30 天内都能恢复。")) return;
      let k = (localStorage.getItem("nm_key") || "").trim();
      if (!k) {
        k = (prompt("输入管理密码确认删除") || "").trim();
        if (!k) return;
        localStorage.setItem("nm_key", k);
      }
      bdel.disabled = true;
      bdel.textContent = "删除中…";
      try {
        const r = await fetch("/api/bulk?op=delete&key=" + encodeURIComponent(k)
          + "&ids=" + ids.join(","), { method: "POST" });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok) { location.reload(); return; }
        alert(r.status === 403 ? "密码不对" : (j.err || "删除失败"));
      } catch (e) { alert("网络错误"); }
      bdel.disabled = false;
      bdel.textContent = "删除";
    };
  }

  /* ---------- 阅读页目录 ---------- */
  const tocBtn = $("#tocBtn");
  if (tocBtn) tocBtn.onclick = () => document.body.classList.toggle("tocOpen");
  const tocClose = $("#tocClose");
  if (tocClose) tocClose.onclick = () => document.body.classList.remove("tocOpen");
  document.addEventListener("click", e => {
    if (document.body.classList.contains("tocOpen") && !e.target.closest(".tocDrawer") && !e.target.closest("#tocBtn"))
      document.body.classList.remove("tocOpen");
  });

  document.addEventListener("keydown", e => { if (e.key === "Escape") document.body.classList.remove("tocOpen"); });

  /* ================= 阅读页：选中 → 划线 / 笔记 / 书签 ================= */
  const rbody2 = $("#rbody");
  if (rbody2) {
    const bar = $("#selBar");
    const nb = $("#noteBox");
    const bid = +rbody2.dataset.bid, cidx = +rbody2.dataset.idx;
    let pend = null;           // {para, text, mid}
    let curMid = 0;

    // 左右点按翻章：不拦截文本选择（.tz 已 pointer-events:none）
    document.addEventListener("click", e => {
      if (e.target.closest("a,button,input,textarea,.tocDrawer,.panel,#selBar,#noteBox,.hl")) return;
      if ((document.getSelection() || {}).toString().trim()) return;
      const x = e.clientX, w = window.innerWidth;
      const go = x < w * 0.2 ? document.querySelector(".tz-l") : (x > w * 0.8 ? document.querySelector(".tz-r") : null);
      const href = go && go.dataset.href;
      if (href) location.href = href;
    });

    const paraOf = node => {
      let el = node && node.nodeType === 3 ? node.parentNode : node;
      while (el && el !== rbody2) {
        if (el.classList && el.classList.contains("para")) return el;
        el = el.parentNode;
      }
      return null;
    };

    function selInfo() {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) return null;
      const txt = sel.toString().trim();
      if (!txt || txt.length < 1) return null;
      const a = paraOf(sel.anchorNode), b = paraOf(sel.focusNode);
      if (!a || a !== b) return null;
      if (!rbody2.contains(a)) return null;
      return { para: +a.dataset.i, text: txt, rect: sel.getRangeAt(0).getBoundingClientRect() };
    }

    function showBar() {
      const info = selInfo();
      if (!info) { bar.classList.remove("on"); return; }
      pend = info;
      bar.classList.add("on");
      const r = info.rect;
      const bw = bar.offsetWidth || 300;
      let left = r.left + r.width / 2 - bw / 2;
      left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
      let top = r.top - (bar.offsetHeight || 44) - 10;
      if (top < 8) top = r.bottom + 10;
      bar.style.left = left + "px";
      bar.style.top = top + "px";
    }

    const onUp = () => setTimeout(showBar, 60);
    rbody2.addEventListener("mouseup", onUp);
    rbody2.addEventListener("touchend", onUp);
    let selT = 0;
    document.addEventListener("selectionchange", () => {
      clearTimeout(selT);
      selT = setTimeout(() => {
        const info = selInfo();
        if (info) showBar();
        else if (bar.classList.contains("on")) bar.classList.remove("on");
      }, 220);
    });
    // 滚动/缩放时把工具条收起来，免得飘在错的位置
    window.addEventListener("scroll", () => bar.classList.remove("on"), { passive: true });

    async function post(url, data) {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams(data) });
      return r.json();
    }

    bar.addEventListener("click", async e => {
      const btn = e.target.closest(".sb");
      if (!btn || !pend) return;
      const op = btn.dataset.op;
      if (op === "cancel") {
        bar.classList.remove("on");
        const s0 = document.getSelection(); if (s0) s0.removeAllRanges();
        return;
      }
      if (op === "bookmark") {
        const j = await post("/api/mark", { book: bid, idx: cidx, para: -1, kind: "bookmark", text: "", color: "b" });
        toast(j.ok ? "已加书签" : "失败", !j.ok);
        bar.classList.remove("on");
        if (j.ok) setTimeout(() => location.reload(), 400);
        return;
      }
      if (op === "note") {
        curMid = 0; pend.kind = "note";
        $("#nbTitle").textContent = "写笔记";
        $("#nbQuote").textContent = pend.text;
        $("#nbText").value = "";
        $("#nbDel").style.display = "none";
        nb.classList.add("on");
        return;
      }
      // 划线（带颜色）
      const j = await post("/api/mark", {
        book: bid, idx: cidx, para: pend.para, kind: "line",
        text: pend.text, color: btn.dataset.color || "y"
      });
      toast(j.ok ? "已划线" : "失败", !j.ok);
      bar.classList.remove("on");
      if (j.ok) setTimeout(() => location.reload(), 300);
    });

    /* ---- 笔记浮层 ---- */
    const closeNb = () => nb.classList.remove("on");
    $("#nbClose").onclick = closeNb;
    $("#nbSave").onclick = async () => {
      const note = $("#nbText").value.trim();
      let j;
      if (curMid) {
        j = await post("/api/mark/note?id=" + curMid, { note });
      } else {
        j = await post("/api/mark", {
          book: bid, idx: cidx, para: pend.para, kind: note ? "note" : "line",
          text: pend.text, note, color: "y"
        });
      }
      toast(j.ok ? "已保存" : "失败", !j.ok);
      closeNb();
      if (j.ok) setTimeout(() => location.reload(), 400);
    };
    $("#nbDel").onclick = async () => {
      if (!curMid) return;
      const j = await post("/api/mark/del?id=" + curMid, {});
      toast(j.ok ? "已删除" : "失败", !j.ok);
      closeNb();
      if (j.ok) setTimeout(() => location.reload(), 400);
    };

    // 点已有划线/笔记 → 看或编辑笔记
    rbody2.addEventListener("click", e => {
      const mk = e.target.closest(".hl");
      if (!mk) return;
      e.preventDefault(); e.stopPropagation();
      curMid = +mk.dataset.mid;
      const txt = mk.textContent;
      $("#nbTitle").textContent = mk.dataset.note ? "笔记" : "划线";
      $("#nbQuote").textContent = txt;
      $("#nbText").value = "";
      $("#nbDel").style.display = "";
      nb.classList.add("on");
      fetch("/api/marks?idx=" + cidx).then(r => r.json()).then(j => {
        const hit = (j.data || []).find(x => x.id === curMid);
        if (hit) $("#nbText").value = hit.note || "";
      }).catch(() => {});
    });
  }

  /* ---- 标记页/详情页删除 ---- */
  document.addEventListener("click", async e => {
    const d = e.target.closest(".mkDel");
    if (!d) return;
    if (!confirm("删除这条标记？")) return;
    const r = await fetch("/api/mark/del?id=" + d.dataset.mid, { method: "POST" });
    const j = await r.json();
    toast(j.ok ? "已删除" : "失败", !j.ok);
    if (j.ok) { const it = d.closest(".mkItem"); if (it) it.remove(); }
  });

  /* ---- 书架正文搜索入口 & 快捷键 ---- */
  document.addEventListener("keydown", e => {
    if (e.key === "/" && !/input|textarea/i.test(document.activeElement.tagName)) {
      const box = document.querySelector(".search input");
      if (box) { e.preventDefault(); box.focus(); }
    }
  });
})();

/* ---- 换封面 ---- */
function cvKey() {
  let k = (localStorage.getItem("nm_key") || "").trim();
  if (!k) {
    k = (prompt("输入管理密码") || "").trim();
    if (k) localStorage.setItem("nm_key", k);
  }
  return k;
}
function cvDone(bid) {
  const img = document.getElementById("bcover");
  if (img) img.src = "/cover/" + bid + "?t=" + Date.now();
  toast("封面换好了");
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("#bcvBtn");
  if (btn) {
    e.preventDefault();
    const p = document.getElementById("cvPanel");
    if (p) p.classList.toggle("on");
    return;
  }
  if (e.target.closest("#cvClose")) {
    const p = document.getElementById("cvPanel");
    if (p) p.classList.remove("on");
  }
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#cvAuto")) return;
  const p = document.getElementById("cvPanel");
  const bid = p.dataset.bid;
  const k = cvKey(); if (!k) return;
  const b = document.getElementById("cvAuto");
  b.disabled = true; b.textContent = "搜索中…";
  try {
    const r = await fetch("/api/cover?id=" + bid + "&key=" + encodeURIComponent(k));
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) cvDone(bid);
    else alert(r.status === 403 ? "密码不对" : "豆瓣没收录这本，试试粘贴图片链接或上传");
  } catch (err) { alert("网络错误"); }
  b.disabled = false; b.textContent = "从豆瓣搜";
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#cvUrlGo")) return;
  const p = document.getElementById("cvPanel");
  const bid = p.dataset.bid;
  const url = (document.getElementById("cvUrl").value || "").trim();
  if (!url) return alert("先粘一个图片链接");
  const k = cvKey(); if (!k) return;
  const b = document.getElementById("cvUrlGo");
  b.disabled = true; b.textContent = "下载中…";
  try {
    const r = await fetch("/api/cover/url?id=" + bid + "&key=" + encodeURIComponent(k)
      + "&url=" + encodeURIComponent(url));
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) cvDone(bid);
    else alert(r.status === 403 ? "密码不对" : (j.err || "下载失败"));
  } catch (err) { alert("网络错误"); }
  b.disabled = false; b.textContent = "用这个链接";
});
document.addEventListener("change", async (e) => {
  const f = e.target.closest("#cvFile");
  if (!f || !f.files || !f.files[0]) return;
  const p = document.getElementById("cvPanel");
  const bid = p.dataset.bid;
  const k = cvKey(); if (!k) return;
  const fd = new FormData();
  fd.append("f", f.files[0]);
  try {
    const r = await fetch("/api/cover/up?id=" + bid + "&key=" + encodeURIComponent(k),
      { method: "POST", body: f.files[0] });
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) cvDone(bid);
    else alert(r.status === 403 ? "密码不对" : (j.err || "上传失败"));
  } catch (err) { alert("网络错误"); }
  f.value = "";
});

/* ---- 回收站：恢复 / 彻底删除 ---- */
(function () {
  const key = () => {
    let k = (localStorage.getItem("nm_key") || "").trim();
    if (!k) { k = (prompt("输入管理密码") || "").trim(); if (k) localStorage.setItem("nm_key", k); }
    return k;
  };
  document.addEventListener("click", async (e) => {
    const r = e.target.closest(".tRes"), p = e.target.closest(".tPur");
    if (!r && !p) return;
    const bid = (r || p).dataset.bid;
    const k = key(); if (!k) return;
    if (p && !confirm("彻底删除就找不回来了，确定？")) return;
    const url = "/api/" + (r ? "restore" : "purge") + "?ids=" + bid + "&key=" + encodeURIComponent(k);
    try {
      const res = await fetch(url, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (j && j.ok) { location.reload(); return; }
      alert(res.status === 403 ? "密码不对" : (j.err || "操作失败"));
    } catch (err) { alert("网络错误"); }
  });
})();

/* ---- 批量搜封面（书架） ---- */
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#cvAll")) return;
  const btn = e.target.closest("#cvAll");
  let k = (localStorage.getItem("nm_key") || "").trim();
  if (!k) { k = (prompt("输入管理密码") || "").trim(); if (!k) return; localStorage.setItem("nm_key", k); }
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "搜索中…";
  try {
    const r = await fetch("/api/cover/all?key=" + encodeURIComponent(k));
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) {
      toast(j.got ? ("搜到 " + j.got + " 张，没搜到 " + j.miss + " 本") : "一本都没搜到", !j.got);
      if (j.got) setTimeout(() => location.reload(), 900);
    } else {
      alert(r.status === 403 ? "密码不对" : (j.err || "失败"));
    }
  } catch (err) { alert("网络错误"); }
  btn.disabled = false; btn.textContent = old;
});

/* ---- 缓存本书离线 ---- */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#dlOff");
  if (!btn || !("serviceWorker" in navigator)) { if (btn) alert("这个浏览器不支持离线缓存"); return; }
  const bid = btn.dataset.bid, n = +(btn.dataset.n || 0);
  const old = btn.textContent;
  btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) throw new Error("no sw");
    for (let i = 0; i < n; i++) {
      btn.textContent = "缓存 " + (i + 1) + "/" + n;
      await fetch("/read/" + bid + "/" + i + "?offline=1", { cache: "reload" }).catch(() => {});
    }
    btn.textContent = "已缓存 " + n + " 章";
    toast("离线缓存好了，断网也能看这本书");
  } catch (err) {
    btn.textContent = old;
    alert("缓存失败，稍后再试");
  }
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2500);
});

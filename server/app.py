#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""我的书库 · 个人图书管理系统（零依赖 Python3 标准库）"""

import gzip
import hashlib
import html
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DATA = os.path.join(BASE, "data")
INBOX = os.path.join(BASE, "inbox")
DB_PATH = os.path.join(DATA, "novel.db")
CFG_PATH = os.path.join(DATA, "config.json")

PORTS = [int(x) for x in os.environ.get("NOVEL_PORTS", "80,8080").split(",") if x.strip()]
esc = html.escape

CHAPTER_RE = re.compile(
    r"(?m)^[ \t]*(第[0-9零一二三四五六七八九十百千万两]+[章节回卷][^\n]{0,40}"
    r"|Chapter\s+\d+[^\n]{0,40}"
    r"|\d{1,4}[、.．][^\n]{0,40})\s*$"
)
STATUS = {"reading": "在读", "unread": "未读", "done": "读完"}
SORTS = {"title", "author", "cat", "chapters", "chars", "progress", "updated", "added"}
DEFAULT_CFG = {"site_title": "我的书库", "site_pass": "",
               "per_page": 12}

ICONS = {
    "search": '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5 21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    "back": '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}


# ---------------------------------------------------------------- 存储
def db():
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    return c


def init_db():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(INBOX, exist_ok=True)
    c = db()
    try:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS books(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            author TEXT DEFAULT '',
            cat TEXT DEFAULT '未分类',
            tags TEXT DEFAULT '',
            intro TEXT DEFAULT '',
            chapters INTEGER DEFAULT 0,
            chars INTEGER DEFAULT 0,
            status TEXT DEFAULT 'unread',
            progress INTEGER DEFAULT 0,
            last_idx INTEGER DEFAULT 0,
            source TEXT DEFAULT '',
            added TEXT DEFAULT '',
            updated TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS chapters(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            idx INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_ch_book ON chapters(book_id, idx);
        CREATE INDEX IF NOT EXISTS ix_bk_updated ON books(updated DESC);
        CREATE TABLE IF NOT EXISTS marks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            idx INTEGER NOT NULL,
            para INTEGER DEFAULT 0,
            kind TEXT DEFAULT 'line',
            text TEXT DEFAULT '',
            note TEXT DEFAULT '',
            color TEXT DEFAULT 'y',
            created TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS ix_mk_book ON marks(book_id, idx);
        """)
        try:
            c.executescript("""
            CREATE VIRTUAL TABLE IF NOT EXISTS ft USING fts5(
                content, book_id UNINDEXED, idx UNINDEXED, ctitle UNINDEXED,
                tokenize='unicode61 remove_diacritics 0'
            );""")
        except Exception as e:
            print("[fts] 建表失败（退化为人名搜索）:", e)
        try:
            cols = [r[1] for r in c.execute("PRAGMA table_info(books)").fetchall()]
            if "last_para" not in cols:
                c.execute("ALTER TABLE books ADD COLUMN last_para INTEGER DEFAULT 0")
            if "deleted_at" not in cols:
                c.execute("ALTER TABLE books ADD COLUMN deleted_at TEXT DEFAULT ''")
            if "hash" not in cols:
                c.execute("ALTER TABLE books ADD COLUMN hash TEXT DEFAULT ''")
            c.execute("CREATE INDEX IF NOT EXISTS ix_bk_del ON books(deleted_at)")
            c.execute("""CREATE TABLE IF NOT EXISTS reads(
                day TEXT NOT NULL, book_id INTEGER NOT NULL, idx INTEGER NOT NULL,
                chars INTEGER DEFAULT 0, PRIMARY KEY(day, book_id, idx))""")
        except Exception as e:
            print("[db] last_para 迁移失败:", e)
        c.commit()
    finally:
        c.close()


def cfg():
    try:
        with open(CFG_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    out = dict(DEFAULT_CFG)
    out.update({k: v for k, v in d.items() if v not in (None, "")})
    return out


def save_cfg(d):
    os.makedirs(DATA, exist_ok=True)
    tmp = CFG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CFG_PATH)


def today():
    return time.strftime("%Y-%m-%d")


# ---------------------------------------------------------------- 全文索引
CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")


def to_index_text(s):
    """入库前把中文逐字空格分开，英文/数字整词保留，让 FTS5 能按字检索。"""
    out, buf = [], []
    for ch in s or "":
        if CJK.match(ch):
            if buf:
                out.append("".join(buf)); buf = []
            out.append(ch)
        elif ch.isalnum() or ch == "_":
            buf.append(ch)
        else:
            if buf:
                out.append("".join(buf)); buf = []
    if buf:
        out.append("".join(buf))
    return " ".join(out)


def to_query(q):
    """把用户输入变成 FTS5 MATCH 表达式：中文串→逐字短语，英文词→整词。"""
    q = (q or "").strip()
    if not q:
        return ""
    parts, i, n = [], 0, len(q)
    while i < n:
        ch = q[i]
        if CJK.match(ch):
            run = []
            while i < n and CJK.match(q[i]):
                run.append(q[i]); i += 1
            parts.append('"%s"' % " ".join(run))
        elif ch.isalnum():
            run = []
            while i < n and (q[i].isalnum() or q[i] == "_"):
                run.append(q[i]); i += 1
            parts.append('"%s"' % "".join(run))
        else:
            i += 1
    return " AND ".join(parts)


def fts_doc(title, content):
    """索引文档 = 章节标题 + 正文，这样章名里的词也能搜到。"""
    return to_index_text(((title or "") + "\n" + (content or "")))


def fts_ok(c):
    try:
        c.execute("SELECT rowid FROM ft LIMIT 1").fetchone()
        return True
    except Exception:
        return False


def fts_sync(full=False):
    """让全文索引和章节表保持一致（增量补齐）。"""
    c = db()
    try:
        if not fts_ok(c):
            return 0
        if full:
            c.execute("DELETE FROM ft")
            have = set()
        else:
            have = {r[0] for r in c.execute("SELECT rowid FROM ft")}
        rows = c.execute("SELECT id, book_id, idx, title, content FROM chapters").fetchall()
        todo = [r for r in rows if r["id"] not in have]
        if todo:
            c.executemany(
                "INSERT INTO ft(rowid, content, book_id, idx, ctitle) VALUES(?,?,?,?,?)",
                [(r["id"], fts_doc(r["title"], r["content"]), r["book_id"], r["idx"],
                  (r["title"] or "")[:100]) for r in todo])
            c.commit()
        if full:
            for r in rows:
                pass
        return len(todo)
    finally:
        c.close()


def make_snippet(text, q, width=88):
    """在正文里截一段命中上下文。"""
    plain = re.sub(r"\s+", " ", (text or "").strip())
    if not plain:
        return ""
    pos, probe = -1, ""
    cands = [q.strip()] + [x for x in re.split(r"\s+", to_query(q).replace('"', " ")) if x]
    for cand in cands:
        cand = cand.strip()
        if not cand:
            continue
        p = plain.find(cand)
        if p >= 0:
            pos, probe = p, cand
            break
    if pos < 0:
        return plain[:width] + ("…" if len(plain) > width else "")
    a = max(0, pos - width // 3)
    b = min(len(plain), a + width)
    return ("…" if a > 0 else "") + plain[a:b] + ("…" if b < len(plain) else "")


def search_text(q, bid=None, limit=120):
    """全书库/单本正文检索，返回命中章节 + 片段。"""
    expr = to_query(q)
    if not expr:
        return [], 0
    c = db()
    try:
        if not fts_ok(c):
            return [], 0
        sql = "SELECT rowid AS cid, book_id, idx, ctitle, bm25(ft) AS rk FROM ft WHERE ft MATCH ?"
        args = [expr]
        if bid:
            sql += " AND book_id=?"
            args.append(bid)
        sql += " ORDER BY rk LIMIT ?"
        args.append(limit)
        try:
            hits = [dict(r) for r in c.execute(sql, args)]
        except Exception as e:
            print("[fts] 查询失败:", e)
            return [], 0
        out = []
        for h in hits:
            row = c.execute("SELECT content FROM chapters WHERE id=?", (h["cid"],)).fetchone()
            bk = c.execute("SELECT id, title, author, cat FROM books WHERE id=?", (h["book_id"],)).fetchone()
            if not row or not bk:
                continue
            out.append({"book_id": h["book_id"], "title": bk["title"], "author": bk["author"],
                        "cat": bk["cat"], "idx": h["idx"], "ctitle": h["ctitle"],
                        "snip": make_snippet(row["content"] or "", q)})
        return out, len(out)
    finally:
        c.close()


# ---------------------------------------------------------------- 标注（划线/笔记/书签）
MARK_COLORS = {"y": "黄", "g": "绿", "b": "蓝", "p": "粉"}
MARK_KINDS = {"line": "划线", "note": "笔记", "bookmark": "书签"}


def book_marks(bid=None, idx=None, limit=2000):
    c = db()
    try:
        sql = ("SELECT m.*, b.title AS btitle, b.author AS bauthor, c.title AS ctitle"
               " FROM marks m LEFT JOIN books b ON b.id=m.book_id"
               " LEFT JOIN chapters c ON c.book_id=m.book_id AND c.idx=m.idx")
        where, args = [], []
        if bid:
            where.append("m.book_id=?"); args.append(bid)
        if idx is not None:
            where.append("m.idx=?"); args.append(idx)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY m.book_id, m.idx, m.para, m.id LIMIT ?"
        args.append(limit)
        return [dict(r) for r in c.execute(sql, args)]
    finally:
        c.close()


def marks_by_para(bid, idx):
    out = {}
    for m in book_marks(bid, idx):
        out.setdefault(m["para"], []).append(m)
    return out


def add_mark(bid, idx, para, text="", note="", color="y", kind="line"):
    color = color if color in MARK_COLORS else "y"
    kind = kind if kind in MARK_KINDS else "line"
    c = db()
    try:
        cur = c.execute(
            "INSERT INTO marks(book_id,idx,para,kind,text,note,color,created) VALUES(?,?,?,?,?,?,?,?)",
            (bid, idx, para, kind, (text or "")[:400], (note or "")[:2000], color, today()))
        c.commit()
        return cur.lastrowid
    finally:
        c.close()


def del_mark(mid):
    c = db()
    try:
        c.execute("DELETE FROM marks WHERE id=?", (mid,))
        c.commit()
    finally:
        c.close()


def apply_marks(plain, ms):
    """在纯文本上按标注打标签（互不重叠）。"""
    hits, used = [], []
    for m in ms:
        sel = (m["text"] or "").strip()
        if not sel:
            continue
        pos = plain.find(sel)
        if pos < 0:
            continue
        a, b = pos, pos + len(sel)
        if any(not (b <= x or a >= y) for x, y in used):
            continue
        used.append((a, b))
        hits.append((a, b, m))
    hits.sort()
    out, last = [], 0
    for a, b, m in hits:
        out.append(esc(plain[last:a]))
        out.append('<mark class="hl c-%s" data-mid="%d"%s>%s</mark>'
                   % (m["color"] or "y", m["id"],
                      ' data-note="1"' if m["note"] else "", esc(plain[a:b])))
        last = b
    out.append(esc(plain[last:]))
    return "".join(out)


def render_paras(content, mkmap=None, fs=17, lh=1.95):
    """把章节正文切成段落渲染，段落上叠加标注。"""
    mkmap = mkmap or {}
    paras = [p.strip() for p in re.split(r"\r?\n+", content or "") if p.strip()]
    out = []
    for i, p in enumerate(paras):
        ms = mkmap.get(i, [])
        html_p = apply_marks(p, ms) if ms else esc(p)
        has_note = " noteMark" if any(m["note"] for m in ms) else ""
        out.append('<p class="para%s" data-i="%d">%s</p>' % (has_note, i, html_p))
    return "".join(out)




_PNG = {}


def make_png(size):
    """纯 Python 生成圆角渐变图标（蓝紫 + 白色书脊）。"""
    if size in _PNG:
        return _PNG[size]
    import struct
    import zlib
    pad = max(2, size // 10)
    r0 = int(size * 0.22)
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            # 圆角遮罩
            a = 255
            cx = min(max(x, r0), size - 1 - r0)
            cy = min(max(y, r0), size - 1 - r0)
            if (x - cx) ** 2 + (y - cy) ** 2 > r0 * r0:
                a = 0
            t = (x + y) / float(2 * size)
            r = int(59 + (99 - 59) * t)
            g = int(130 + (102 - 130) * t)
            b = int(246 + (241 - 246) * t)
            # 三条白色书脊
            bw = size * 0.09
            for i, off in enumerate((0.27, 0.435, 0.60)):
                x0 = size * off
                if x0 <= x <= x0 + bw and size * 0.28 <= y <= size * 0.72:
                    r = g = b = 255
            raw += bytes((r, g, b, a))

    def ch(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + ch(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + ch(b"IDAT", zlib.compress(bytes(raw), 9))
           + ch(b"IEND", b""))
    _PNG[size] = png
    return png


# ---------------------------------------------------------------- 解析
def split_chapters(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []
    marks = list(CHAPTER_RE.finditer(text))
    if len(marks) < 2:
        return [("正文", text)]
    out = []
    head = text[: marks[0].start()].strip()
    if len(head) > 30:
        out.append(("序", head))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end].strip()
        out.append((m.group(0).strip()[:60], body))
    return out


def clean_intro(text, n=160):
    t = re.sub(r"\s+", " ", text).strip()
    return t[:n]


# ---- 自动分类：文件名括号前缀 > 文件名关键词 > 正文前 3000 字关键词 ----
CAT_GROUPS = [
    ("男生", ["玄幻", "奇幻", "武侠", "仙侠", "都市", "现实", "历史", "军事",
              "科幻", "悬疑", "灵异", "游戏", "体育", "二次元", "短篇"]),
    ("女生", ["现代言情", "古代言情", "幻情", "仙侠奇缘", "豪门总裁", "青春校园",
              "浪漫青春", "种田", "年代", "快穿", "综漫", "娱乐圈"]),
    ("出版", ["出版", "文学", "名著", "传记"]),
]
CATS = [c for _g, _cs in CAT_GROUPS for c in _cs] + ["未分类"]

# 顺序即优先级：越靠前越优先命中（同名关键词取前面的）
CAT_WORDS = [
    ("仙侠奇缘", ("仙侠奇缘", "上神", "仙尊", "渡劫", "仙侣", "神君", "双修")),
    ("仙侠", ("仙侠", "修真", "飞升", "剑仙", "天庭", "元婴", "金丹", "炼气", "仙门", "道法", "灵根")),
    ("玄幻", ("玄幻", "异世", "异界", "斗气", "神魔", "宗门", "修炼", "灵石", "血脉", "斗罗",
              "洪荒", "强者为尊", "斩神", "成神", "神明", "诡秘")),
    ("奇幻", ("奇幻", "魔法", "精灵", "矮人", "法师", "魔王", "骑士", "巨龙", "咒语", "冒险者",
              "龙族", "神话", "银龙", "进化", "亚人")),
    ("武侠", ("武侠", "江湖", "侠客", "刀客", "剑客", "武林", "内力", "镖局", "掌门", "招式", "江湖恩怨")),
    ("古代言情", ("古代言情", "古言", "宫廷", "王爷", "嫡女", "庶女", "太子", "皇宫", "和亲", "后院", "状元", "侯府")),
    ("豪门总裁", ("豪门", "总裁", "少夫人", "契约婚", "替身", "离婚", "首富", "财阀", "冷面")),
    ("现代言情", ("现代言情", "言情", "暗恋", "告白", "甜宠", "青梅", "心动", "婚约", "前任", "恋爱")),
    ("幻情", ("幻情", "妖孽", "灵契", "玄幻言情", "情劫")),
    ("快穿", ("快穿", "宿主", "位面", "攻略任务")),
    ("种田", ("种田", "农门", "田园", "当家", "分家", "空间农场", "发家致富")),
    ("年代", ("年代文", "七零", "八零", "六零", "知青", "公社", "大集体", "下放")),
    ("青春校园", ("校园", "高中", "同桌", "教室", "毕业", "班主任", "初恋", "大学", "校草")),
    ("浪漫青春", ("浪漫青春", "花季", "少女心", "少年感", "青春疼痛")),
    ("娱乐圈", ("娱乐圈", "影后", "顶流", "经纪", "综艺", "粉丝", "塌房", "剧粉")),
    ("综漫", ("综漫", "火影", "海贼", "咒术", "鬼灭", "名侦探柯南")),
    ("二次元", ("二次元", "动漫", "轻小说", "番剧", "同人", "御宅", "萌系")),
    ("都市", ("都市", "职场", "公司", "上司", "地铁", "拆迁", "校花", "创业", "写字楼", "白领", "市井")),
    ("现实", ("现实", "农民工", "小镇", "底层", "打工", "乡愁", "纪实", "扶贫")),
    ("历史", ("历史", "王朝", "皇帝", "大明", "大唐", "三国", "春秋", "将军", "史书", "朝堂", "穿越成")),
    ("军事", ("军事", "战场", "士兵", "狙击", "战争", "特种", "军旅", "弹药", "指挥", "战壕")),
    ("科幻", ("科幻", "星际", "飞船", "外星", "机甲", "基因", "赛博", "虫洞", "跃迁", "星舰", "末世", "丧尸")),
    ("悬疑", ("悬疑", "推理", "凶案", "侦探", "密室", "诡计", "凶手", "刑警", "尸检", "线索")),
    ("灵异", ("灵异", "僵尸", "招魂", "诅咒", "闹鬼", "阴森", "鬼屋", "厉鬼", "纸钱", "风水", "阴阳", "恐怖")),
    ("游戏", ("游戏", "副本", "玩家", "公会", "电竞", "刷怪", "装备", "服务器", "技能点",
              "网游", "全息", "法强", "打野", "上单", "BOSS")),
    ("体育", ("体育", "球场", "教练", "联赛", "运动员", "冠军", "训练", "比分", "转会")),
    ("出版", ("出版", "出版社", "书号", "精装", "纸书")),
    ("文学", ("文学", "散文", "诗歌", "随笔", "杂文", "札记", "小说集")),
    ("名著", ("名著", "经典", "全集", "译本", "四大名著")),
    ("传记", ("传记", "自传", "回忆录", "生平", "口述史")),
    ("短篇", ("短篇", "微小说", "合集", "短故事")),
]
CAT_PREFIX_RE = re.compile(r"^\s*[\[【（(]\s*([^\]】）)]{1,10})\s*[\]】）)]\s*")


AUTHOR_RE = re.compile(r"作\s*者\s*[:：]\s*([^\r\n]{1,30})")
TITLE_HDR_RE = re.compile(r"(?:书\s*名|作品名|小说名|书名)\s*[:：]\s*([^\r\n]{1,60})")
BRACKET_TAIL_RE = re.compile(r"[\(（\[【]\s*([^\)）\]】]{2,12})\s*[\)）\]】]\s*$")
DASH_AUTHOR_RE = re.compile(r"\s*[-—_]+\s*(?:by\s*)?([^\s\-—_]{2,12})\s*$", re.I)
JUNK_AUTHOR = ("未知", "佚名", "无", "不详", "admin", "作者", "txt", "全本", "完结",
               "精校版", "校对版", "最新章节", "免费阅读")


def _clean_author(a):
    a = (a or "").strip()
    a = re.sub(r"^[\s:：\-_—·]+|[\s:：\-_—·]+$", "", a)
    a = re.sub(r"\.(txt|md|zip)$", "", a, flags=re.I)
    if not a or len(a) > 20:
        return ""
    if a.lower() in JUNK_AUTHOR or a in JUNK_AUTHOR:
        return ""
    return a


def guess_author(name, text=""):
    """从文件名 / 正文开头嗅探作者，返回 (作者, 去掉作者后的书名)。"""
    base = os.path.splitext(os.path.basename(name or ""))[0].strip()
    clean = base
    # ① 文件名里带「作者：xxx」
    m = AUTHOR_RE.search(base)
    if m:
        a = _clean_author(m.group(1))
        if a:
            clean = AUTHOR_RE.sub("", base).strip(" \t-_—·")
            return a, clean
    # ② 文件名尾部括号：(作者) / 【作者】
    m = BRACKET_TAIL_RE.search(base)
    if m:
        a = _clean_author(m.group(1))
        if a and not re.search(r"[\d章卷部册集]", a):
            return a, base[:m.start()].strip(" \t-_—·")
    # ③ 文件名「书名 - 作者」
    m = DASH_AUTHOR_RE.search(base)
    if m:
        a = _clean_author(m.group(1))
        head = base[:m.start()].strip(" \t-_—·")
        if a and head and len(head) >= 2:
            return a, head
    # ④ 正文开头（前 2500 字）
    head = (text or "")[:2500]
    m = AUTHOR_RE.search(head)
    if m:
        a = _clean_author(m.group(1))
        if a:
            clean = AUTHOR_RE.sub("", base).strip(" \t-_—·") or base
            return a, clean
    return "", clean


def guess_title_head(text=""):
    m = TITLE_HDR_RE.search((text or "")[:2500])
    if m:
        t = m.group(1).strip(" 《》\"'")
        t = re.sub(r"\.(txt|md|zip)$", "", t, flags=re.I).strip()
        if 1 < len(t) <= 60:
            return t
    return ""


def guess_cat(name, text=""):
    """返回 (分类, 清洗后的书名)。认不出来就落「未分类」。"""
    base = os.path.splitext(os.path.basename(name or ""))[0].strip()
    m = CAT_PREFIX_RE.match(base)
    if m:
        tag = m.group(1).strip()
        rest = base[m.end():].strip()
        for cat, words in CAT_WORDS:
            if tag == cat or tag in words or cat in tag:
                return cat, (rest or base)
    hits = []
    for cat, words in CAT_WORDS:
        n = sum(1 for w in words if w and w in base)
        if n:
            hits.append((n, cat))
    if hits:
        hits.sort(key=lambda x: -x[0])
        return hits[0][1], base
    head = (text or "")[:3000]
    hits = []
    for cat, words in CAT_WORDS:
        n = sum(1 for w in words if w and w in head)
        if n >= 3:
            hits.append((n, cat))
    if hits:
        hits.sort(key=lambda x: -x[0])
        if len(hits) == 1 or hits[0][0] >= hits[1][0] + 2:
            return hits[0][1], base
    return "未分类", base


def import_text(raw_bytes, filename="", cat="", author="", title=None):
    name = filename or "未命名"
    if raw_bytes[:2] == b"PK":
        return import_zip(raw_bytes, cat=cat)
    for enc in ("utf-8", "utf-8-sig", "gbk", "gb18030", "big5", "utf-16"):
        try:
            text = raw_bytes.decode(enc)
            break
        except Exception:
            continue
    else:
        text = raw_bytes.decode("utf-8", "ignore")
    auto_cat, clean_base = guess_cat(name, text)
    auto_author, auth_clean = guess_author(name, text)
    base = auth_clean or clean_base or os.path.splitext(os.path.basename(name))[0]
    base = base.strip(" 　《》") or base
    t = title or base or guess_title_head(text)
    for junk in ("(1)", "（1）", "全本", "完结", "校对版", "精校版"):
        t = t.replace(junk, "")
    t = t.strip() or base
    chs = split_chapters(text)
    if not chs:
        raise ValueError("没有正文内容")
    chars = len(re.sub(r"\s", "", text))
    author = (author or auto_author or "").strip()
    body_flat = re.sub(r"\s", "", text)
    bhash = hashlib.sha256(body_flat.encode("utf-8", "ignore")).hexdigest()[:24]
    # 去重：正文 hash 相同的书不再入第二份
    cc = db()
    try:
        dup = cc.execute("SELECT id,title FROM books WHERE hash=? AND deleted_at='' LIMIT 1",
                         (bhash,)).fetchone()
        if dup is None:
            dup = cc.execute("SELECT id,title FROM books WHERE title=? AND chapters=? AND deleted_at='' LIMIT 1",
                             (t[:120], len(chs))).fetchone()
    except Exception:
        dup = None
    finally:
        cc.close()
    if dup is not None:
        return {"ok": False, "dup": True, "id": dup["id"], "title": dup["title"],
                "err": "库里已经有《%s》，跳过" % dup["title"]}
    rows = [re.sub(r"\s{2,}", " ", c[0]).strip() or ("第%d章" % (i + 1)) for i, c in enumerate(chs)]
    now = today()
    c = db()
    try:
        cur = c.execute(
            "INSERT INTO books(title,author,cat,tags,intro,chapters,chars,status,progress,last_idx,"
            "source,added,updated,hash)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (t[:120], author, (cat or auto_cat or "未分类").strip(), "",
             clean_intro(chs[0][1] if chs else ""),
             len(chs), chars, "unread", 0, 0, name[:200], now, now, bhash),
        )
        bid = cur.lastrowid
        c.executemany(
            "INSERT INTO chapters(book_id,idx,title,content) VALUES(?,?,?,?)",
            [(bid, i, rows[i][:100], chs[i][1]) for i in range(len(chs))],
        )
        try:
            ids = [r["id"] for r in c.execute(
                "SELECT id FROM chapters WHERE book_id=? ORDER BY idx", (bid,))]
            c.executemany(
                "INSERT INTO ft(rowid, content, book_id, idx, ctitle) VALUES(?,?,?,?,?)",
                [(ids[i], fts_doc(rows[i], chs[i][1]), bid, i, rows[i][:100])
                 for i in range(len(ids))])
        except Exception as e:
            print("[fts] 索引写入失败:", e)
        c.commit()
    finally:
        c.close()
    return {"ok": True, "id": bid, "title": t, "author": author,
            "cat": (cat or auto_cat or "未分类").strip(),
            "chapters": len(chs), "chars": chars}


def import_zip(raw_bytes, cat=""):
    zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    out = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        fn = info.filename
        if not fn.lower().endswith((".txt", ".md")):
            continue
        base = os.path.basename(fn)
        if base.startswith(".") or "__MACOSX" in fn:
            continue
        try:
            r = import_text(zf.read(info), filename=base, cat=cat)
            out.append(r)
        except Exception as e:
            out.append({"ok": False, "title": base, "err": str(e)})
    ok = [r for r in out if r.get("ok")]
    return {"ok": bool(ok), "count": len(ok), "items": out,
            "title": "、".join(r["title"] for r in ok[:3]),
            "chapters": sum(r["chapters"] for r in ok),
            "chars": sum(r["chars"] for r in ok)}


# ---------------------------------------------------------------- 查询
def qs_int(v, d, lo=1, hi=10 ** 9):
    try:
        return max(lo, min(hi, int(v)))
    except Exception:
        return d


def list_books(q="", f="all", sort="updated", desc=True, page=1, per=12, deleted=False):
    where, args = ["deleted_at%s ''" % ("<>" if deleted else "=")], []
    if q:
        where.append("(title LIKE ? OR author LIKE ? OR cat LIKE ? OR tags LIKE ?)")
        like = "%" + q + "%"
        args += [like, like, like, like]
    if f in STATUS:
        where.append("status = ?")
        args.append(f)
    w = (" WHERE " + " AND ".join(where)) if where else ""
    col = sort if sort in SORTS else "updated"
    order = "DESC" if desc else "ASC"
    c = db()
    try:
        total = c.execute("SELECT COUNT(*) FROM books" + w, args).fetchone()[0]
        pages = max(1, (total + per - 1) // per)
        page = min(page, pages)
        rows = c.execute(
            "SELECT id,title,author,cat,tags,chapters,chars,status,progress,last_idx,added,updated"
            " FROM books" + w + " ORDER BY %s %s, id DESC LIMIT ? OFFSET ?" % (col, order),
            args + [per, (page - 1) * per],
        ).fetchall()
    finally:
        c.close()
    return [dict(r) for r in rows], total, pages, page


def stats():
    c = db()
    try:
        LIVE = " WHERE deleted_at=''"
        r = c.execute("SELECT COUNT(*) n, COALESCE(SUM(chars),0) c, COALESCE(SUM(chapters),0) ch "
                      "FROM books" + LIVE).fetchone()
        by = {row["status"]: row["n"] for row in c.execute(
            "SELECT status, COUNT(*) n FROM books" + LIVE + " GROUP BY status")}
        cats = [dict(x) for x in c.execute(
            "SELECT cat, COUNT(*) n FROM books" + LIVE + " GROUP BY cat ORDER BY n DESC")]
        recent = [dict(x) for x in c.execute(
            "SELECT id,title,author,status,updated FROM books" + LIVE +
            " ORDER BY updated DESC, id DESC LIMIT 6")]
        try:
            ntrash = c.execute("SELECT COUNT(*) FROM books WHERE deleted_at<>''").fetchone()[0]
        except Exception:
            ntrash = 0
        series = []
        for i in range(6, -1, -1):
            d = time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400))
            n = c.execute("SELECT COUNT(*) FROM books WHERE updated=? AND deleted_at=''", (d,)).fetchone()[0]
            series.append((d[5:], n))
        tags = [dict(x) for x in c.execute(
            "SELECT tags FROM books WHERE tags<>'' AND deleted_at='' LIMIT 500")]
        try:
            nmk = c.execute("SELECT COUNT(*) FROM marks").fetchone()[0]
            nhl = c.execute("SELECT COUNT(*) FROM marks WHERE kind<>'bookmark'").fetchone()[0]
        except Exception:
            nmk = nhl = 0
    finally:
        c.close()
    tc = {}
    for t in tags:
        for x in t["tags"].split(","):
            x = x.strip()
            if x:
                tc[x] = tc.get(x, 0) + 1
    top_tags = sorted(tc.items(), key=lambda kv: -kv[1])[:8]
    return {"all": r["n"], "chars": r["c"], "chapters": r["ch"], "by": by,
            "cats": cats, "recent": recent, "series": series, "tags": top_tags,
            "marks": nmk, "hl": nhl, "trash": ntrash}


def get_book(bid, allow_deleted=False):
    c = db()
    try:
        b = c.execute("SELECT * FROM books WHERE id=?", (bid,)).fetchone()
        if not b or (not allow_deleted and (b["deleted_at"] or "")):
            return None, []
        chs = c.execute("SELECT idx,title FROM chapters WHERE book_id=? ORDER BY idx", (bid,)).fetchall()
        return dict(b), [dict(x) for x in chs]
    finally:
        c.close()


def get_chapter(bid, idx):
    c = db()
    try:
        r = c.execute("SELECT title,content FROM chapters WHERE book_id=? AND idx=?", (bid, idx)).fetchone()
        n = c.execute("SELECT COUNT(*) FROM chapters WHERE book_id=?", (bid,)).fetchone()[0]
        return (dict(r) if r else None), n
    finally:
        c.close()


def read_tick(bid, idx, chars):
    """按天去重记录「今天读了哪本书的哪一章」，用来出统计。"""
    c = db()
    try:
        c.execute("INSERT OR IGNORE INTO reads(day,book_id,idx,chars) VALUES(?,?,?,?)",
                  (time.strftime("%Y-%m-%d"), int(bid), int(idx), int(chars)))
        c.commit()
    except Exception as e:
        print("[reads] 记录失败:", e)
    finally:
        c.close()


def read_stats(days=45):
    c = db()
    try:
        rows = [dict(r) for r in c.execute(
            "SELECT day, SUM(chars) c, COUNT(*) n FROM reads GROUP BY day ORDER BY day DESC LIMIT ?",
            (days,)).fetchall()]
        tot = c.execute("SELECT COALESCE(SUM(chars),0) s, COUNT(DISTINCT day) d FROM reads").fetchone()
        top = [dict(r) for r in c.execute(
            "SELECT book_id, SUM(chars) c FROM reads GROUP BY book_id ORDER BY c DESC LIMIT 8")]
        done_month = c.execute(
            "SELECT COUNT(*) FROM books WHERE status='done' AND updated LIKE ?",
            (time.strftime("%Y-%m"),)).fetchone()[0]
    finally:
        c.close()
    bmap = {}
    if top:
        c = db()
        try:
            q = ",".join("?" * len(top))
            for r in c.execute("SELECT id,title FROM books WHERE id IN (%s)" % q,
                               [t["book_id"] for t in top]):
                bmap[r["id"]] = r["title"]
        finally:
            c.close()
    for t in top:
        t["title"] = bmap.get(t["book_id"], "已删除")
    streak = 0
    dset = set(r["day"] for r in rows)
    for i in range(400):
        d = time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400))
        if d in dset:
            streak += 1
        elif i > 0:
            break
    return {"days": rows, "total": tot["s"], "active_days": tot["d"], "streak": streak,
            "top": top, "done_month": done_month}


def save_pos(bid, idx, para):
    """只存阅读位置，不动 updated/status，避免刷屏「最近更新」。"""
    c = db()
    try:
        c.execute("UPDATE books SET last_idx=?, last_para=? WHERE id=?",
                  (int(idx), int(para), int(bid)))
        c.commit()
    finally:
        c.close()


def save_progress(bid, idx, para=None):
    c = db()
    try:
        n = c.execute("SELECT COUNT(*) FROM chapters WHERE book_id=?", (bid,)).fetchone()[0]
        if not n:
            return
        pct = int(round((idx + 1) * 100.0 / n))
        st = "done" if pct >= 99 else "reading"
        if para is None:
            c.execute("UPDATE books SET last_idx=?, progress=?, status=?, updated=? WHERE id=?",
                      (idx, pct, st, today(), bid))
        else:
            c.execute("UPDATE books SET last_idx=?, progress=?, status=?, updated=?, last_para=? "
                      "WHERE id=?", (idx, pct, st, today(), int(para), bid))
        c.commit()
    finally:
        c.close()


def delete_books(ids):
    """软删除：只打标记，正文和笔记都留着，30 天内可恢复。"""
    c = db()
    try:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        for bid in ids:
            c.execute("UPDATE books SET deleted_at=? WHERE id=? AND deleted_at=''", (now, bid))
            try:
                c.execute("DELETE FROM ft WHERE rowid IN (SELECT id FROM chapters WHERE book_id=?)", (bid,))
            except Exception:
                pass
        c.commit()
    finally:
        c.close()


def restore_books(ids):
    c = db()
    try:
        for bid in ids:
            c.execute("UPDATE books SET deleted_at='' WHERE id=?", (bid,))
            try:
                rows = c.execute("SELECT id,idx,title,content FROM chapters WHERE book_id=? ORDER BY idx",
                                 (bid,)).fetchall()
                c.executemany(
                    "INSERT INTO ft(rowid, content, book_id, idx, ctitle) VALUES(?,?,?,?,?)",
                    [(r["id"], fts_doc(r["title"], r["content"]), bid, r["idx"], (r["title"] or "")[:100])
                     for r in rows])
            except Exception as e:
                print("[fts] 恢复索引失败:", e)
        c.commit()
    finally:
        c.close()


def purge_books(ids):
    """真删：章节、笔记、索引、封面一起清。"""
    c = db()
    try:
        for bid in ids:
            try:
                c.execute("DELETE FROM ft WHERE rowid IN (SELECT id FROM chapters WHERE book_id=?)", (bid,))
            except Exception:
                pass
            c.execute("DELETE FROM marks WHERE book_id=?", (bid,))
            c.execute("DELETE FROM reads WHERE book_id=?", (bid,))
            c.execute("DELETE FROM chapters WHERE book_id=?", (bid,))
            c.execute("DELETE FROM books WHERE id=?", (bid,))
        c.commit()
    finally:
        c.close()
    for bid in ids:
        for ext in (".jpg", ".jpeg", ".png", ".webp"):
            fp = os.path.join(COVER_DIR, "%d%s" % (bid, ext))
            if os.path.exists(fp):
                try:
                    os.remove(fp)
                except Exception:
                    pass


def purge_expired(days=30):
    """回收站里超过 N 天的自动清掉。"""
    c = db()
    try:
        rows = c.execute("SELECT id FROM books WHERE deleted_at<>'' AND deleted_at < ?",
                         (time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - days * 86400)),)
                         ).fetchall()
    finally:
        c.close()
    ids = [r["id"] for r in rows]
    if ids:
        purge_books(ids)
        print("[trash] 自动清理 %d 本" % len(ids))
    return ids


def book_text(bid):
    b, chs = get_book(bid)
    if not b:
        return None, None
    parts = [b["title"] + "\n"]
    if b.get("author"):
        parts.append("作者：" + b["author"] + "\n")
    parts.append("\n")
    c = db()
    try:
        for row in c.execute("SELECT title,content FROM chapters WHERE book_id=? ORDER BY idx", (bid,)):
            parts.append(row["title"] + "\n\n" + row["content"] + "\n\n")
    finally:
        c.close()
    return b["title"], "".join(parts)


def books_txt(ids):
    """把选中的书合成一个 .txt；只有 1 本时就是原书。"""
    parts = []
    for i, bid in enumerate(ids):
        title, txt = book_text(bid)
        if txt is None:
            continue
        if len(ids) > 1:
            if i:
                parts.append("\n\n" + "=" * 30 + "\n\n")
            parts.append("【%s】\n\n" % (title or ("book-%d" % bid)))
        parts.append(txt)
    if not parts:
        return None, None
    first = book_text(ids[0])[0] if len(ids) == 1 else "合集-%d本" % len(ids)
    return first or "books", "".join(parts)


def all_zip(ids=None):
    buf = io.BytesIO()
    c = db()
    try:
        if ids:
            q = ",".join("?" * len(ids))
            books = c.execute("SELECT * FROM books WHERE id IN (%s)" % q, ids).fetchall()
        else:
            books = c.execute("SELECT * FROM books").fetchall()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for b in books:
                parts = [b["title"] + "\n\n"]
                for row in c.execute("SELECT title,content FROM chapters WHERE book_id=? ORDER BY idx", (b["id"],)):
                    parts.append(row["title"] + "\n\n" + row["content"] + "\n\n")
                safe = re.sub(r'[\\/:*?"<>|]', "_", b["title"]) or ("book-%d" % b["id"])
                zf.writestr(safe + ".txt", "".join(parts))
    finally:
        c.close()
    return buf.getvalue()


# ---------------------------------------------------------------- 组件
GRADS = ["g1", "g2", "g3", "g4", "g5", "g6"]


def grad(bid):
    return GRADS[(bid or 0) % len(GRADS)]


COVER_PAIRS = [("#6366f1", "#a855f7"), ("#0ea5e9", "#2563eb"), ("#f59e0b", "#ef4444"),
               ("#10b981", "#0d9488"), ("#ec4899", "#8b5cf6"), ("#64748b", "#334155"),
               ("#f97316", "#db2777"), ("#14b8a6", "#0891b2")]


def wrap_cjk(t, n):
    t = (t or "").strip()
    return [t[i:i + n] for i in range(0, len(t), n)]


COVER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "covers")


def cover_file(bid):
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        fp = os.path.join(COVER_DIR, "%d%s" % (bid, ext))
        if os.path.exists(fp):
            return fp
    return ""


def save_cover(bid, data):
    if not data or len(data) < 800:
        return ""
    if not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[8:12] == b"WEBP"):
        return ""
    try:
        os.makedirs(COVER_DIR, exist_ok=True)
    except Exception:
        return ""
    ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else (".webp" if data[8:12] == b"WEBP" else ".jpg")
    fp = os.path.join(COVER_DIR, "%d%s" % (bid, ext))
    tmp = fp + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, fp)
    for other in (".jpg", ".jpeg", ".png", ".webp"):
        op = os.path.join(COVER_DIR, "%d%s" % (bid, other))
        if op != fp and os.path.exists(op):
            try:
                os.remove(op)
            except Exception:
                pass
    return fp


def http_get(url, headers=None, timeout=15, limit=4 << 20):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit)


def douban_candidates(title, author=""):
    """豆瓣读书搜索，返回按可信度排序的 (书名, 作者, 封面图URL)。"""
    u = "https://book.douban.com/j/subject_suggest?q=" + urllib.parse.quote(title or "")
    hd = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Referer": "https://book.douban.com/", "Accept": "application/json, */*"}
    try:
        raw = http_get(u, hd, 12)
        arr = json.loads(raw.decode("utf-8", "ignore"))
    except Exception as e:
        print("[cover] 豆瓣搜索失败:", e)
        return []
    if not isinstance(arr, list):
        return []
    out = []
    for it in arr:
        if not isinstance(it, dict):
            continue
        pic = (it.get("pic") or "").replace("\\/", "/")
        t = (it.get("title") or "").strip()
        a = (it.get("author_name") or "").strip()
        if not pic.startswith("http"):
            continue
        score = 0
        if t and title and (t == title or t.startswith(title) or title in t):
            score += 3
        if author and a and (a == author or a in author or author in a):
            score += 3
        out.append((score, t, a, pic))
    out.sort(key=lambda x: -x[0])
    return [(t, a, pic) for _s, t, a, pic in out]


DOUBAN_IMG_HOSTS = ("img1.doubanio.com", "img2.doubanio.com", "img3.doubanio.com",
                    "img9.doubanio.com", "img.doubanio.com")


def download_douban_cover(pic):
    """豆瓣图站需要 Referer，小图 /s/ 常 418，换 /l/ 再试。"""
    hd = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Referer": "https://book.douban.com/"}
    tries = []
    if "/s/public/" in pic:
        tries.append(pic.replace("/s/public/", "/l/public/"))
        tries.append(pic.replace("img3.doubanio.com", "img9.doubanio.com").replace("/s/public/", "/l/public/"))
    tries.append(pic)
    for u in tries:
        try:
            data = http_get(u, hd, 15)
            if data and len(data) > 800:
                return data
        except Exception:
            continue
    return b""


def fetch_any_cover(url):
    """下载任意图片链接当封面；豆瓣图站自动补 Referer。"""
    url = (url or "").strip()
    if not url.startswith("http"):
        return b""
    hd = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
    if "doubanio.com" in url or "douban.com" in url:
        hd["Referer"] = "https://book.douban.com/"
    try:
        return http_get(url, hd, 20)
    except Exception as e:
        print("[cover] 下载失败:", e)
        return b""


def search_cover_for(bid, title, author=""):
    for t, a, pic in douban_candidates(title, author)[:4]:
        data = download_douban_cover(pic)
        if data and save_cover(bid, data):
            return True
    return False


def cover_svg(title, author="", bid=0, w=300, h=420):
    """纯文本生成书封 SVG：渐变底 + 书名（自动折行）+ 作者。"""
    c1, c2 = COVER_PAIRS[(bid or 0) % len(COVER_PAIRS)]
    t = (title or "无名").strip()
    lines = wrap_cjk(t, 6)[:4]
    # 书名超过 4 行就缩到 5 字一行
    if len(t) > 24:
        lines = wrap_cjk(t, 8)[:4]
    fs = 30 if len(lines) <= 2 else (26 if len(lines) == 3 else 23)
    y0 = h * 0.34
    span = fs + 10
    txt = []
    for i, ln in enumerate(lines):
        txt.append('<text x="%d" y="%.1f" fill="#fff" font-size="%d" font-weight="700" '
                   'text-anchor="middle">%s</text>'
                   % (w // 2, y0 + i * span, fs, esc(ln)))
    au = (author or "").strip()
    au_txt = ('<text x="%d" y="%d" fill="#ffffffcc" font-size="15" text-anchor="middle">%s</text>'
              % (w // 2, h - 46, esc(au[:14]))) if au else ""
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
           '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
           '<stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs>'
           '<rect width="%d" height="%d" rx="14" fill="url(#g)"/>'
           '<rect x="10" y="10" width="%d" height="%d" rx="8" fill="none" stroke="#ffffff33"/>'
           '<rect x="%d" y="%d" width="%d" height="2.5" rx="1" fill="#ffffff55"/>'
           '%s%s</svg>'
           % (w, h, w, h, c1, c2, w, h, w - 20, h - 20,
              w // 2 - 26, int(h - 78), 52, "".join(txt), au_txt))
    return svg.encode("utf-8")


def dot(status):
    return "dot " + (status or "unread")


def tags_html(tags):
    out = []
    for t in [x for x in (tags or "").split(",") if x.strip()][:3]:
        out.append('<span class="tag">%s</span>' % esc(t.strip()))
    return "".join(out)


def hl(text, q):
    """搜索关键字高亮。"""
    t = esc(text or "")
    if not q:
        return t
    k = esc(q)
    if k.lower() not in t.lower():
        return t
    out, low, kl = [], t.lower(), k.lower()
    i = 0
    while True:
        j = low.find(kl, i)
        if j < 0:
            out.append(t[i:])
            break
        out.append(t[i:j])
        out.append("<mark>%s</mark>" % t[j:j + len(k)])
        i = j + len(k)
    return "".join(out)


def stat_card(label, value, unit, cls=""):
    return ('<div class="stat"><i>%s</i><b class="%s">%s</b><u>%s</u></div>'
            % (esc(label), cls, value, unit))


def nav(active, st, cfg):
    items = [("books", "/", "图书管理", st["all"]), ("dash", "/dash", "仪表盘", ""),
             ("cats", "/cats", "分类", len(st["cats"])), ("marks", "/marks", "笔记划线",
                                                         st.get("marks") or ""),
             ("stats", "/stats", "阅读统计", ""),
             ("trash", "/trash", "回收站", st.get("trash") or "")]
    out = ['<aside class="side" id="side"><div class="brand"><span class="logo">书</span>'
           '<div><b>%s</b><i>个人图书管理系统</i></div></div><nav class="sideNav">'
           % esc(cfg["site_title"])]
    for key, href, label, badge in items:
        out.append('<a href="%s" class="%s"><span>%s</span>%s</a>'
                   % (href, "on" if key == active else "", label,
                      ("<em>%s</em>" % badge) if badge != "" else ""))
    out.append('</nav><div class="sideFoot"><div class="usage"><span>存储占用</span><b>%s</b></div>'
               '<div class="ubar"><i style="width:%d%%"></i></div><small>v3.0 · SQLite</small></div></aside>'
               % (human(st["chars"] * 2), min(100, max(2, int(st["chars"] / 50000 * 100)))))
    return "".join(out)


def human(n):
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.1f KB" % (n / 1024.0)
    return "%.1f MB" % (n / 1048576.0)


def wan(chars):
    return "%.1f万" % (chars / 10000.0) if chars >= 10000 else "%d" % chars


UP_JS = """<script>
(function(){
  function boot(){
  var keyEl=document.getElementById("upKey"), catEl=document.getElementById("upCat"),
      fEl=document.getElementById("upFile"), list=document.getElementById("upList"),
      pick=document.getElementById("upPick"), drop=document.getElementById("upDrop"),
      all=document.getElementById("upAll"), allTxt=document.getElementById("upAllTxt"),
      allBar=document.getElementById("upAllBar"), sum=document.getElementById("upSum");
  if(!keyEl) return;
  try{ keyEl.value = localStorage.getItem("nm_key") || ""; }catch(e){}
  keyEl.addEventListener("change", function(){
    try{ localStorage.setItem("nm_key", keyEl.value.trim()); }catch(e){}
  });

  var queue=[], busy=false, total=0, done=0, okN=0, failN=0, okCat={};

  function row(name){
    var d=document.createElement("div");
    d.className="upItem";
    d.innerHTML='<div class="upTop"><div class="upName"></div><span class="upCat">待上传</span></div>'
      +'<div class="upBar"><i></i></div><div class="upSt">排队中</div>';
    d.querySelector(".upName").textContent=name;
    list.appendChild(d);
    return d;
  }
  function updAll(){
    total = total || 0;
    all.hidden = false;
    allTxt.textContent = done + " / " + total;
    allBar.style.width = total ? (done*100/total) + "%" : "0%";
  }
  function finish(){
    var parts=[];
    if(okN) parts.push("成功 "+okN+" 本");
    if(failN) parts.push("失败 "+failN+" 本");
    var cl=[];
    for(var k in okCat){ cl.push(k+" "+okCat[k]); }
    sum.hidden=false;
    sum.className = "upSum" + (failN ? " warn" : "");
    sum.textContent = "全部结束 · " + (parts.join(" · ") || "没有文件")
      + (cl.length ? (" ｜ 自动分类：" + cl.join("、")) : "");
    busy=false; done=total; updAll();
  }
  function send(file, cb){
    var key=(keyEl.value||"").trim();
    if(!key){ alert("先填管理密码"); cb(); return; }
    var cat=(catEl.value||"").trim();
    var d=row(file.name), bar=d.querySelector(".upBar i"), st=d.querySelector(".upSt"),
        ct=d.querySelector(".upCat");
    var xhr=new XMLHttpRequest();
    xhr.open("POST","/api/import?key="+encodeURIComponent(key)
      +"&filename="+encodeURIComponent(file.name)
      +"&cat="+encodeURIComponent(cat));
    xhr.upload.onprogress=function(e){
      if(e.lengthComputable){ bar.style.width=(e.loaded*100/e.total)+"%"; st.textContent="上传中 "+(e.loaded*100/e.total).toFixed(0)+"%"; }
    };
    xhr.upload.onload=function(){ st.textContent="服务器解析中…"; };
    xhr.onload=function(){
      bar.style.width="100%";
      var ok=false, msg="HTTP "+xhr.status, j=null;
      try{ j=JSON.parse(xhr.responseText); }catch(e){}
      if(j){
        ok=!!j.ok;
        msg = ok ? ((j.author ? j.author+" · " : "")+(j.chapters||0)+" 章 · "+(j.chars||0)+" 字")
                 : (xhr.status===403 ? "密码不对"
                                     : (j.err||j.error||("HTTP "+xhr.status)));
      if(!ok && xhr.status===403){
        try{ localStorage.removeItem("nm_key"); }catch(e){}
        keyEl.value=""; keyEl.focus();
        msg = "密码不对（已清掉旧口令，重新输入管理密码）";
      }
      }
      d.className="upItem "+(ok?"ok":"fail");
      st.textContent = ok ? ("✓ 入库 · "+msg) : ("✗ "+msg);
      if(ok){
        okN++;
        if(j.cat){ ct.textContent=j.cat; ct.classList.add("on"); okCat[j.cat]=(okCat[j.cat]||0)+1; }
        if(j.title) d.querySelector(".upName").textContent = j.title;
      } else { failN++; }
      cb();
    };
    xhr.onerror=function(){ d.className="upItem fail"; st.textContent="✗ 网络错误"; failN++; cb(); };
    xhr.send(file);
  }
  function pump(){
    if(busy) return;
    var f=queue.shift();
    if(!f){ if(total && done>=total) finish(); return; }
    busy=true;
    send(f, function(){ busy=false; done++; updAll(); pump(); });
  }
  function addFiles(files){
    var n=0;
    for(var i=0;i<files.length;i++){
      var f=files[i];
      if(!f) continue;
      if(!/[.](txt|md|zip)$/i.test(f.name||"")){ continue; }
      queue.push(f); total++; n++;
    }
    if(!n){ sum.hidden=false; sum.className="upSum warn"; sum.textContent="没有可上传的 .txt / .md / .zip 文件"; return; }
    updAll();
    pump();
  }
  fEl.addEventListener("change",function(){ addFiles(fEl.files); fEl.value=""; });
  ["dragenter","dragover"].forEach(function(t){
    drop.addEventListener(t,function(e){ e.preventDefault(); drop.classList.add("on"); }); });
  ["dragleave","drop"].forEach(function(t){
    drop.addEventListener(t,function(e){ e.preventDefault(); drop.classList.remove("on"); }); });
  drop.addEventListener("drop",function(e){
    if(e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
</script>"""


def view_up(cfg):
    dl = "".join('<option value="%s">' % esc(x) for x in CATS)
    body = ('<section class="view on"><div class="panel pad">'
            '<h2>批量导入</h2>'
            '<p class="hint">支持 <b>.txt</b> / <b>.md</b> / <b>.zip</b>，可一次多选，'
            '按顺序一本一本上传，每本独立进度条。<b>分类留空即自动识别</b>'
            '（先看文件名里的 <code>[分类]</code> 前缀，再看关键词，最后扫正文前 3000 字）。</p>'
            '<div class="upForm">'
            '<label class="upRow"><span>密码</span>'
            '<input id="upKey" type="password" placeholder="管理密码" autocomplete="off"></label>'
            '<label class="upRow"><span>分类</span>'
            '<input id="upCat" list="catList" placeholder="留空 = 自动分类" autocomplete="off">'
            '<datalist id="catList">%s</datalist></label>'
            '</div>'
            '<div class="upDrop" id="upDrop"><b>把文件拖到这里</b><span>或者</span>'
            '<label class="btn primary pickLabel" id="upPick" for="upFile">选择多个文件</label>'
            '<input id="upFile" type="file" accept=".txt,.md,.zip,text/plain" multiple hidden></div>'
            '<div class="upAll" id="upAll" hidden><div class="upAllTop"><span>总进度</span>'
            '<b id="upAllTxt">0 / 0</b></div><div class="upBar big"><i id="upAllBar"></i></div></div>'
            '<div class="upSum" id="upSum" hidden></div>'
            '<div class="upList" id="upList"></div>'
            '</div></section>' % dl)
    return page("导入", body, cfg, active="books", extra=UP_JS)


def page(title, body, cfg, active="books", st=None, extra="", body_cls="", tab="books", q=""):
    st = st or stats()
    tabs = [("books", "/", "图书"), ("dash", "/dash", "仪表盘"), ("cats", "/cats", "分类"),
            ("stats", "/stats", "统计"), ("marks", "/marks", "笔记"), ("trash", "/trash", "回收站")]
    tb = "".join('<a href="%s" class="%s"><span>%s</span></a>' % (h, "on" if k == tab else "", l)
                 for k, h, l in tabs)
    head = """<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f4f5f7"><title>%(title)s · %(site)s</title>
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon-192.png">
<script>try{var h=document.documentElement;if(localStorage.getItem("nm_theme")==="dark")h.dataset.theme="dark";var pp=localStorage.getItem("nm_paper");if(pp)h.dataset.paper=pp;var ff=localStorage.getItem("nm_ff");if(ff)h.dataset.ff=ff;}catch(e){}</script>
<link rel="stylesheet" href="/static/style.css?v=%(v)s">%(extra)s</head>
<body class="%(cls)s">""" % {"title": esc(title), "site": esc(cfg["site_title"]),
                              "v": V_CSS, "extra": extra, "cls": body_cls}
    return (head + '<div class="app">' + nav(active, st, cfg) +
            '<div class="main"><header class="top"><div class="topRow">'
            '<button class="ic" id="btnNav">☰</button><h1>%(title)s</h1><span class="spacer"></span>'
            '<a class="ic" href="/up" title="导入小说">＋</a>'
            '<button class="ic" id="btnTheme" title="切换主题">◐</button>'
            '<span class="ava">F</span></div>%(search)s</header>'
            '<div class="scroll" id="scroll">' % {"title": esc(title), "search": search_row(cfg, q)}
            + body + '</div><nav class="tabbar">' + tb + '</nav></div>'
            '<div class="scrim" id="scrim"></div><div class="toast" id="toast"></div>'
            '<script src="/static/app.js?v=%s" defer></script></body></html>' % V_JS).encode("utf-8")


def search_row(cfg, q=""):
    return ('<div class="searchRow"><form class="search" method="get" action="/">%s'
            '<input name="q" placeholder="搜索书名 / 作者 / 标签" value="%s" autocomplete="off">'
            '<kbd>/</kbd></form><div class="seg">'
            '<a href="#" data-mode="table" class="on">表格</a>'
            '<a href="#" data-mode="cards">卡片</a></div></div>' % (ICONS["search"], esc(q)))


# ---------------------------------------------------------------- 视图
def view_list(q, f, sort, desc, page_no, cfg, vw="grid"):
    per = cfg["per_page"]
    rows, total, pages, page_no = list_books(q, f, sort, desc, page_no, per)
    st = stats()
    qs = urllib.parse.urlencode({"q": q, "f": f, "sort": sort, "d": "1" if desc else "0"})

    def sort_link(col, label, cls=""):
        nd = "0" if (sort == col and desc) else "1"
        arrow = (" ↓" if desc else " ↑") if sort == col else ""
        return ('<a class="%s" href="/?%s&d=%s" data-sort="%s">%s%s</a>'
                % (cls, urllib.parse.urlencode({"q": q, "f": f, "sort": col}), nd, col, label, arrow))

    body = ['<section class="view on" data-v="%s">' % vw]
    if q:
        body.append('<a class="ftHint" href="/full?q=%s">⌕ 在全部书的正文里搜「%s」</a>'
                    % (urllib.parse.quote(q), esc(q)))
    body.append('<div class="stats">%s%s%s%s</div>' % (
        stat_card("全部藏书", st["all"], "本"),
        stat_card("在读", st["by"].get("reading", 0), "本", "c-blue"),
        stat_card("未读", st["by"].get("unread", 0), "本", "c-dim"),
        stat_card("总字数", (round(st["chars"] / 10000.0, 1) if st["chars"] >= 10000 else st["chars"]),
                  "万" if st["chars"] >= 10000 else "字")))
    chips = [("all", "全部"), ("reading", "在读"), ("unread", "未读"), ("done", "读完")]
    body.append('<div class="chips">' + "".join(
        '<a href="/?%s" class="%s">%s</a>'
        % (urllib.parse.urlencode({"q": q, "f": k, "sort": sort, "d": "1" if desc else "0"}),
           "on" if f == k else "", label) for k, label in chips) + '</div>')

    body.append('<div class="sortbar">'
                '<span class="sbLabel">排序</span>'
                '%s%s%s%s'
                '<button class="btn ghost sm" id="cvAll" type="button">批量搜封面</button>'
                '<label class="ckAllWrap"><input type="checkbox" id="ckAll"> 全选</label>'
                '</div>'
                % (sort_link("title", "书名"), sort_link("chapters", "章数"),
                   sort_link("chars", "字数"), sort_link("updated", "更新")))

    body.append('<div class="panel"><div class="cards">')
    if not rows:
        body.append('<div class="emptyTd">书库还是空的</div>')
    for b in rows:
        body.append(
            '<a class="cardRow" href="/book/%d">'
            '<div class="thumb"><img src="/cover/%d" alt="" loading="lazy"></div>'
            '<div class="cardMid">'
            '<div class="t"><span class="%s"></span><b>%s</b></div>'
            '<div class="m">%s · %s</div>'
            '<div class="m2">%d 章 · %s字 · %s</div>'
            '<div class="p"><span class="pbar"><i style="width:%d%%"></i></span><span>%d%%</span></div>'
            '</div><span class="tag">%s</span>'
            '<input type="checkbox" class="ckRow ckCard" value="%d" onclick="event.stopPropagation()"></a>'
            % (b["id"], b["id"], dot(b["status"]), hl(b["title"], q),
               esc(b["author"] or "佚名"), esc(b["cat"] or "未分类"),
               b["chapters"], wan(b["chars"]), esc((b["updated"] or "")[5:]),
               b["progress"], b["progress"], STATUS.get(b["status"], "未读"), b["id"]))
    body.append('</div></div>')

    pgs = ['<div class="pager">']
    pgs.append('<a class="%s" href="/?%s&p=%d">‹</a>' % ("off" if page_no <= 1 else "",
                                                          urllib.parse.urlencode({"q": q, "f": f, "sort": sort,
                                                                                  "d": "1" if desc else "0"}),
                                                          max(1, page_no - 1)))
    for i in range(1, pages + 1):
        if pages > 7 and i > 2 and i < pages - 1 and abs(i - page_no) > 1:
            if i == 3:
                pgs.append("<span>…</span>")
            continue
        pgs.append('<a class="%s" href="/?%s&p=%d">%d</a>'
                   % ("on" if i == page_no else "",
                      urllib.parse.urlencode({"q": q, "f": f, "sort": sort, "d": "1" if desc else "0"}), i, i))
    pgs.append('<a class="%s" href="/?%s&p=%d">›</a>'
               % ("off" if page_no >= pages else "",
                  urllib.parse.urlencode({"q": q, "f": f, "sort": sort, "d": "1" if desc else "0"}),
                  min(pages, page_no + 1)))
    pgs.append('<span>共 %d 条</span>'
               '<select id="perPage" class="selSm" title="每页条数">%s</select></div></section>'
               % (total, "".join('<option value="%d" %s>%d/页</option>'
                                 % (n, "selected" if n == per else "", n) for n in (12, 24, 48, 96))))
    body.append("".join(pgs))
    body.append('<div class="bulk" id="bulk"><span>已选 <b id="bulkN">0</b> 本</span>'
                '<a class="btn primary sm" id="bulkTxt" href="#">下载 TXT</a><a class="btn ghost sm" id="bulkDl" href="#">打包 zip</a>'
                '<button class="btn ghost sm" id="bulkCat" type="button">改分类</button><button class="btn danger sm" id="bulkDel" type="button">删除</button><button class="btn ghost sm" id="bulkNone" type="button">取消</button></div>')
    return page("图书管理", "".join(body), cfg, "books", st, q=q)


def view_dash(cfg):
    st = stats()
    body = ['<section class="view on"><div class="stats">%s%s%s%s</div>'
            % (stat_card("藏书", st["all"], "本"),
               stat_card("在读", st["by"].get("reading", 0), "本", "c-blue"),
               stat_card("总章节", st["chapters"], "章"),
               stat_card("总字数", (round(st["chars"] / 10000.0, 1) if st["chars"] >= 10000 else st["chars"]),
                         "万" if st["chars"] >= 10000 else "字"))]
    body.append('<div class="panel pad"><h2>最近更新</h2><ul class="recent">')
    if not st["recent"]:
        body.append('<li><span class="dot unread"></span><b>还没有书</b><span>—</span></li>')
    for b in st["recent"]:
        body.append('<li><a href="/book/%d" style="display:flex;flex:1;gap:10px;align-items:center">'
                    '<span class="%s"></span><b>%s</b><span>%s · %s</span></a></li>'
                    % (b["id"], dot(b["status"]), esc(b["title"]), esc(b["author"] or "佚名"),
                       esc((b["updated"] or "")[5:])))
    body.append('</ul></div>')
    body.append('<div class="panel pad"><h2>分类分布</h2><div class="bars">')
    mx = max([c["n"] for c in st["cats"]] or [1])
    for c in st["cats"]:
        body.append('<a class="barRow" href="/?%s"><em>%s</em><span class="pbar"><i style="width:%d%%"></i></span><b>%d</b></a>'
                    % (urllib.parse.urlencode({"q": c["cat"]}), esc(c["cat"]), c["n"] * 100 // mx, c["n"]))
    if not st["cats"]:
        body.append('<div class="emptyTd">暂无数据</div>')
    body.append('</div></div>')
    mx7 = max([c[1] for c in st["series"]] or [1]) or 1
    body.append('<div class="panel pad"><h2>近 7 天更新</h2><div class="chart">%s</div></div></div>'
                % "".join('<div class="cBar"><i style="height:%d%%"></i><b>%d</b><em>%s</em></div>'
                          % (max(4, int(c[1] * 100 / mx7)), c[1], c[0]) for c in st["series"]))
    if st["tags"]:
        body.append('<div class="panel pad"><h2>标签云</h2><div class="cloud">%s</div></div>'
                    % "".join('<a href="/?q=%s" class="tag" style="font-size:%dpx">%s<em>%d</em></a>'
                              % (urllib.parse.quote(t), 11 + min(4, n), esc(t), n)
                              for t, n in st["tags"]))
    body.append('</section>')
    return page("仪表盘", "".join(body), cfg, "dash", st, tab="dash")


def view_stats(cfg):
    st = stats()
    rs = read_stats(45)
    body = ['<section class="view on">']
    body.append('<div class="vhead"><h1>阅读统计</h1></div>')
    body.append('<div class="stats">%s%s%s%s</div>' % (
        stat_card("累计阅读", (round(rs["total"] / 10000.0, 1) if rs["total"] >= 10000 else rs["total"]),
                  "万字" if rs["total"] >= 10000 else "字", "c-blue"),
        stat_card("连续天数", rs["streak"], "天"),
        stat_card("有记录天数", rs["active_days"], "天"),
        stat_card("本月读完", rs["done_month"], "本")))
    # 近 45 天上色块
    m = dict((r["day"], r["c"]) for r in rs["days"])
    mx = max([v for v in m.values()] or [1])
    cells = []
    for i in range(44, -1, -1):
        d = time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400))
        v = m.get(d, 0)
        lvl = 0 if not v else min(4, 1 + int(v * 3.0 / mx))
        cells.append('<span class="heat l%d" title="%s · %s 字"></span>' % (lvl, d[5:], human(v) if v else "0"))
    body.append('<div class="panel pad"><h3 class="sectT">最近 45 天</h3>'
                '<div class="heatmap">%s</div>'
                '<p class="hint">颜色越深，那天读得越多；空白是没打开过。</p></div>' % "".join(cells))
    if rs["top"]:
        rows = "".join('<div class="srow"><span class="sname">%s</span>'
                       '<span class="pbar"><i style="width:%d%%"></i></span>'
                       '<span class="mono">%s</span></div>'
                       % (esc(t["title"]), int(t["c"] * 100.0 / mx), human(t["c"]))
                       for t in rs["top"])
        body.append('<div class="panel pad"><h3 class="sectT">读得最多的书</h3>%s</div>' % rows)
    else:
        body.append('<div class="panel pad"><p class="hint">还没有阅读记录，随便点开一章看看就有了。</p></div>')
    body.append('</section>')
    return page("阅读统计", "".join(body), cfg, "stats", st)


def view_trash(cfg):
    st = stats()
    rows, total, pages, pno = list_books(deleted=True, per=200)
    body = ['<section class="view on">']
    body.append('<div class="vhead"><h1>回收站</h1><span class="mono">%d 本</span></div>' % total)
    if not rows:
        body.append('<div class="panel pad"><p class="hint">回收站是空的。删掉的书会在这里留 30 天，随时能救回来。</p></div>')
    else:
        body.append('<div class="panel pad"><p class="hint">删掉的书会在这里留 30 天，过期自动清掉。</p>')
        for b in rows:
            body.append('<div class="trow" data-bid="%d">'
                        '<div class="tinfo"><b>%s</b><span>%s · %d 章 · %s字</span></div>'
                        '<div class="tbody">%s</div>'
                        '<button class="btn ghost sm tRes" type="button" data-bid="%d">恢复</button>'
                        '<button class="btn danger sm tPur" type="button" data-bid="%d">彻底删除</button>'
                        '</div>'
                        % (b["id"], esc(b["title"]), esc(b["author"] or "佚名"),
                           b["chapters"], wan(b["chars"]),
                           esc((b.get("deleted_at") or "").replace(" ", " ")[:16]), b["id"], b["id"]))
        body.append('</div>')
    body.append('</section>')
    return page("回收站", "".join(body), cfg, "trash", st)


def view_cats(cfg):
    st = stats()
    have = {c["cat"]: c["n"] for c in st["cats"]}
    body = ['<section class="view on">']
    for gname, cs in CAT_GROUPS:
        body.append('<div class="panel pad"><h2>%s</h2><div class="catGrid">' % gname)
        for c in cs:
            n = have.get(c, 0)
            if n:
                body.append('<a class="catChip" href="/?%s"><b>%s</b><i>%d 本</i></a>'
                            % (urllib.parse.urlencode({"q": c}), esc(c), n))
            else:
                body.append('<span class="catChip off"><b>%s</b><i>0 本</i></span>' % esc(c))
        body.append("</div></div>")
    extra = [(k, v) for k, v in have.items() if k not in CATS]
    if extra:
        body.append('<div class="panel pad"><h2>其它</h2><div class="catGrid">')
        for k, v in sorted(extra, key=lambda x: -x[1]):
            body.append('<a class="catChip" href="/?%s"><b>%s</b><i>%d 本</i></a>'
                        % (urllib.parse.urlencode({"q": k}), esc(k), v))
        body.append("</div></div>")
    body.append("</section>")
    return page("分类", "".join(body), cfg, "cats", st, tab="cats")


def view_book(bid, cfg):
    b, chs = get_book(bid)
    st = stats()
    if not b:
        return page("404", '<section class="view on"><div class="panel pad"><h2>没有这本书</h2>'
                           '<p class="hint"><a href="/">回书架</a></p></div></section>', cfg), 404
    body = ['<section class="view on">']
    body.append('<div class="bhero"><div class="bcv"><img id="bcover" src="/cover/%d" alt=""></div><div class="bi">'
                '<h2>%s</h2><p class="sub">%s · %s</p>'
                '<p class="meta">%d 章 · %s字 · 进度 %d%%</p>'
                '<div class="pbar"><i style="width:%d%%"></i></div>'
                '<div class="sheetActs"><a class="btn primary" href="/read/%d/%d?resume=1">%s</a>'
                '<a class="btn ghost" href="/dl/%d">下载 TXT</a>'
                '<button class="btn ghost" id="bcvBtn" type="button" data-bid="%d">换封面</button>'
                '<button class="btn ghost" id="dlOff" type="button" data-bid="%d" data-n="%d">缓存离线</button>'
                '</div>'
                '<div class="cvPanel" id="cvPanel" data-bid="%d">'
                '<button class="btn primary sm" id="cvAuto" type="button">从豆瓣搜</button>'
                '<input id="cvUrl" type="url" placeholder="粘贴图片链接 https://...">'
                '<button class="btn ghost sm" id="cvUrlGo" type="button">用这个链接</button>'
                '<label class="btn ghost sm pickLabel">上传图片<input id="cvFile" type="file" accept="image/*" hidden></label>'
                '<button class="btn ghost sm" id="cvClose" type="button">收起</button>'
                '<p class="hint">豆瓣搜不到时（番茄/起点独家连载），可以自己找图存下来上传，或者直接粘图片链接。</p>'
                '</div></div></div>'
                % (bid, esc(b["title"]),
                   esc(b["author"] or "佚名"), esc(b["cat"] or "未分类"),
                   b["chapters"], wan(b["chars"]), b["progress"], b["progress"],
                   bid, b["last_idx"], "继续阅读" if b["progress"] else "开始阅读",
                   bid, bid, bid, len(chs), bid))
    if b.get("intro"):
        body.append('<div class="panel pad"><h2>简介</h2><p class="intro">%s</p></div>' % esc(b["intro"]))
    body.append('<div class="panel pad"><h2>目录 · %d 章</h2><div class="toc">' % len(chs))
    for c in chs:
        cls = " on" if c["idx"] == b["last_idx"] else ""
        body.append('<a class="%s" href="/read/%d/%d"><i>%d</i>%s</a>'
                    % (cls.strip(), bid, c["idx"], c["idx"] + 1, esc(c["title"])))
    body.append('</div></div>')
    mks = book_marks(bid)
    if mks:
        body.append('<h2 class="sectT">我的标记 · %d</h2><div class="mkList">' % len(mks))
        for m in mks:
            body.append('<div class="mkItem c-%s"><span class="mkDot"></span>'
                        '<div class="mkBody"><a class="mkText" href="/read/%d/%d">%s</a>%s</div>'
                        '<button class="mkDel" data-mid="%d" type="button">✕</button></div>'
                        % (m["color"] or "y", bid, m["idx"],
                           hl(m["text"] or ("书签 · 第%d章" % (m["idx"] + 1)), ""),
                           ('<div class="mkNote">%s</div>' % esc(m["note"])) if m["note"] else "",
                           m["id"]))
        body.append('</div>')
    body.append('</div></section>')
    return page(b["title"], "".join(body), cfg, "books", st), 200


def view_read(bid, idx, cfg, fs=17, lh=1.95, rs=0):
    ch, n = get_chapter(bid, idx)
    b, chs = get_book(bid)
    if not ch or not b:
        return page("404", '<section class="view on"><div class="panel pad"><h2>章节不存在</h2>'
                           '</div></section>', cfg), 404
    try:
        par0 = int(b.get("last_para") or 0) if b.get("last_idx") == idx else 0
    except Exception:
        par0 = 0
    save_progress(bid, idx)
    mkmap = marks_by_para(bid, idx)
    nmk = sum(len(v) for v in mkmap.values())
    prev_href = ("/read/%d/%d" % (bid, idx - 1)) if idx > 0 else ""
    next_href = ("/read/%d/%d" % (bid, idx + 1)) if idx + 1 < n else ""
    prev_l = ('<a class="pn" href="%s">‹ 上一章</a>' % prev_href) if prev_href else '<span class="pn off">‹ 上一章</span>'
    next_l = ('<a class="pn" href="%s">下一章 ›</a>' % next_href) if next_href else '<span class="pn off">下一章 ›</span>'
    txt = render_paras(ch["content"], mkmap)
    try:
        read_tick(bid, idx, len(re.sub(r"\s", "", ch["content"] or "")))
    except Exception:
        pass
    body = ['<section class="view on">',
            '<div class="rhead"><a class="btn ghost sm" href="/book/%d">%s %s</a>'
            '<span class="spacer"></span>'
            '<a class="btn ghost sm" href="/full?bid=%d" title="本书内搜">⌕</a>'
            '<button class="btn ghost sm" id="mkBtn" type="button" data-bid="%d" data-idx="%d">标记%s</button>'
            '<button class="btn ghost sm" id="tocBtn" type="button">目录</button>'
            '<a class="btn ghost sm" href="#" id="fsBtn">Aa</a></div>'
            % (bid, ICONS["back"], esc(b["title"]), bid, bid, idx,
               (" %d" % nmk) if nmk else ""),
            '<div class="wordwrap"><h2 class="ctitle">%s</h2>'
            '<div class="rbody" id="rbody" data-bid="%d" data-idx="%d" data-para="%d" data-rs="%d"'
            ' style="--fs:%dpx;--lh:%s">%s</div>'
            % (esc(ch["title"]), bid, idx, par0, rs, fs, lh, txt),
            '<div class="rnav">%s<span class="rp"><i style="width:%d%%"></i></span>%s</div></div>'
            % (prev_l, int(round((idx + 1) * 100.0 / n)), next_l),
            '<div class="chend">%s%s</div>' % (prev_l, next_l),
            '<div class="panel panel-fs" id="fsPanel"><div class="fsRow"><span>字号</span>'
            '<input type="range" id="fsRange" min="14" max="24" step="1" value="%d">'
            '<b id="fsVal">%d</b></div>'
            '<div class="fsRow"><span>行距</span><input type="range" id="lhRange" min="1.5" max="2.6" step="0.05" value="%s">'
            '<b id="lhVal">%s</b></div>'
            '<div class="fsRow"><span>背景</span><div class="papers">'
            '<button type="button" class="pp on" data-paper="p0" style="background:#f4f5f7"></button>'
            '<button type="button" class="pp" data-paper="p1" style="background:#f3ecdd"></button>'
            '<button type="button" class="pp" data-paper="p2" style="background:#e3ece1"></button>'
            '<button type="button" class="pp" data-paper="p3" style="background:#15171c"></button>'
            '</div></div>'
            '<div class="fsRow"><span>字体</span><div class="ffs">'
            '<button type="button" class="ff on" data-ff="sans">默认</button>'
            '<button type="button" class="ff" data-ff="serif">宋体</button>'
            '<button type="button" class="ff" data-ff="kai">楷体</button>'
            '</div></div></div>' % (fs, fs, lh, lh),
            '<div class="tz tz-l" data-href="%s"></div><div class="tz tz-r" data-href="%s"></div>' % (prev_href, next_href),
            '<div class="tocDrawer" id="tocDrawer"><div class="tdHead"><b>目录 · %d 章</b>'
            '<button class="ic" id="tocClose" type="button">✕</button></div><div class="tdList">%s</div></div>'
            % (n, "".join('<a class="%s" href="/read/%d/%d"><i>%d</i><span>%s</span></a>'
                          % ("on" if c2["idx"] == idx else "", bid, c2["idx"], c2["idx"] + 1, esc(c2["title"]))
                          for c2 in chs)),
            # 选中文字后浮出的操作条
            '<div class="selBar" id="selBar">'
            '<button class="sb" data-op="line" data-color="y" type="button"><i class="sw c-y"></i>划线</button>'
            '<button class="sb" data-op="line" data-color="g" type="button"><i class="sw c-g"></i>绿</button>'
            '<button class="sb" data-op="line" data-color="b" type="button"><i class="sw c-b"></i>蓝</button>'
            '<button class="sb" data-op="line" data-color="p" type="button"><i class="sw c-p"></i>粉</button>'
            '<button class="sb" data-op="note" type="button">✎ 笔记</button>'
            '<button class="sb" data-op="bookmark" type="button">🔖 书签</button>'
            '<button class="sb dim" data-op="cancel" type="button">取消</button></div>'
            # 笔记查看/编辑浮层
            '<div class="noteBox" id="noteBox"><div class="nbIn">'
            '<div class="nbHead"><b id="nbTitle">笔记</b><button class="ic" id="nbClose" type="button">✕</button></div>'
            '<div class="nbQuote" id="nbQuote"></div>'
            '<textarea id="nbText" placeholder="写点什么…（留空只保存划线）"></textarea>'
            '<div class="nbFoot"><button class="btn ghost" id="nbDel" type="button">删除</button>'
            '<button class="btn primary" id="nbSave" type="button">保存</button></div>'
            '</div></div>',
            '</section>']
    return page(ch["title"], "".join(body), cfg, "books", body_cls="reading"), 200


def search_box(action, q, ph="搜索正文…"):
    return ('<div class="searchRow"><form class="search" method="get" action="%s">%s'
            '<input name="q" placeholder="%s" value="%s" autocomplete="off">'
            '<kbd>/</kbd></form></div>' % (action, ICONS["search"], esc(ph), esc(q)))


def view_full(q, bid, cfg):
    """全书库 / 单本的正文全文搜索。"""
    st = stats()
    b = None
    if bid:
        b, _ = get_book(bid)
    rows, n = search_text(q, bid) if q else ([], 0)
    body = ['<section class="view on">']
    if b:
        body.append('<div class="panel pad"><h2>在《%s》里搜正文</h2>%s</div>'
                    % (esc(b["title"]), search_box("/full?bid=%d" % bid, q)))
    else:
        body.append('<div class="panel pad"><h2>正文搜索</h2>%s'
                    '<p class="hint">全文检索，中文按字匹配；只搜到章节，点进去就是那一章。</p></div>'
                    % search_box("/full", q))
    if q:
        body.append('<div class="panel pad"><h2>命中 %d 章</h2>' % n)
        if not rows:
            body.append('<p class="hint">没找到「%s」。换个词试试；只想搜书名的话回书架页搜。</p>'
                        % esc(q))
        else:
            body.append('<div class="fres">')
            for r in rows:
                body.append('<a class="fItem" href="/read/%d/%d">'
                            '<div class="fTop"><b>%s</b><span>· %s</span></div>'
                            '<div class="fText">%s</div></a>'
                            % (r["book_id"], r["idx"], esc(r["title"]), esc(r["ctitle"]),
                               hl(r["snip"], q)))
            body.append('</div>')
        body.append('</div>')
    body.append('</section>')
    return page("正文搜索", "".join(body), cfg, "books", st, tab="books", q=q)


def view_marks(cfg, bid=None):
    """我的划线 / 笔记 / 书签。"""
    st = stats()
    ms = book_marks(bid)
    body = ['<section class="view on">']
    if not ms:
        body.append('<div class="panel pad"><h2>还没有划线和笔记</h2>'
                    '<p class="hint">在阅读页里按住一句话选中它，页面上会浮出「划线 / 笔记 / 书签」；'
                    '存下来的东西都汇总在这里。</p></div></section>')
        return page("笔记划线", "".join(body), cfg, "marks", st, tab="marks")
    groups = {}
    for m in ms:
        groups.setdefault((m["book_id"], m["idx"]), []).append(m)
    body.append('<div class="panel pad"><h2>共 %d 条</h2>'
                '<p class="hint">点标题跳回原文那一章，右边的 ✕ 是删除。</p></div>' % len(ms))
    body.append('<div class="mkList">')
    for (bk, idx), items in groups.items():
        b, _ = get_book(bk)
        if not b:
            continue
        body.append('<div class="mkGroup"><div class="mkHead"><a href="/read/%d/%d">'
                    '<b>%s</b><i>· %s</i></a></div>'
                    % (bk, idx, esc(b["title"]),
                       esc(items[0].get("ctitle") or ("第%d章" % (idx + 1)))))
        for m in items:
            body.append('<div class="mkItem c-%s"><span class="mkDot"></span>'
                        '<div class="mkBody"><div class="mkText">%s</div>%s</div>'
                        '<button class="mkDel" data-mid="%d" type="button" title="删除">✕</button></div>'
                        % (m["color"] or "y", hl(m["text"] or "(本章书签)", ""),
                           ('<div class="mkNote">%s</div>' % esc(m["note"])) if m["note"] else "",
                           m["id"]))
        body.append('</div>')
    body.append('</div></section>')
    return page("笔记划线", "".join(body), cfg, "marks", st, tab="marks")


# ---------------------------------------------------------------- 静态资源版本
def _ver(fn):
    try:
        return str(int(os.path.getmtime(os.path.join(STATIC, fn))))
    except Exception:
        return "0"


SW_JS = r"""const C='nm-v4';
const PAGE=/^\/(read|book|full|stats|dash|cats|marks|trash)\/?/;
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const ks=await caches.keys();
  await Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
function put(req,res){ if(res&&res.ok&&res.type==='basic'){ const cp=res.clone(); caches.open(C).then(c=>c.put(req,cp)); } return res; }
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const u=new URL(req.url);
  if(u.origin!==location.origin) return;
  const isStatic=u.pathname.startsWith('/static/')||u.pathname.startsWith('/icon-');
  const isPage=PAGE.test(u.pathname)||u.pathname==='/';
  if(isStatic){
    e.respondWith(caches.open(C).then(c=>c.match(req).then(r=>r||fetch(req).then(res=>put(req,res)))));
    return;
  }
  if(isPage){
    e.respondWith(fetch(req).then(res=>put(req,res)).catch(()=>caches.open(C).then(c=>c.match(req)).then(r=>r||new Response(
      '<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px/1.8 system-ui;padding:30px">'
      +'<h3>现在没网</h3><p>这一页还没缓存过。有网的章节会自动存下来，下次断网也能看。</p>',
      {headers:{'Content-Type':'text/html; charset=utf-8'}}))));
  }
});"""

V_CSS = _ver("style.css")
V_JS = _ver("app.js")


# ---------------------------------------------------------------- HTTP
class H(BaseHTTPRequestHandler):
    server_version = "NovelShelf/3.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---- 工具
    def send_body(self, code, body, ctype="text/html; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        h = {"Content-Type": ctype, "Cache-Control": "no-cache",
             "X-Content-Type-Options": "nosniff"}
        accept = self.headers.get("Accept-Encoding", "")
        if len(body) > 1200 and "gzip" in accept and ctype.startswith(("text", "application/json", "application/javascript")):
            body = gzip.compress(body, 6)
            h["Content-Encoding"] = "gzip"
        h["Content-Length"] = str(len(body))
        if headers:
            h.update(headers)
        self.send_response(code)
        for k, v in h.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def json(self, obj, code=200):
        self.send_body(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def cfg(self):
        return cfg()

    @staticmethod
    def _norm_key(k):
        return (k or "").strip().rstrip("-_").lower()

    def key_ok(self, qs):
        """管理密码：优先认 site_pass（大小写敏感），旧 api_key 仍兼容。"""
        got = (qs.get("key", [""])[0] or "").strip()
        if not got:
            return False
        pwd = (self.cfg().get("site_pass") or "").strip()
        if pwd and got == pwd:
            return True
        api = (self.cfg().get("api_key") or "").strip()
        if api and self._norm_key(got) == self._norm_key(api):
            return True
        return False

    def static(self, name):
        p = os.path.normpath(os.path.join(STATIC, name.lstrip("/")))
        if not p.startswith(STATIC) or not os.path.isfile(p):
            return self.send_body(404, "not found", "text/plain; charset=utf-8")
        with open(p, "rb") as f:
            blob = f.read()
        ext = os.path.splitext(p)[1].lower()
        ct = {".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
              ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"}.get(ext, "application/octet-stream")
        etag = '"%x-%x"' % (len(blob), int(os.path.getmtime(p)))
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        self.send_body(200, blob, ct, {"ETag": etag})

    # ---- GET
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        qs = urllib.parse.parse_qs(u.query)
        c = self.cfg()
        try:
            if p.startswith("/static/"):
                return self.static(p[len("/static/"):])
            if p == "/manifest.json":
                return self.send_body(200, json.dumps({
                    "name": c["site_title"], "short_name": c["site_title"], "start_url": "/",
                    "display": "standalone", "background_color": "#f4f5f7", "theme_color": "#2563eb",
                    "icons": [{"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
                              {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png",
                               "purpose": "any maskable"}]}, ensure_ascii=False),
                    "application/manifest+json; charset=utf-8")
            if p == "/sw.js":
                return self.send_body(200, SW_JS, "application/javascript; charset=utf-8")
            if p.startswith("/cover/"):
                tail = p[7:]
                bid = qs_int(tail[:-4] if tail.endswith(".svg") else tail, 0, 0)
                fp = cover_file(bid) if bid else ""
                if fp:
                    ct = "image/png" if fp.endswith(".png") else (
                        "image/webp" if fp.endswith(".webp") else "image/jpeg")
                    try:
                        with open(fp, "rb") as fh:
                            data = fh.read()
                        return self.send_body(200, data, ct,
                                              {"Cache-Control": "public, max-age=604800"})
                    except Exception:
                        pass
                b, _chs = get_book(bid)
                if not b:
                    return self.send_body(404, b"no book", "text/plain")
                return self.send_body(200, cover_svg(b["title"], b["author"] or "", bid),
                                      "image/svg+xml; charset=utf-8",
                                      {"Cache-Control": "public, max-age=86400"})
            if p in ("/icon-192.png", "/icon-512.png"):
                return self.send_body(200, make_png(192 if "192" in p else 512), "image/png",
                                      {"Cache-Control": "public, max-age=604800"})
            if p == "/":
                q = qs.get("q", [""])[0].strip()
                f = qs.get("f", ["all"])[0]
                sort = qs.get("sort", ["updated"])[0]
                desc = qs.get("d", ["1"])[0] != "0"
                pn = qs_int(qs.get("p", ["1"])[0], 1)
                vw = "list" if qs.get("v", [""])[0] == "list" else "grid"
                return self.send_body(200, view_list(q, f, sort, desc, pn, c, vw))
            if p == "/stats":
                return self.send_body(200, view_stats(c))
            if p == "/trash":
                return self.send_body(200, view_trash(c))
            if p == "/dash":
                return self.send_body(200, view_dash(c))
            if p == "/cats":
                return self.send_body(200, view_cats(c))
            if p == "/full":
                q = qs.get("q", [""])[0].strip()
                bid = qs_int(qs.get("bid", ["0"])[0], 0, 0)
                return self.send_body(200, view_full(q, bid, c))
            if p == "/marks":
                bid = qs_int(qs.get("bid", ["0"])[0], 0, 0)
                return self.send_body(200, view_marks(c, bid or None))
            if p == "/up":
                return self.send_body(200, view_up(c))
            if p == "/api/cover":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                bid = qs_int(qs.get("id", ["0"])[0], 0, 0)
                b = get_book(bid)[0]
                if not b:
                    return self.json({"ok": False, "err": "no book"}, 404)
                okc = search_cover_for(bid, b["title"], b["author"] or "")
                return self.json({"ok": okc, "id": bid,
                                  "err": "" if okc else "没搜到合适的封面"})
            if p == "/api/cover/url":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                bid = qs_int(qs.get("id", ["0"])[0], 0, 0)
                if not get_book(bid)[0]:
                    return self.json({"ok": False, "err": "no book"}, 404)
                data = fetch_any_cover(qs.get("url", [""])[0])
                if data and save_cover(bid, data):
                    return self.json({"ok": True, "id": bid})
                return self.json({"ok": False, "err": "图片下载失败或格式不对"}, 400)
            if p == "/api/cover/all":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                c = db()
                try:
                    rows = [dict(r) for r in c.execute(
                        "SELECT id,title,author FROM books ORDER BY id").fetchall()]
                finally:
                    c.close()
                done, miss = [], []
                for r in rows:
                    if cover_file(r["id"]):
                        continue
                    if len(done) >= 30:
                        break
                    if search_cover_for(r["id"], r["title"], r["author"] or ""):
                        done.append(r["id"])
                    else:
                        miss.append(r["id"])
                    time.sleep(0.6)
                return self.json({"ok": True, "got": len(done), "miss": len(miss),
                                  "ids": done, "missIds": miss})
            if p == "/api/fts":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                q = (qs.get("q", [""])[0] or "").strip()
                if q:
                    bid = qs_int(qs.get("bid", ["0"])[0], 0, 0) or None
                    limit = qs_int(qs.get("limit", ["60"])[0], 60, 1, 500)
                    rows, total = search_text(q, bid, limit)
                    return self.json({"ok": True, "q": q, "total": total, "data": rows})
                return self.json({"ok": True, "indexed": fts_sync(full=qs.get("full", ["0"])[0] == "1")})
            if p == "/api/marks":
                bid = qs_int(qs.get("book", ["0"])[0], 0, 0)
                idx = qs.get("idx", [""])[0]
                idx = qs_int(idx, 0, 0) if idx.strip() else None
                return self.json({"ok": True, "data": book_marks(bid or None, idx)})
            if p == "/app.apk":
                apk = os.path.join(DATA, "novelshelf.apk")
                if not os.path.isfile(apk):
                    return self.send_body(404, "no apk", "text/plain; charset=utf-8")
                with open(apk, "rb") as f:
                    blob = f.read()
                return self.send_body(200, blob, "application/vnd.android.package-archive",
                                      {"Content-Disposition": 'attachment; filename="novelshelf.apk"'})
            if p.startswith("/book/"):
                bid = qs_int(p.split("/")[2], 0, 0)
                body, code = view_book(bid, c)
                return self.send_body(code, body)
            if p.startswith("/read/"):
                parts = p.split("/")
                bid = qs_int(parts[2] if len(parts) > 2 else 0, 0, 0)
                idx = qs_int(parts[3] if len(parts) > 3 else 0, 0, 0)
                fs = qs_int(qs.get("fs", ["17"])[0], 17, 13, 30)
                lh = float(qs.get("lh", ["1.95"])[0] or 1.95)
                lh = max(1.4, min(3.0, lh))
                rs = 1 if qs.get("resume", [""])[0] in ("1", "true", "yes") else 0
                body, code = view_read(bid, idx, c, fs, lh, rs)
                return self.send_body(code, body)
            if p == "/dl/all":
                sel = [qs_int(x, 0, 0) for x in qs.get("ids", [""])[0].split(",") if x.strip()]
                fn = (c.get("site_title") or "书库") + ("-选中.zip" if sel else "-全部.zip")
                return self.send_body(200, all_zip(sel or None), "application/zip",
                                      {"Content-Disposition": 'attachment; filename="books.zip"; filename*=UTF-8\'\'%s'
                                                              % urllib.parse.quote(fn)})
            if p == "/dl/txt":
                sel = [qs_int(x, 0, 0) for x in qs.get("ids", [""])[0].split(",") if x.strip()]
                if not sel:
                    return self.send_body(400, "no ids", "text/plain")
                title, txt = books_txt(sel)
                if txt is None:
                    return self.send_body(404, "no book", "text/plain; charset=utf-8")
                fn = (re.sub(r'[\\/:*?"<>|]', "_", title or "books")) + ".txt"
                return self.send_body(200, txt.encode("utf-8"), "text/plain; charset=utf-8",
                                      {"Content-Disposition": 'attachment; filename="books.txt"; '
                                                              'filename*=UTF-8\'\'%s' % urllib.parse.quote(fn)})
            if p.startswith("/dl/"):
                bid = qs_int(p.split("/")[2], 0, 0)
                title, txt = book_text(bid)
                if txt is None:
                    return self.send_body(404, "no book", "text/plain; charset=utf-8")
                fn = ((title or "book").replace("/", "_")) + ".txt"
                return self.send_body(200, txt.encode("utf-8"), "text/plain; charset=utf-8",
                                      {"Content-Disposition": 'attachment; filename="book-%d.txt"; '
                                                              'filename*=UTF-8\'\'%s' % (bid, urllib.parse.quote(fn))})
            if p == "/api/toc":
                bid = qs_int(qs.get("book", ["0"])[0], 0, 0)
                c = db()
                try:
                    rows = c.execute("SELECT idx,title,length(content) AS chars FROM chapters WHERE book_id=? ORDER BY idx",
                                     (bid,)).fetchall()
                finally:
                    c.close()
                return self.json({"ok": True, "data": [dict(r) for r in rows]})
            if p == "/api/appver":
                vf = os.path.join(BASE, "data", "appver.txt")
                ver = "0"
                try:
                    with open(vf, "r", encoding="utf-8") as f:
                        ver = f.read().strip() or "0"
                except Exception:
                    pass
                try:
                    size = os.path.getsize(os.path.join(BASE, "data", "novelshelf.apk"))
                except Exception:
                    size = 0
                return self.json({"ok": True, "version": ver, "size": size})
            if p == "/api/books":
                rows, total, pages, pn = list_books(
                    qs.get("q", [""])[0], qs.get("f", ["all"])[0],
                    qs.get("sort", ["updated"])[0], True, qs_int(qs.get("p", ["1"])[0], 1),
                    qs_int(qs.get("per", ["500"])[0], 500, 1, 2000))
                return self.json({"ok": True, "total": total, "data": rows})
            if p == "/api/stats":
                return self.json({"ok": True, "data": stats()})
            if p == "/favicon.ico":
                return self.send_body(204, b"", "image/x-icon")
            return self.send_body(404, page("404", '<section class="view on"><div class="panel pad">'
                                                   '<h2>页面不存在</h2><p class="hint"><a href="/">回书架</a></p>'
                                                   '</div></section>', c), )
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self.send_body(500, "error: %s" % e, "text/plain; charset=utf-8")

    def read_body(self):
        """支持 Content-Length 与 chunked 两种请求体（部分客户端用流式上传，不带长度）。"""
        n = qs_int(self.headers.get("Content-Length"), 0, 0)
        if n:
            return self.rfile.read(n)
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            parts = []
            while True:
                line = self.rfile.readline(128)
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    size = int(line.split(b";")[0], 16)
                except Exception:
                    break
                if size == 0:
                    while True:
                        t = self.rfile.readline(128)
                        if not t or t in (b"\r\n", b"\n"):
                            break
                    break
                chunk = self.rfile.read(size)
                parts.append(chunk)
                self.rfile.read(2)
            return b"".join(parts)
        return b""

    # ---- POST
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        qs = urllib.parse.parse_qs(u.query)
        c = self.cfg()
        raw = self.read_body()
        try:
            if p == "/api/book":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                bid = qs_int(qs.get("id", ["0"])[0], 0, 0)
                form = urllib.parse.parse_qs(raw.decode("utf-8", "ignore"), keep_blank_values=True)
                fields = {k: (form.get(k, [""])[0] or "").strip() for k in
                          ("title", "author", "cat", "tags", "intro", "status")}
                if not fields["title"]:
                    return self.json({"ok": False, "err": "title empty"}, 400)
                if fields["status"] not in STATUS:
                    fields["status"] = "unread"
                con = db()
                try:
                    con.execute("UPDATE books SET title=?,author=?,cat=?,tags=?,intro=?,status=?,updated=?"
                                " WHERE id=?", (fields["title"][:120], fields["author"][:60],
                                                fields["cat"][:30] or "未分类", fields["tags"][:120],
                                                fields["intro"][:2000], fields["status"], today(), bid))
                    con.commit()
                finally:
                    con.close()
                return self.json({"ok": True, "id": bid})
            if p == "/api/bulk":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                op = qs.get("op", [""])[0]
                ids = [qs_int(x, 0, 0) for x in qs.get("ids", [""])[0].split(",") if x.strip()]
                if not ids:
                    return self.json({"ok": False, "err": "no ids"}, 400)
                con = db()
                try:
                    if op == "delete":
                        con.close()
                        delete_books(ids)
                        return self.json({"ok": True, "op": op, "ids": ids, "trash": True})
                    elif op == "restore":
                        con.close()
                        restore_books(ids)
                        return self.json({"ok": True, "op": op, "ids": ids})
                    elif op == "purge":
                        con.close()
                        purge_books(ids)
                        return self.json({"ok": True, "op": op, "ids": ids})
                    elif op == "cat":
                        con.execute("UPDATE books SET cat=?, updated=? WHERE id IN (%s)"
                                    % ",".join("?" * len(ids)),
                                    [qs.get("cat", ["未分类"])[0].strip() or "未分类", today()] + ids)
                    elif op == "status":
                        st2 = qs.get("status", ["unread"])[0]
                        st2 = st2 if st2 in STATUS else "unread"
                        con.execute("UPDATE books SET status=?, updated=? WHERE id IN (%s)"
                                    % ",".join("?" * len(ids)), [st2, today()] + ids)
                    else:
                        return self.json({"ok": False, "err": "bad op"}, 400)
                    con.commit()
                finally:
                    con.close()
                return self.json({"ok": True, "op": op, "ids": ids})
            if p == "/api/import":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                fn = qs.get("filename", ["book.txt"])[0]
                cat = qs.get("cat", [""])[0].strip()
                r = import_text(raw, filename=fn, cat=cat)
                return self.json(r)
            if p == "/api/cover/up":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                bid = qs_int(qs.get("id", ["0"])[0], 0, 0)
                if not get_book(bid)[0]:
                    return self.json({"ok": False, "err": "no book"}, 404)
                if save_cover(bid, raw):
                    return self.json({"ok": True, "id": bid})
                return self.json({"ok": False, "err": "不是有效图片（jpg/png/webp）"}, 400)
            if p == "/api/restore":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                ids = [int(x) for x in (qs.get("ids", [""])[0] or "").split(",") if x.strip().isdigit()]
                if not ids:
                    return self.json({"ok": False, "err": "no ids"}, 400)
                restore_books(ids)
                return self.json({"ok": True, "ids": ids})
            if p == "/api/purge":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                ids = [int(x) for x in (qs.get("ids", [""])[0] or "").split(",") if x.strip().isdigit()]
                if not ids:
                    return self.json({"ok": False, "err": "no ids"}, 400)
                purge_books(ids)
                return self.json({"ok": True, "ids": ids})
            if p == "/api/delete":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                raw_ids = qs.get("ids", [""])[0] or qs.get("id", [""])[0]
                ids = [qs_int(x, 0, 0) for x in raw_ids.split(",") if x.strip()]
                if not ids:
                    return self.json({"ok": False, "err": "no ids"}, 400)
                delete_books(ids)
                return self.json({"ok": True, "deleted": ids})
            if p == "/api/mark":
                bid = qs_int(qs.get("book", ["0"])[0], 0, 0)
                idx = qs_int(qs.get("idx", ["0"])[0], 0, 0)
                para = qs_int(qs.get("para", ["0"])[0], 0, 0)
                kind = qs.get("kind", ["line"])[0]
                color = qs.get("color", ["y"])[0]
                body = raw.decode("utf-8", "ignore") if raw else ""
                form = urllib.parse.parse_qs(body, keep_blank_values=True)
                text = (form.get("text", [""])[0] or "").strip()
                note = (form.get("note", [""])[0] or "").strip()
                if not bid or not text and kind != "bookmark":
                    return self.json({"ok": False, "err": "empty"}, 400)
                mid = add_mark(bid, idx, para, text=text, note=note, color=color, kind=kind)
                return self.json({"ok": True, "id": mid})
            if p == "/api/mark/del":
                mid = qs_int(qs.get("id", ["0"])[0], 0, 0)
                if not mid:
                    return self.json({"ok": False, "err": "no id"}, 400)
                del_mark(mid)
                return self.json({"ok": True, "deleted": mid})
            if p == "/api/mark/note":
                mid = qs_int(qs.get("id", ["0"])[0], 0, 0)
                form = urllib.parse.parse_qs(raw.decode("utf-8", "ignore"), keep_blank_values=True)
                note = (form.get("note", [""])[0] or "").strip()
                if not mid:
                    return self.json({"ok": False, "err": "no id"}, 400)
                con = db()
                try:
                    con.execute("UPDATE marks SET note=? WHERE id=?", (note[:2000], mid))
                    con.commit()
                finally:
                    con.close()
                return self.json({"ok": True, "id": mid})
            if p == "/api/pos":
                bid = qs_int(qs.get("book", ["0"])[0], 0, 0)
                idx = qs_int(qs.get("idx", ["0"])[0], 0, 0)
                para = qs_int(qs.get("para", ["0"])[0], 0, 0)
                if bid:
                    save_pos(bid, idx, para)
                return self.json({"ok": True})
            if p == "/api/progress":
                bid = qs_int(qs.get("id", ["0"])[0], 0, 0)
                idx = qs_int(qs.get("idx", ["0"])[0], 0, 0)
                save_progress(bid, idx)
                return self.json({"ok": True})
            if p == "/api/config":
                if not self.key_ok(qs):
                    return self.json({"ok": False, "err": "bad key"}, 403)
                form = urllib.parse.parse_qs(raw.decode("utf-8", "ignore"), keep_blank_values=True)
                d = cfg()
                for k in ("site_title", "site_pass", "api_key"):
                    if form.get(k):
                        d[k] = form[k][0].strip()[:120]
                if form.get("per_page"):
                    d["per_page"] = qs_int(form["per_page"][0], 12, 4, 100)
                save_cfg(d)
                return self.json({"ok": True, "cfg": d})
            return self.json({"ok": False, "err": "not found"}, 404)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self.json({"ok": False, "err": str(e)}, 500)


# ---------------------------------------------------------------- 收件箱
def boot_fts():
    try:
        n = fts_sync()
        print("[fts] 补建索引 %d 章" % n)
    except Exception as e:
        print("[fts] 启动索引失败:", e)


def watcher():
    done = os.path.join(INBOX, "done")
    os.makedirs(done, exist_ok=True)
    time.sleep(1)
    last_gc = 0
    while True:
        if time.time() - last_gc > 6 * 3600:
            last_gc = time.time()
            try:
                purge_expired(30)
            except Exception as e:
                print("[trash] 清理失败:", e)
        try:
            for fn in os.listdir(INBOX):
                p = os.path.join(INBOX, fn)
                if not os.path.isfile(p) or fn.startswith("."):
                    continue
                if time.time() - os.path.getmtime(p) < 5:
                    continue
                try:
                    with open(p, "rb") as f:
                        r = import_text(f.read(), filename=fn)
                    print("[inbox] %s → %s" % (fn, r))
                except Exception as e:
                    print("[inbox] 失败 %s: %s" % (fn, e))
                try:
                    os.replace(p, os.path.join(done, fn))
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(15)


def main():
    init_db()
    if not os.path.exists(CFG_PATH):
        d = dict(DEFAULT_CFG)
        d["site_pass"] = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(12))
        save_cfg(d)
        print("[cfg] 首次启动，已生成管理密码：" + d["site_pass"], flush=True)
    threading.Thread(target=watcher, daemon=True).start()
    threading.Thread(target=boot_fts, daemon=True).start()
    servers = []
    for i, port in enumerate(PORTS):
        s = ThreadingHTTPServer(("0.0.0.0", port), H)
        s.daemon_threads = True
        servers.append(s)
        print("listening on %d" % port)
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

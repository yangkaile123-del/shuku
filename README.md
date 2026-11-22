# 书库 · 自建私人小说阅读站 + Android 客户端

一套完全自托管、零第三方依赖的个人小说库：**服务端**用 Python 标准库起 HTTP + SQLite(FTS5)，
**客户端**是一个 Android App（原生壳 + WebView 阅读 + 番茄小说下载器）。

> 单核 1G 的小 VPS 就能跑，实测 31 本书 / 1.7 万章 / 5000 万字，全文检索毫秒级返回。

---

## 功能

### 服务端

- **书架**：竖屏单列 / 横屏 3×3 网格；封面自动配色，可按书名/章数/字数/更新时间排序
- **阅读器**：字号、行距、4 种背景（白 / 米黄 / 护眼绿 / 夜）、段落级阅读位置记忆、
  左右点击翻章、目录抽屉、双击隐藏界面 chrome
- **全文搜索**：SQLite FTS5 中文逐字索引，跨全书库检索，命中处高亮片段
- **划线 / 笔记 / 书签**：选中文字划四色线、写笔记、加书签，`/marks` 汇总，可跳回原文
- **导入**：网页上传（多选、进度条）、`inbox/` 目录丢文件（15 秒自动入库）、
  `POST /api/import` 接口、zip 批量；自动分章、自动识别书名/作者/分类（32 个番茄分类）
- **去重**：按正文 SHA-256 判重，同一本书重复导入会被拦下
- **回收站**：删除进回收站，30 天内可恢复，过期自动清理
- **封面**：从豆瓣自动搜图、粘贴图片链接、本地上传，三层缓存
- **导出**：单本 TXT、多本合并 TXT、整库 zip
- **统计**：阅读时长热力图、连续阅读天数、读得最多的书
- **PWA**：可安装到桌面，离线缓存已读章节
- **备份**：cron 每天 VACUUM + tar 打包，保留 7 份

### Android 客户端

- 单个 App 三个 tab：**书库 / 书架 / 番茄**，主题全局统一（深/浅色一处切换）
- 书架搜索、状态筛选、真封面、长按菜单（下载 / 离线缓存 / 改分类 / 删除）
- **番茄小说下载器**：目录抓取 → 并发分批下载 → 流式落盘 → 断点续下 → 失败重试
  - 可暂停 / 继续 / 取消，进度条 + 速度 + 剩余时间 + 「正在干什么」实时文案
  - 前台服务保活 + 通知栏进度
  - 下载完**自动入库**到服务器，失败进待上传队列，下次打开自动补传
  - 书架顶部「最近入库」横条，直接看服务器上真有什么

---

## 目录结构

```
server/            服务端（Python 3.8+，无第三方依赖）
  app.py           全部逻辑，单文件
  static/          style.css / app.js
app/               Android 客户端
  src/             Java 源码
  res/             图标与资源
  assets/          番茄下载器的网页部分
  build.sh         构建脚本
```

---

## 服务端 · 快速开始

```bash
# 1. 放到服务器上
mkdir -p /opt/novel && cp -r server/* /opt/novel/

# 2. 直接跑（默认监听 8080）
cd /opt/novel && python3 -u app.py

# 监听多个端口 / 换端口
NOVEL_PORTS=8080,80 python3 -u app.py
```

首次启动会在 `data/config.json` 生成**随机管理密码**并打印在控制台，记得记下来。

### 用 systemd 常驻

```ini
# /etc/systemd/system/novel.service
[Unit]
Description=Novel Library
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/novel
Environment=NOVEL_PORTS=8080
ExecStart=/usr/bin/python3 -u /opt/novel/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now novel
```

### 每天备份 + 回收空闲页

```cron
# /etc/cron.d/novel-backup
30 3 * * * root python3 -c "import sqlite3;c=sqlite3.connect('/opt/novel/data/novel.db');c.execute('VACUUM');c.close()" && mkdir -p /opt/backup && tar czf /opt/backup/novel-$(date +\%Y\%m\%d).tgz -C /opt novel
```

### 导入小说

三条路，随便挑：

1. **网页上传**：浏览器打开 `/up`，选多个 txt（会自动分章、识别书名/作者/分类）
2. **丢目录**：把 txt/md/zip 放进 `/opt/novel/inbox/`，15 秒内自动入库并移到 `inbox/done/`
3. **接口**：

```bash
curl -X POST --data-binary @小说.txt \
  "http://你的地址:8080/api/import?key=管理密码&filename=书名.txt"
```

分章规则：`第X章 / 第X节 / Chapter N / 数字、` 等常见格式；识别不到就整本当一章。

---

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/books?q=&f=&sort=&per=&p=` | 书架列表（搜索/筛选/排序/分页） |
| GET | `/api/stats` | 汇总统计 |
| GET | `/api/toc?book=ID` | 目录（章节序号 / 标题 / 字数） |
| GET | `/api/fts?key=&q=&bid=` | 全文检索 |
| GET | `/api/appver` | 客户端版本与 APK 大小 |
| GET | `/api/cover?id=&key=` | 从豆瓣搜封面 |
| GET | `/api/cover/url?id=&key=&url=` | 用指定链接做封面 |
| GET | `/api/marks?book=&idx=` | 某章的书签/划线/笔记 |
| POST | `/api/import?key=&filename=&cat=` | 导入一本（raw body 即正文） |
| POST | `/api/mark?book=&idx=&para=&kind=&color=` | 新增标记 |
| POST | `/api/mark/del?id=` / `/api/mark/note?id=` | 删标记 / 改笔记 |
| POST | `/api/pos?book=&idx=&para=` | 保存阅读位置 |
| POST | `/api/bulk?op=delete\|cat\|status\|restore\|purge&ids=&key=` | 批量操作 |
| POST | `/api/delete?ids=` / `/api/restore?ids=` / `/api/purge?ids=` | 删除 / 恢复 / 彻底删 |
| POST | `/api/book?key=&id=` | 改书名/作者/分类/标签/状态 |
| POST | `/api/cover/up?id=&key=` | 上传封面图片 |

管理类接口都需要 `key=`（即 `data/config.json` 里的 `site_pass`）。

---

## Android 客户端 · 构建

需要 JDK + Android build-tools（`aapt` `d8` `zipalign` `apksigner`）和 `android.jar`。

```bash
cd app
cp src/com/fj/bookshelf/Conf.java.example src/com/fj/bookshelf/Conf.java
# 编辑 Conf.java，填入你的服务器地址与管理密码

keytool -genkey -v -keystore keystore.jks -alias shelf \
        -keyalg RSA -keysize 2048 -validity 10000

KEYSTORE_PASS=你的口令 VERSION=1.0 bash build.sh
# 产物：build/书库-1.0.apk
```

> `Conf.java`、`*.jks`、`*.apk` 都已在 `.gitignore` 里，不会被提交。

装到手机后：

- 长按标题栏或进 ⚙ 可以改服务器地址 / 密码 / 下载目录 / 下载完是否自动入库
- 番茄 tab 是内置的网页下载器，抓目录后分批下载并把 txt 落盘，下完自动上传

---

## 安全提醒

- 站点默认只跑 HTTP。**如果要放到公网并长期使用，请套一层 HTTPS**
  （Caddy / Nginx + Let's Encrypt，或 Cloudflare Tunnel）
- 管理密码只存在服务端 `data/config.json`，不要提交、不要贴到公开仓库
- 全文索引会把正文再存一份，库体积约为纯正文的 1.5~2 倍；磁盘紧张时可改 FTS5
  external-content 表瘦身

## 许可

MIT

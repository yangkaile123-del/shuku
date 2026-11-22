package app.fq;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.provider.DocumentsContract;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class Bridge {
    public static volatile boolean sheetOpen = false;

    @JavascriptInterface
    public void setSheet(boolean open) {
        sheetOpen = open;
    }

    private final android.app.Activity act;
    private final WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler ui = new Handler(Looper.getMainLooper());

    private android.os.PowerManager.WakeLock wake;

    @JavascriptInterface
    public void keepAwake(final boolean on) {
        ui.post(new Runnable() {
            public void run() {
                try {
                    if (on) {
                        if (wake != null && wake.isHeld()) return;
                        android.os.PowerManager pm =
                                (android.os.PowerManager) act.getSystemService(Context.POWER_SERVICE);
                        wake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "fq:download");
                        wake.setReferenceCounted(false);
                        wake.acquire(30 * 60 * 1000L);
                    } else if (wake != null && wake.isHeld()) {
                        wake.release();
                    }
                } catch (Throwable ignore) { }
            }
        });
    }

    private OutputStream out;
    private String outName;
    private Uri lastUri;
    private File lastFile;
    private Uri outUri;

    public Bridge(android.app.Activity a, WebView w) {
        this.act = a;
        this.web = w;
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "");
    }

    /* ---------------- HTTP ---------------- */
    @JavascriptInterface
    public void http(final String id, final String method, final String url,
                     final String headersJson, final String bodyB64) {
        pool.execute(new Runnable() {
            public void run() {
                int status = 0;
                String b64 = "";
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(45000);
                    c.setUseCaches(false);
                    c.setInstanceFollowRedirects(true);
                    JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        try { c.setRequestProperty(k, h.getString(k)); } catch (Exception ignore) { }
                    }
                    if (c.getRequestProperty("Accept-Encoding") == null
                            && c.getRequestProperty("accept-encoding") == null) {
                        c.setRequestProperty("Accept-Encoding", "identity");
                    }
                    if (bodyB64 != null && !bodyB64.isEmpty()) {
                        byte[] body = Base64.decode(bodyB64, Base64.DEFAULT);
                        c.setDoOutput(true);
                        c.setFixedLengthStreamingMode(body.length);
                        OutputStream os = c.getOutputStream();
                        os.write(body);
                        os.flush();
                        os.close();
                    }
                    status = c.getResponseCode();
                    InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    String enc = c.getContentEncoding();
                    if (is != null && enc != null && enc.toLowerCase().contains("gzip")) {
                        is = new java.util.zip.GZIPInputStream(is);
                    }
                    byte[] data = is == null ? new byte[0] : readAll(is);
                    b64 = Base64.encodeToString(data, Base64.NO_WRAP);
                } catch (Throwable t) {
                    status = 0;
                } finally {
                    if (c != null) try { c.disconnect(); } catch (Throwable ignore) { }
                }
                final int st = status;
                final String bb = b64;
                ui.post(new Runnable() {
                    public void run() {
                        try {
                            web.evaluateJavascript("window.__net&&window.__net('" + id + "'," + st + ",'" + bb + "')", null);
                        } catch (Throwable ignore) { }
                    }
                });
            }
        });
    }

    private static byte[] readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return bos.toByteArray();
    }

    /* ---------------- 文件保存（写 Downloads） ---------------- */
    @JavascriptInterface
    public String saveStart(String name) {
        try {
            closeOut();
            outName = name;
            String tree = act.getSharedPreferences("cfg", 0).getString("dlTree", "");
            if (tree != null && !tree.isEmpty()) {
                Uri t = Uri.parse(tree);
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(
                        t, DocumentsContract.getTreeDocumentId(t));
                String tryName = name;
                Uri doc = null;
                for (int k = 0; k < 60 && doc == null; k++) {
                    try {
                        doc = DocumentsContract.createDocument(
                                act.getContentResolver(), parent, "text/plain", tryName);
                    } catch (Throwable dup) {
                        String base = name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name;
                        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')) : "";
                        tryName = base + "(" + (k + 1) + ")" + ext;
                        doc = null;
                    }
                }
                if (doc == null) return "ERR:所选目录里建不了文件";
                outUri = doc;
                lastUri = doc;
                lastFile = null;
                out = act.getContentResolver().openOutputStream(doc);
                if (out == null) return "ERR:打开文件失败";
                return "OK|" + doc.toString();
            }
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                outUri = act.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (outUri == null) return "ERR:无法创建目标文件";
                out = act.getContentResolver().openOutputStream(outUri);
                lastUri = outUri;
                lastFile = null;
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists() && !dir.mkdirs()) return "ERR:无法创建下载目录";
                File f = new File(dir, name);
                int i = 1;
                while (f.exists()) {
                    String base = name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name;
                    String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')) : "";
                    f = new File(dir, base + "(" + (i++) + ")" + ext);
                }
                outName = f.getName();
                out = new FileOutputStream(f);
                lastUri = null;
                lastFile = f;
            }
            if (out == null) return "ERR:打开文件失败";
            if (outUri != null) return "OK|" + outUri.toString();
            if (lastFile != null) return "OK|" + lastFile.getAbsolutePath();
            return "OK";
        } catch (Throwable t) {
            return "ERR:" + t.getMessage();
        }
    }

    @JavascriptInterface
    public void saveAppend(String b64) {
        try {
            if (out == null || b64 == null || b64.isEmpty()) return;
            out.write(Base64.decode(b64, Base64.DEFAULT));
        } catch (Throwable ignore) { }
    }

    @JavascriptInterface
    public String saveEnd() {
        try {
            if (out != null) { out.flush(); out.close(); out = null; }
            if (outUri != null && Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
                act.getContentResolver().update(outUri, cv, null, null);
            }
            final String nm = outName;
            try { autoUpload(nm); } catch (Throwable ignore) { }
            return "Download/" + outName;
        } catch (Throwable t) {
            return "ERR:" + t.getMessage();
        }
    }

    @JavascriptInterface
    public String saveResume(String ref) {
        try {
            closeOut();
            if (ref == null || ref.isEmpty()) return "ERR:没有文件引用";
            if (ref.startsWith("content:")) {
                Uri u = Uri.parse(ref);
                outUri = u;
                out = act.getContentResolver().openOutputStream(u, "wa");
                lastUri = u;
                lastFile = null;
            } else {
                File f = new File(ref);
                out = new FileOutputStream(f, true);
                lastFile = f;
                lastUri = null;
                outName = f.getName();
            }
            if (out == null) return "ERR:续写打开失败";
            return "OK";
        } catch (Throwable t) {
            return "ERR:" + t.getMessage();
        }
    }

    @JavascriptInterface
    public void saveAbort() {
        try { if (out != null) { out.close(); } } catch (Throwable ignore) { }
        out = null;
        try {
            if (outUri != null) act.getContentResolver().delete(outUri, null, null);
        } catch (Throwable ignore) { }
        try {
            if (lastFile != null && lastFile.exists()) lastFile.delete();
        } catch (Throwable ignore) { }
        outUri = null;
        lastUri = null;
        lastFile = null;
        outName = null;
    }

    private void closeOut() {
        try { if (out != null) { out.flush(); out.close(); } } catch (Throwable ignore) { }
        out = null;
        outUri = null;
    }

    /* ---------------- 杂项 ---------------- */
    @JavascriptInterface
    public void copy(final String text) {
        ui.post(new Runnable() {
            public void run() {
                try {
                    ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("fq", text));
                } catch (Throwable ignore) { }
            }
        });
    }

    @JavascriptInterface
    public void toast(final String msg) {
        if (msg == null || msg.isEmpty()) return;
        ui.post(new Runnable() {
            public void run() {
                try { Toast.makeText(act, msg, Toast.LENGTH_SHORT).show(); } catch (Throwable ignore) { }
            }
        });
    }

    @JavascriptInterface
    public void notify(final String title, final String text) {
        final String body = text == null ? "" : text;
        ui.post(new Runnable() {
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 33 && act.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                            != PackageManager.PERMISSION_GRANTED) {
                        Toast.makeText(act, title + (body.isEmpty() ? "" : " · " + body), Toast.LENGTH_SHORT).show();
                        return;
                    }
                    NotificationManager nm = (NotificationManager) act.getSystemService(Context.NOTIFICATION_SERVICE);
                    String ch = "fq_downloads";
                    if (nm.getNotificationChannel(ch) == null) {
                        NotificationChannel c = new NotificationChannel(ch, "下载完成", NotificationManager.IMPORTANCE_DEFAULT);
                        c.setDescription("小说下载完成时提醒");
                        nm.createNotificationChannel(c);
                    }
                    Notification n = new Notification.Builder(act, ch)
                            .setSmallIcon(android.R.drawable.stat_sys_download_done)
                            .setContentTitle(title)
                            .setContentText(body)
                            .setAutoCancel(true)
                            .setShowWhen(true)
                            .build();
                    nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), n);
                } catch (Throwable t) {
                    try { Toast.makeText(act, title, Toast.LENGTH_SHORT).show(); } catch (Throwable ignore) { }
                }
            }
        });
    }

    @JavascriptInterface
    public void fgStart(final String title) {
        ui.post(new Runnable() {
            public void run() {
                try { com.fj.bookshelf.DownloadService.start(act, title); } catch (Throwable ignore) { }
            }
        });
    }

    @JavascriptInterface
    public void fgStop() {
        ui.post(new Runnable() {
            public void run() {
                try { com.fj.bookshelf.DownloadService.stop(act); } catch (Throwable ignore) { } 
            }
        });
    }

    @JavascriptInterface
    public void notifyProgress(final String title, final String text, final int pct) {
        final String body = text == null ? "" : text;
        final int p = Math.max(0, Math.min(100, pct));
        ui.post(new Runnable() {
            public void run() {
                try {
                    if (com.fj.bookshelf.DownloadService.isRunning()) {
                        com.fj.bookshelf.DownloadService.update(title + " · " + body, p);
                        return;
                    }
                    if (Build.VERSION.SDK_INT >= 33 && act.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                            != PackageManager.PERMISSION_GRANTED) {
                        return;
                    }
                    NotificationManager nm = (NotificationManager) act.getSystemService(Context.NOTIFICATION_SERVICE);
                    String ch = "fq_progress";
                    if (nm.getNotificationChannel(ch) == null) {
                        NotificationChannel c = new NotificationChannel(ch, "下载进度", NotificationManager.IMPORTANCE_LOW);
                        c.setDescription("下载进行中的常驻进度");
                        c.setShowBadge(false);
                        c.setSound(null, null);
                        nm.createNotificationChannel(c);
                    }
                    Notification n = new Notification.Builder(act, ch)
                            .setSmallIcon(android.R.drawable.stat_sys_download)
                            .setContentTitle(title)
                            .setContentText(body)
                            .setProgress(100, p, p <= 0)
                            .setOngoing(true)
                            .setOnlyAlertOnce(true)
                            .setShowWhen(false)
                            .build();
                    nm.notify(9001, n);
                } catch (Throwable ignore) { }
            }
        });
    }

    @JavascriptInterface
    public void notifyClear() {
        ui.post(new Runnable() {
            public void run() {
                try {
                    NotificationManager nm = (NotificationManager) act.getSystemService(Context.NOTIFICATION_SERVICE);
                    nm.cancel(9001);
                } catch (Throwable ignore) { }
            }
        });
    }

    @JavascriptInterface
    public void haptic(final int ms) {
        try {
            int d = ms <= 0 ? 10 : Math.min(ms, 60);
            if (Build.VERSION.SDK_INT >= 31) {
                android.os.VibratorManager vm =
                        (android.os.VibratorManager) act.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) vm.getDefaultVibrator()
                        .vibrate(VibrationEffect.createOneShot(d, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                Vibrator v = (Vibrator) act.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(VibrationEffect.createOneShot(d, VibrationEffect.DEFAULT_AMPLITUDE));
            }
        } catch (Throwable ignore) { }
    }

    @JavascriptInterface
    public void setBars(final boolean light) {
        // 主题由原生唯一管理，网页这边的切换键已隐藏，这里不再回写
    }

    @JavascriptInterface
    public void openDownloads() {
        ui.post(new Runnable() {
            public void run() {
                try {
                    android.content.Intent i = new android.content.Intent(
                            android.app.DownloadManager.ACTION_VIEW_DOWNLOADS);
                    i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(i);
                } catch (Throwable t) {
                    try {
                        act.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                                Uri.parse("content://downloads/my_downloads")));
                    } catch (Throwable ignore) { }
                }
            }
        });
    }

    @JavascriptInterface
    public void ready() { }

    @JavascriptInterface
    public String version() { return "2.0.0"; }

    /* ---------------- 下载完自动入库 ---------------- */
    private void autoUpload(final String name) {
        final SharedPreferences sp = act.getSharedPreferences("cfg", 0);
        if (!sp.getBoolean("autoUp", true)) return;
        final WebView wv = web;
        final Uri uri = lastUri;
        final File file = lastFile;
        pool.execute(new Runnable() {
            public void run() {
                String r = uploadOnce(act, name, uri, file, wv);
                handleResult(act, name, uri, file, r);
            }
        });
    }

    static String uploadOnce(Context ctx, String name, Uri uri, File file, WebView web) {
        SharedPreferences sp = ctx.getSharedPreferences("cfg", 0);
        String base = sp.getString("base", "");
        String key = sp.getString("key", "");
        if (base == null || base.isEmpty() || name == null || name.isEmpty()) return "ERR:没有服务器地址";
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        long total = 0;
        try {
            if (uri != null) {
                Cursor c = ctx.getContentResolver().query(uri, null, null, null, null);
                if (c != null) {
                    int ix = c.getColumnIndex(android.provider.OpenableColumns.SIZE);
                    if (c.moveToFirst() && ix >= 0) total = c.getLong(ix);
                    c.close();
                }
            } else if (file != null) {
                total = file.length();
            }
        } catch (Throwable ignore) { }
        InputStream in = null;
        HttpURLConnection c = null;
        try {
            if (uri != null) in = ctx.getContentResolver().openInputStream(uri);
            else if (file != null) in = new FileInputStream(file);
            if (in == null) return "ERR:读不到文件";
            String u = base + "/api/import?key=" + URLEncoder.encode(key == null ? "" : key, "UTF-8")
                    + "&filename=" + URLEncoder.encode(name, "UTF-8");
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setChunkedStreamingMode(65536);
            c.setConnectTimeout(20000);
            c.setReadTimeout(900000);
            c.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
            OutputStream os = c.getOutputStream();
            byte[] buf = new byte[65536];
            int n;
            long sent = 0;
            int lastPct = -1;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                sent += n;
                if (total > 0) {
                    int p = (int) (sent * 100 / total);
                    if (p != lastPct && p < 100) {
                        lastPct = p;
                        notifyWeb(web, name, p);
                    }
                }
            }
            os.flush();
            os.close();
            in.close();
            in = null;
            notifyWeb(web, name, 100);
            int code = c.getResponseCode();
            InputStream rs = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String body = rs == null ? "" : new String(readAll(rs), "UTF-8");
            try {
                JSONObject o = new JSONObject(body);
                if (o.optBoolean("ok")) return "OK:" + o.optString("title", name) + "|" + o.optInt("chapters");
                if (o.optBoolean("dup")) return "DUP:" + o.optString("title", name);
                return "ERR:" + o.optString("err", "入库失败 HTTP " + code);
            } catch (Throwable t) {
                return code == 200 ? "OK:" + name + "|0" : "ERR:入库失败 HTTP " + code;
            }
        } catch (Throwable t) {
            return "ERR:" + t.getMessage();
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignore) { }
            try { if (c != null) c.disconnect(); } catch (Throwable ignore) { }
        }
    }

    static void notifyWeb(final WebView web, final String name, final int pct) {
        if (web != null) {
            try {
                final String js = "window.fqUp&&window.fqUp(" + JSONObject.quote(name) + "," + pct + ")";
                web.post(new Runnable() {
                    public void run() {
                        try { web.evaluateJavascript(js, null); } catch (Throwable ignore) { }
                    }
                });
            } catch (Throwable ignore) { }
        }
        try {
            if (com.fj.bookshelf.DownloadService.isRunning()) {
                com.fj.bookshelf.DownloadService.update("正在上传到书库 " + pct + "%", pct);
            }
        } catch (Throwable ignore) { }
    }

    static void handleResult(final Context ctx, final String name, Uri uri, File file, String r) {
        String msg;
        if (r.startsWith("OK:")) {
            String t = r.substring(3);
            String[] p = t.split("\\|");
            msg = "\u2713 已入库《" + p[0] + "》· " + (p.length > 1 ? p[1] : "0") + " 章";
            try {
                ctx.getSharedPreferences("cfg", 0).edit()
                        .putString("lastUp", p[0] + "|" + (p.length > 1 ? p[1] : "0")
                                + "|" + System.currentTimeMillis()).apply();
            } catch (Throwable ignore) { }
            removePending(ctx, name);
        } else if (r.startsWith("DUP:")) {
            msg = "库里已经有《" + r.substring(4) + "》，跳过";
            removePending(ctx, name);
        } else {
            String why = r.indexOf(':') > 0 ? r.substring(r.indexOf(':') + 1) : r;
            msg = "没入库：\u4e0a\u4f20\u5931\u8d25";
            msg = "没入库：" + why + "（已存待上传，下次自动重试）";
            enqueuePending(ctx, name, uri, file);
        }
        final String m = msg;
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            public void run() {
                try { Toast.makeText(ctx, m, Toast.LENGTH_LONG).show(); } catch (Throwable ignore) { }
            }
        });
    }

    static void enqueuePending(Context ctx, String name, Uri uri, File file) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences("cfg", 0);
            JSONArray a = new JSONArray(sp.getString("pendingUp", "[]"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null && name.equals(o.optString("name"))) return;
            }
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("uri", uri != null ? uri.toString() : "");
            o.put("path", file != null ? file.getAbsolutePath() : "");
            o.put("tries", 0);
            a.put(o);
            sp.edit().putString("pendingUp", a.toString()).apply();
        } catch (Throwable ignore) { }
    }

    static void removePending(Context ctx, String name) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences("cfg", 0);
            JSONArray a = new JSONArray(sp.getString("pendingUp", "[]"));
            JSONArray b = new JSONArray();
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null && !name.equals(o.optString("name"))) b.put(o);
            }
            sp.edit().putString("pendingUp", b.toString()).apply();
        } catch (Throwable ignore) { }
    }

    public static int pendingCount(Context ctx) {
        try {
            JSONArray a = new JSONArray(ctx.getSharedPreferences("cfg", 0).getString("pendingUp", "[]"));
            return a.length();
        } catch (Throwable t) {
            return 0;
        }
    }

    public static void flushPending(final Context ctx) {
        new Thread(new Runnable() {
            public void run() {
                SharedPreferences sp = ctx.getSharedPreferences("cfg", 0);
                if (!sp.getBoolean("autoUp", true)) return;
                JSONArray a;
                try { a = new JSONArray(sp.getString("pendingUp", "[]")); } catch (Throwable t) { return; }
                for (int i = 0; i < a.length(); i++) {
                    JSONObject o = a.optJSONObject(i);
                    if (o == null) continue;
                    String name = o.optString("name");
                    String u = o.optString("uri");
                    String p = o.optString("path");
                    Uri uri = u.isEmpty() ? null : Uri.parse(u);
                    File file = p.isEmpty() ? null : new File(p);
                    if (uri == null && (file == null || !file.exists())) { removePending(ctx, name); continue; }
                    String r = uploadOnce(ctx, name, uri, file, null);
                    handleResult(ctx, name, uri, file, r);
                    if (r.startsWith("ERR:")) break;
                }
            }
        }).start();
    }
}

package com.fj.bookshelf;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.DialogInterface;
import android.content.IntentFilter;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {

    private int C_BG = 0xFF07070B;
    private int C_CARD = 0xFF14141C;
    private int C_LINE = 0xFF2A2A36;
    private int C_TXT = 0xFFF2F2F7;
    private int C_DIM = 0xFF8B8B96;
    private int C_ACC = 0xFF7C5CFF;
    private int C_ACC2 = 0xFF4CC9F0;
    private int C_SOFT = 0xFF1E1E28;
    private boolean light = false;

    // 服务器地址与密码放在 Conf.java（已在 .gitignore 中排除），模板见 Conf.java.example
    private static final String DEFAULT_BASE = Conf.BASE;
    private static final String DEFAULT_KEY = Conf.KEY;
    private static final int PICK = 2001;
    static final int REQ_DIR = 9003;

    private FrameLayout host;
    private FrameLayout contentHost;
    private LinearLayout navBar;
    private WebView fq;
    private int tab = 0;
    public static volatile MainActivity current;
    private String shelfQ = "";
    private String shelfF = "all";
    private int curBid = -1;
    private int curIdx = 0;
    private SharedPreferences sp;
    private int screen = 0;               // 0 首页 1 上传 2 下载 3 阅读 4 书架 5 番茄
    private EditText shelfInput;
    private boolean pendingOffline = false;
    private BroadcastReceiver dmReceiver;
    private WebView web;
    private LinearLayout uploadList;
    private LinearLayout bookList;
    private final List<Uri> queue = new ArrayList<Uri>();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        sp = getSharedPreferences("cfg", MODE_PRIVATE);
        initColors();
        paintBars();
        host = new FrameLayout(this);
        host.setBackgroundColor(C_BG);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        contentHost = new FrameLayout(this);
        root.addView(contentHost, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        navBar = new LinearLayout(this);
        buildNav();
        root.addView(navBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        host.addView(root, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        current = this;
        // Android 11+ / targetSdk35：内容会顶到状态栏底下，这里自己吃 insets
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            host.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                public WindowInsets onApplyWindowInsets(View v, WindowInsets ins) {
                    android.graphics.Insets sys = ins.getInsets(WindowInsets.Type.systemBars());
                    android.graphics.Insets ime = ins.getInsets(WindowInsets.Type.ime());
                    v.setPadding(0, sys.top, 0, Math.max(sys.bottom, ime.bottom));
                    return ins;
                }
            });
        }
        setContentView(host);
        registerDm();
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(new Runnable() {
            public void run() { app.fq.Bridge.flushPending(MainActivity.this); }
        }, 2500);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 7001); }
            catch (Throwable ignore) { }
        }
        showHome();
    }

    @Override
    protected void onDestroy() {
        try { if (dmReceiver != null) unregisterReceiver(dmReceiver); } catch (Throwable ignore) { }
        super.onDestroy();
    }

    /* ---------------- 公共小工具 ---------------- */

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private TextView tv(String text, float size, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(size);
        t.setTextColor(color);
        if (bold) {
            t.setTypeface(Typeface.DEFAULT_BOLD);
        }
        return t;
    }

    /** 细分割线 */
    private View hairline() {
        View v = new View(this);
        v.setBackgroundColor(C_LINE);
        v.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(0.6f))));
        return v;
    }

    /** 圆形水波纹图标按钮 */
    private TextView iconBtn(String glyph) {
        TextView t = new TextView(this);
        t.setText(glyph);
        t.setTextSize(18);
        t.setTextColor(C_TXT);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0x00000000);
        android.content.res.ColorStateList ripple =
                android.content.res.ColorStateList.valueOf(light ? 0x1A000000 : 0x33FFFFFF);
        if (Build.VERSION.SDK_INT >= 21) {
            t.setBackground(new android.graphics.drawable.RippleDrawable(ripple, bg, null));
        }
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
        t.setClickable(true);
        t.setFocusable(true);
        return t;
    }

    /** 安卓风格顶栏：可选返回键 + 标题 + 右侧动作 */
    private LinearLayout toolbar(String title, boolean back) {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(C_CARD);
        bar.setPadding(dp(back ? 4 : 16), dp(4), dp(6), dp(4));
        bar.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(54)));
        if (back) {
            TextView b = iconBtn("\u2039");
            b.setTextSize(26);
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { showHome(); }
            });
            bar.addView(b);
        }
        TextView t = tv(title, 19, C_TXT, true);
        t.setPadding(dp(back ? 4 : 0), 0, dp(8), 0);
        t.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(t);
        return bar;
    }

    private LinearLayout card() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable g = new GradientDrawable();
        g.setColor(C_CARD);
        g.setCornerRadius(dp(18));
        if (light) g.setStroke(dp(1), C_LINE);
        l.setBackground(g);
        l.setElevation(light ? dp(1) : 0);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(dp(16), 0, dp(16), dp(10));
        l.setLayoutParams(p);
        l.setPadding(dp(16), dp(16), dp(16), dp(16));
        return l;
    }

    private Button btn(String text, boolean primary) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(14);
        b.setTextColor(primary ? 0xFFFFFFFF : C_TXT);
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(13));
        if (primary) {
            g.setColors(new int[]{C_ACC, C_ACC2});
            g.setOrientation(GradientDrawable.Orientation.TL_BR);
        } else {
            g.setColor(C_SOFT);
            g.setStroke(dp(1), C_LINE);
        }
        b.setBackground(g);
        b.setPadding(dp(14), dp(6), dp(14), dp(6));
        return b;
    }

    private void setContent(View v) {
        contentHost.removeAllViews();
        contentHost.addView(v, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (navBar != null) {
            navBar.setVisibility(screen == 3 ? View.GONE : View.VISIBLE);
        }
    }

    private String base() {
        String s = sp.getString("base", DEFAULT_BASE);
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    private String key() {
        return sp.getString("key", DEFAULT_KEY);
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    /* ---------------- 首页 ---------------- */

    private void showHome() {
        screen = 0;
        initColors();
        setNavActive(0);
        ScrollView sv = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(0, 0, 0, dp(28));
        sv.addView(col);

        LinearLayout head = toolbar("书库", false);
        TextView th = iconBtn(light ? "\u2600" : "\u263E");
        th.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { toggleTheme(); }
        });
        head.addView(th);
        TextView tg = iconBtn("\u2699");
        tg.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { editConfig(); }
        });
        head.addView(tg);
        col.addView(head);
        col.addView(hairline());
        View sp0 = new View(this);
        sp0.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(14)));
        col.addView(sp0);

        LinearLayout c1 = card();
        c1.addView(tv("上传小说", 16, C_TXT, true));
        c1.addView(tv("从手机里选 txt / md / zip，直传服务器", 12, C_DIM, false));
        Button up = btn("选择文件上传", true);
        up.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                showUpload();
                pickFiles();
            }
        });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = dp(12);
        c1.addView(up, bp);
        col.addView(c1);

        LinearLayout c2 = card();
        c2.addView(tv("下载小说", 16, C_TXT, true));
        c2.addView(tv("列出服务器所有藏书，单本 TXT 或整站 zip", 12, C_DIM, false));
        Button dn = btn("打开下载列表", false);
        dn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                showDownload();
            }
        });
        LinearLayout.LayoutParams bp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp2.topMargin = dp(12);
        c2.addView(dn, bp2);
        col.addView(c2);

        LinearLayout c3 = card();
        c3.addView(tv("打开网站", 16, C_TXT, true));
        c3.addView(tv("干净的阅读界面，书架 / 搜索 / 正文", 12, C_DIM, false));
        Button rd = btn("进入阅读模式", false);
        rd.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                showReader(base() + "/");
            }
        });
        LinearLayout.LayoutParams bp3 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp3.topMargin = dp(12);
        c3.addView(rd, bp3);
        col.addView(c3);

        LinearLayout c4 = card();
        c4.addView(tv("我的书架", 16, C_TXT, true));
        c4.addView(tv("封面列表 · 进度 · 点一下直接接着读", 12, C_DIM, false));
        Button sh = btn("打开书架", false);
        sh.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                showShelf();
            }
        });
        LinearLayout.LayoutParams bp4 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp4.topMargin = dp(12);
        c4.addView(sh, bp4);
        col.addView(c4);

        final LinearLayout cont = new LinearLayout(this);
        cont.setOrientation(LinearLayout.VERTICAL);
        col.addView(cont);

        String cached = sp == null ? "" : sp.getString("statText", "");
        final TextView stat = tv(cached.isEmpty() ? "正在读取藏书…" : cached, 12, C_DIM, false);
        stat.setPadding(dp(22), dp(10), dp(22), 0);
        col.addView(stat);
        checkUpdate(col);

        setContent(sv);

        new Thread(new Runnable() {
            public void run() {
                try {
                    JSONObject o = new JSONObject(get(base() + "/api/books"));
                    final JSONArray arr = o.getJSONArray("data");
                    final StringBuilder sb = new StringBuilder();
                    int chars = 0;
                    for (int i = 0; i < arr.length(); i++) {
                        chars += arr.getJSONObject(i).optInt("chars");
                    }
                    sb.append("服务器上 ").append(arr.length()).append(" 本 · 约 ")
                            .append(chars / 10000).append(" 万字");
                    final JSONObject contBook = pickReading(arr);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            stat.setText(sb.toString());
                            if (sp != null) sp.edit().putString("statText", sb.toString()).apply();
                            if (contBook != null) {
                                cont.addView(continueCard(contBook));
                            }
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            stat.setText("连不上服务器：" + e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    private String dlDirName() {
        String n = sp.getString("dlTreeName", "");
        return n == null || n.isEmpty() ? "系统下载目录 Download" : n;
    }

    private void pickDir() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(i, REQ_DIR);
        } catch (Throwable t) {
            toast("这台手机没有目录选择器，只能用默认下载目录");
        }
    }

    private void editConfig() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(20), dp(8), dp(20), 0);
        final EditText e1 = new EditText(this);
        e1.setText(base());
        e1.setHint("http://服务器地址:端口");
        e1.setSingleLine(true);
        e1.setTextSize(13);
        e1.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        final EditText e2 = new EditText(this);
        e2.setText(key());
        e2.setHint("api_key");
        e2.setSingleLine(true);
        e2.setTextSize(13);
        l.addView(tv("服务器地址", 12, C_DIM, false));
        l.addView(e1);
        l.addView(tv("导入密钥", 12, C_DIM, false));
        l.addView(e2);

        LinearLayout dlRow = new LinearLayout(this);
        dlRow.setOrientation(LinearLayout.HORIZONTAL);
        dlRow.setGravity(Gravity.CENTER_VERTICAL);
        dlRow.setPadding(0, dp(14), 0, 0);
        TextView dlTxt = tv("下载目录：" + dlDirName(), 12, C_DIM, false);
        dlTxt.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button dlPick = btn("选择", false);
        dlPick.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { pickDir(); }
        });
        Button dlReset = btn("默认", false);
        dlReset.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                sp.edit().remove("dlTree").remove("dlTreeName").apply();
                toast("已恢复为系统下载目录（Download）");
                editConfig();
            }
        });
        dlRow.addView(dlTxt);
        dlRow.addView(dlPick);
        dlRow.addView(dlReset);
        l.addView(dlRow);

        TextView dlHint = tv("番茄下载的 txt 会存到这里；不选就是系统「下载」文件夹", 11, C_DIM, false);
        dlHint.setPadding(0, dp(6), 0, 0);
        l.addView(dlHint);

        final CheckBox cbUp = new CheckBox(this);
        cbUp.setText("下载完自动入库到书库");
        cbUp.setTextSize(12);
        cbUp.setTextColor(C_TXT);
        cbUp.setChecked(sp.getBoolean("autoUp", true));
        cbUp.setPadding(0, dp(10), 0, 0);
        l.addView(cbUp);
        int pend = app.fq.Bridge.pendingCount(this);
        if (pend > 0) {
            TextView pt = tv("有 " + pend + " 本没传上去，连上网会自动重试", 11, C_DIM, false);
            pt.setPadding(0, dp(2), 0, 0);
            l.addView(pt);
        }
        new AlertDialog.Builder(this)
                .setTitle("连接设置")
                .setView(l)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        String b = e1.getText().toString().trim();
                        if (!b.startsWith("http")) {
                            b = "http://" + b;
                        }
                        sp.edit().putString("base", b)
                                .putString("key", e2.getText().toString().trim())
                                .putBoolean("autoUp", cbUp.isChecked()).apply();
                        toast("已保存");
                        if (cbUp.isChecked()) app.fq.Bridge.flushPending(MainActivity.this);
                        showHome();
                    }
                }).show();
    }

    /* ---------------- 上传 ---------------- */

    private void showUpload() {
        screen = 1;
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);

        col.addView(toolbar("上传小说", true));

        TextView tip = tv("支持 txt / md / zip，可多选；zip 会按文件拆成多本", 12, C_DIM, false);
        tip.setPadding(dp(20), 0, dp(20), dp(10));
        col.addView(tip);

        Button pick = btn("选择文件", true);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pp.setMargins(dp(16), 0, dp(16), dp(10));
        pick.setLayoutParams(pp);
        pick.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                pickFiles();
            }
        });
        col.addView(pick);

        ScrollView sv = new ScrollView(this);
        uploadList = new LinearLayout(this);
        uploadList.setOrientation(LinearLayout.VERTICAL);
        sv.addView(uploadList);
        col.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContent(col);
    }

    private void pickFiles() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(Intent.createChooser(i, "选择小说文件"), PICK);
        } catch (Exception e) {
            toast("打不开文件选择器：" + e);
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_DIR) {
            if (res == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(tree,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (Throwable ignore) { }
                String name = tree.getLastPathSegment();
                try {
                    String id = DocumentsContract.getTreeDocumentId(tree);
                    if (id != null && id.contains(":")) {
                        String sub = id.substring(id.indexOf(':') + 1);
                        if (!sub.isEmpty()) name = sub;
                        else name = id.substring(0, id.indexOf(':')).replace("primary", "内部存储");
                    }
                } catch (Throwable ignore) { }
                sp.edit().putString("dlTree", tree.toString())
                        .putString("dlTreeName", name == null ? "已选目录" : name).apply();
                toast("下载目录已改成：" + (name == null ? "已选目录" : name));
                editConfig();
            }
            return;
        }
        if (req == PICK) {
            if (res != RESULT_OK || data == null) {
                return;
            }
            queue.clear();
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                for (int i = 0; i < n; i++) {
                    queue.add(data.getClipData().getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                queue.add(data.getData());
            }
            if (screen != 1) {
                showUpload();
            }
            runUploads();
            return;
        }
        super.onActivityResult(req, res, data);
    }

    private String nameOf(Uri u) {
        String name = null;
        try {
            Cursor c = getContentResolver().query(u, null, null, null, null);
            if (c != null) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (c.moveToFirst() && idx >= 0) {
                    name = c.getString(idx);
                }
                c.close();
            }
        } catch (Exception ignored) {
        }
        if (name == null) {
            name = u.getLastPathSegment();
        }
        return name == null ? "book.txt" : name;
    }

    private void runUploads() {
        final List<Uri> files = new ArrayList<Uri>(queue);
        queue.clear();
        new Thread(new Runnable() {
            public void run() {
                for (final Uri u : files) {
                    final String name = nameOf(u);
                    final TextView row = tv("上传中… " + name, 12.5f, C_DIM, false);
                    row.setPadding(dp(20), dp(8), dp(20), dp(8));
                    runOnUiThread(new Runnable() {
                        public void run() {
                            uploadList.addView(row, 0);
                        }
                    });
                    String msg;
                    try {
                        byte[] data = readAll(u);
                        String url = base() + "/api/import?key=" + URLEncoder.encode(key(), "UTF-8")
                                + "&filename=" + URLEncoder.encode(name, "UTF-8");
                        JSONObject o = new JSONObject(postRaw(url, data));
                        if (o.optBoolean("ok")) {
                            msg = "✓ " + name + " · " + o.optString("title") + " · "
                                    + o.optInt("chapters") + " 章 · " + o.optInt("chars") + " 字";
                        } else {
                            msg = "✗ " + name + "：" + o.optString("err", "失败");
                        }
                    } catch (Exception e) {
                        msg = "✗ " + name + "：" + e.getMessage();
                    }
                    final String text = msg;
                    runOnUiThread(new Runnable() {
                        public void run() {
                            row.setText(text);
                            row.setTextColor(text.startsWith("✓") ? C_ACC2 : 0xFFFF6B6B);
                        }
                    });
                }
            }
        }).start();
    }

    private byte[] readAll(Uri u) throws Exception {
        InputStream in = getContentResolver().openInputStream(u);
        if (in == null) {
            throw new Exception("读不到文件");
        }
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
        }
        in.close();
        return bo.toByteArray();
    }

    /* ---------------- 下载 / 管理 ---------------- */

    private void showDownload() {
        screen = 2;
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = toolbar("服务器藏书", true);
        Button all = btn("全部 zip", false);
        all.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                download(base() + "/dl/all");
            }
        });
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ap.leftMargin = dp(8);
        bar.addView(all, ap);
        col.addView(bar);

        ScrollView sv = new ScrollView(this);
        bookList = new LinearLayout(this);
        bookList.setOrientation(LinearLayout.VERTICAL);
        bookList.setPadding(0, dp(4), 0, dp(24));
        sv.addView(bookList);
        col.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContent(col);
        loadBooks();
    }

    private void loadBooks() {
        bookList.removeAllViews();
        bookList.addView(tv("读取中…", 12, C_DIM, false));
        new Thread(new Runnable() {
            public void run() {
                try {
                    JSONObject o = new JSONObject(get(base() + "/api/books"));
                    final JSONArray arr = o.getJSONArray("data");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            bookList.removeAllViews();
                            if (arr.length() == 0) {
                                bookList.addView(tv("服务器上还没有书，先上传一本试试。", 12.5f, C_DIM, false));
                                return;
                            }
                            for (int i = 0; i < arr.length(); i++) {
                                JSONObject b = arr.optJSONObject(i);
                                if (b == null) {
                                    continue;
                                }
                                bookList.addView(bookRow(b));
                            }
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            bookList.removeAllViews();
                            bookList.addView(tv("连不上服务器：" + e.getMessage(), 12.5f, 0xFFFF6B6B, false));
                        }
                    });
                }
            }
        }).start();
    }

    private View bookRow(final JSONObject b) {
        final int id = b.optInt("id");
        final String title = b.optString("title", "未命名");
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable g = new GradientDrawable();
        g.setColor(C_CARD);
        g.setCornerRadius(dp(14));
        g.setStroke(dp(1), C_LINE);
        l.setBackground(g);
        l.setPadding(dp(14), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(16), 0, dp(16), dp(8));
        l.setLayoutParams(lp);

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        mid.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        mid.addView(tv(title, 14.5f, C_TXT, true));
        mid.addView(tv(b.optInt("chapters") + " 章 · " + b.optInt("chars") + " 字", 11.5f, C_DIM, false));
        l.addView(mid);

        Button dl = btn("下载", true);
        dl.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                download(base() + "/dl/" + id);
            }
        });
        l.addView(dl);

        Button del = btn("删除", false);
        LinearLayout.LayoutParams dp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dp2.leftMargin = dp(6);
        del.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                confirmDelete(id, title);
            }
        });
        l.addView(del, dp2);
        return l;
    }

    private void confirmDelete(final int id, String title) {
        new AlertDialog.Builder(this)
                .setTitle("删除《" + title + "》？")
                .setMessage("服务器上的这本书和它的全部章节都会被删掉。")
                .setNegativeButton("取消", null)
                .setPositiveButton("删除", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        new Thread(new Runnable() {
                            public void run() {
                                String msg;
                                try {
                                    JSONObject o = new JSONObject(postRaw(
                                            base() + "/api/delete?key=" + URLEncoder.encode(key(), "UTF-8")
                                                    + "&id=" + id, new byte[0]));
                                    msg = o.optBoolean("ok") ? "已删除" : ("删除失败：" + o.optString("err"));
                                } catch (Exception e) {
                                    msg = "删除失败：" + e.getMessage();
                                }
                                final String m = msg;
                                runOnUiThread(new Runnable() {
                                    public void run() {
                                        toast(m);
                                        loadBooks();
                                    }
                                });
                            }
                        }).start();
                    }
                }).show();
    }

    private void download(String url) {
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setTitle("书库下载");
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, guessName(url));
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
            toast("已开始下载，完成后在「下载」文件夹");
        } catch (Exception e) {
            toast("下载失败：" + e);
        }
    }

    private String guessName(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            c.setRequestMethod("HEAD");
            String cd = c.getHeaderField("Content-Disposition");
            String name = URLUtil.guessFileName(url, cd, null);
            if (cd != null) {
                Matcher m = Pattern.compile("filename\\*=UTF-8''([^;]+)").matcher(cd);
                if (m.find()) {
                    name = java.net.URLDecoder.decode(m.group(1).trim(), "UTF-8");
                }
            }
            return name;
        } catch (Exception e) {
            return URLUtil.guessFileName(url, null, null);
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    /* ---------------- 阅读（网站） ---------------- */

    private void parseReadUrl(String url) {
        if (url == null) return;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("/(?:read|book)/(\\d+)(?:/(\\d+))?").matcher(url);
        if (m.find()) {
            curBid = Integer.parseInt(m.group(1));
            curIdx = m.group(2) == null ? 0 : Integer.parseInt(m.group(2));
        }
    }

    private void showReader(String url) {
        screen = 3;
        parseReadUrl(url);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(10), dp(8), dp(10), dp(6));
        TextView back = iconBtn("\u2039");
        back.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showShelf(); }
        });
        bar.addView(back);
        TextView t = tv("阅读", 14.5f, C_TXT, true);
        t.setPadding(dp(8), 0, dp(4), 0);
        t.setSingleLine(true);
        t.setEllipsize(android.text.TextUtils.TruncateAt.END);
        bar.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView aa = iconBtn("Aa");
        aa.setTextSize(13);
        aa.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { readerStyle(); }
        });
        bar.addView(aa);
        col.addView(bar);
        col.addView(hairline());

        final ProgressBar pb = new ProgressBar(this, null,
                android.R.attr.progressBarStyleHorizontal);
        pb.setMax(100);
        col.addView(pb, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        web = new WebView(this);
        col.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        android.webkit.WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setSupportZoom(false);
        ws.setUserAgentString(ws.getUserAgentString() + " NovelShelf/2.0");
        if (Build.VERSION.SDK_INT >= 21) {
            ws.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String u) {
                pb.setVisibility(View.GONE);
                applyReaderStyle();
                if (pendingOffline) {
                    pendingOffline = false;
                    v.evaluateJavascript("(function(){var b=document.getElementById('dlOff');"
                            + "if(b){b.click();return 'ok'}return 'no'})()", null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                pb.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
                pb.setProgress(p);
            }
        });
        web.setDownloadListener(new DownloadListener() {
            public void onDownloadStart(String url, String ua, String cd, String mime, long len) {
                download(url);
            }
        });

        col.addView(hairline());
        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.addView(navBtn("\u2039 上一章", new View.OnClickListener() {
            public void onClick(View v) { loadChapter(curIdx - 1); }
        }));
        nav.addView(navBtn("目录", new View.OnClickListener() {
            public void onClick(View v) { tocDialog(); }
        }));
        nav.addView(navBtn("下一章 \u203A", new View.OnClickListener() {
            public void onClick(View v) { loadChapter(curIdx + 1); }
        }));
        col.addView(nav);

        web.loadUrl(url);
        setContent(col);
    }

    private TextView navBtn(String label, View.OnClickListener l) {
        TextView t = tv(label, 12.5f, C_TXT, true);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, dp(13), 0, dp(13));
        t.setOnClickListener(l);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return t;
    }

    private void loadChapter(int idx) {
        if (curBid <= 0) return;
        if (idx < 0) idx = 0;
        curIdx = idx;
        if (web != null) web.loadUrl(base() + "/read/" + curBid + "/" + idx);
    }

    private void tocDialog() {
        if (curBid <= 0) return;
        new Thread(new Runnable() {
            public void run() {
                try {
                    JSONObject o = new JSONObject(get(base() + "/api/toc?book=" + curBid));
                    final JSONArray arr = o.getJSONArray("data");
                    final String[] names = new String[arr.length()];
                    for (int i = 0; i < arr.length(); i++) {
                        names[i] = arr.getJSONObject(i).optString("title", "第 " + (i + 1) + " 章");
                    }
                    runOnUiThread(new Runnable() {
                        public void run() {
                            if (names.length == 0) {
                                Toast.makeText(MainActivity.this, "没有章节", Toast.LENGTH_SHORT).show();
                                return;
                            }
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("目录 · 共 " + names.length + " 章")
                                    .setItems(names, new DialogInterface.OnClickListener() {
                                        public void onClick(DialogInterface d, int i) { loadChapter(i); }
                                    }).show();
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() { Toast.makeText(MainActivity.this, "目录读取失败", Toast.LENGTH_SHORT).show(); }
                    });
                }
            }
        }).start();
    }

    private void readerStyle() {
        final String[] items = {"字号 15", "字号 17", "字号 19", "字号 22",
                "背景 · 白", "背景 · 米黄", "背景 · 护眼绿", "背景 · 夜"};
        new AlertDialog.Builder(this).setTitle("阅读外观").setItems(items, new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface d, int i) {
                SharedPreferences.Editor ed = sp.edit();
                if (i < 4) {
                    int[] fs = {15, 17, 19, 22};
                    ed.putInt("rfs", fs[i]);
                } else {
                    String[] pp = {"p0", "p1", "p2", "p3"};
                    ed.putString("rpaper", pp[i - 4]);
                }
                ed.apply();
                applyReaderStyle();
            }
        }).show();
    }

    private void applyReaderStyle() {
        if (web == null || sp == null) return;
        int fs = sp.getInt("rfs", 17);
        String paper = sp.getString("rpaper", "p0");
        String js = "(function(){var r=document.querySelector('.rbody');if(r){r.style.setProperty('--fs','"
                + fs + "px');}document.documentElement.dataset.paper='" + paper + "';})()";
        web.evaluateJavascript(js, null);
    }

    /* ---------------- 检查更新 ---------------- */

    private void checkUpdate(final LinearLayout col) {
        new Thread(new Runnable() {
            public void run() {
                try {
                    String mine = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                    JSONObject o = new JSONObject(get(base() + "/api/appver"));
                    final String ver = o.optString("version", "");
                    if (ver.isEmpty() || ver.equals("0") || ver.equals(mine)) return;
                    runOnUiThread(new Runnable() {
                        public void run() {
                            TextView up = tv("\u2191 发现新版本 " + ver + "，点这里下载", 12.5f, C_ACC, true);
                            up.setPadding(dp(22), dp(8), dp(22), 0);
                            up.setOnClickListener(new View.OnClickListener() {
                                public void onClick(View v) {
                                    download(base() + "/app.apk");
                                    Toast.makeText(MainActivity.this, "下载中，完成后在通知栏点开安装",
                                            Toast.LENGTH_LONG).show();
                                }
                            });
                            col.addView(up);
                        }
                    });
                } catch (Throwable ignore) { }
            }
        }).start();
    }

    /* ---------------- 下载完成 → 自动入库 ---------------- */

    private void registerDm() {
        dmReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent in) {
                if (in == null || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(in.getAction())) return;
                long id = in.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id > 0) checkDm(id);
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(dmReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(dmReceiver, f);
        }
    }

    private void checkDm(final long id) {
        new Thread(new Runnable() {
            public void run() {
                try {
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    DownloadManager.Query q = new DownloadManager.Query();
                    q.setFilterById(id);
                    Cursor cur = dm.query(q);
                    if (cur == null) return;
                    String name = null;
                    String uriS = null;
                    int st = -1;
                    if (cur.moveToFirst()) {
                        name = cur.getString(cur.getColumnIndex(DownloadManager.COLUMN_TITLE));
                        uriS = cur.getString(cur.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI));
                        st = cur.getInt(cur.getColumnIndex(DownloadManager.COLUMN_STATUS));
                    }
                    cur.close();
                    if (st != DownloadManager.STATUS_SUCCESSFUL || uriS == null || name == null) return;
                    String low = name.toLowerCase();
                    if (!(low.endsWith(".txt") || low.endsWith(".md") || low.endsWith(".zip"))) return;
                    InputStream in = getContentResolver().openInputStream(Uri.parse(uriS));
                    if (in == null) return;
                    byte[] body = readAll(in);
                    in.close();
                    final String r = postRaw(base() + "/api/import?key=" + Uri.encode(key())
                            + "&filename=" + Uri.encode(name), body);
                    final JSONObject o = new JSONObject(r);
                    final String msg;
                    if (o.optBoolean("ok")) {
                        msg = "✓ 已入库《" + o.optString("title", name) + "》· " + o.optInt("chapters") + " 章";
                    } else if (o.optBoolean("dup")) {
                        msg = "《" + o.optString("title", name) + "》库里已经有了，跳过";
                    } else {
                        msg = "入库失败：" + o.optString("err", "未知");
                    }
                    runOnUiThread(new Runnable() {
                        public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show(); }
                    });
                } catch (Throwable ignore) { }
            }
        }).start();
    }

    /* ---------------- HTTP ---------------- */

    private String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "application/json");
        InputStream in = c.getInputStream();
        String s = new String(readAll(in), "UTF-8");
        in.close();
        c.disconnect();
        return s;
    }

    private String postRaw(String url, byte[] body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(120000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(body.length);
        c.setRequestProperty("Content-Type", "application/octet-stream");
        OutputStream out = c.getOutputStream();
        out.write(body);
        out.flush();
        out.close();
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String s = in == null ? "" : new String(readAll(in), "UTF-8");
        if (in != null) {
            in.close();
        }
        c.disconnect();
        return s;
    }

    private byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
        }
        return bo.toByteArray();
    }

    /* ---------------- 主题 ---------------- */

    private void initColors() {
        String t = sp == null ? "dark" : sp.getString("theme", "dark");
        light = "light".equals(t);
        if (light) {
            C_BG = 0xFFF4F6FA;
            C_CARD = 0xFFFFFFFF;
            C_LINE = 0xFFE2E6EE;
            C_TXT = 0xFF14161C;
            C_DIM = 0xFF7A8290;
            C_ACC = 0xFF3B5BDB;
            C_ACC2 = 0xFF5B8DEF;
            C_SOFT = 0xFFEDF0F6;
        } else {
            C_BG = 0xFF07070B;
            C_CARD = 0xFF14141C;
            C_LINE = 0xFF2A2A36;
            C_TXT = 0xFFF2F2F7;
            C_DIM = 0xFF8B8B96;
            C_ACC = 0xFF7C5CFF;
            C_ACC2 = 0xFF4CC9F0;
            C_SOFT = 0xFF1E1E28;
        }
    }

    private void paintBars() {
        try {
            Window w = getWindow();
            w.setStatusBarColor(C_BG);
            w.setNavigationBarColor(C_BG);
            if (Build.VERSION.SDK_INT >= 30) {
                android.view.WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    c.setSystemBarsAppearance(light ? mask : 0, mask);
                }
            } else {
                View dv = w.getDecorView();
                int f = dv.getSystemUiVisibility();
                if (light) {
                    f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    if (Build.VERSION.SDK_INT >= 26) f |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                } else {
                    f &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    if (Build.VERSION.SDK_INT >= 26) f &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
                dv.setSystemUiVisibility(f);
            }
        } catch (Throwable ignore) { }
    }

    private void toggleTheme() {
        light = !light;
        sp.edit().putString("theme", light ? "light" : "dark").apply();
        initColors();
        paintBars();
        if (host != null) host.setBackgroundColor(C_BG);
        buildNav();
        pushThemeToWeb();
        int keep = screen;
        if (keep == 4) showShelf();
        else if (keep == 5) showFanqie();
        else showHome();
    }

    private void pushThemeToWeb() {
        if (fq == null) return;
        String cls = light ? "theme-light" : "theme-dark";
        String js = "(function(){try{var b=document.body;if(!b)return;b.classList.remove('theme-dark');"
                + "b.classList.remove('theme-light');b.classList.add('" + cls + "');"
                + "localStorage.setItem('fq_theme',JSON.stringify('" + cls + "'));}catch(e){}})()";
        try { fq.evaluateJavascript(js, null); } catch (Throwable ignore) { }
    }

    /** 番茄页里切了主题，通知原生这边同步 */
    public void onExternalTheme(final boolean lightTheme) {
        runOnUiThread(new Runnable() {
            public void run() {
                try {
                    initColors();
                    paintBars();
                    if (host != null) host.setBackgroundColor(C_BG);
                    buildNav();
                    if (screen == 0) showHome();
                    else if (screen == 4) showShelf();
                } catch (Throwable ignore) { }
            }
        });
    }

    /* ---------------- 底部导航 ---------------- */

    private void buildNav() {
        if (navBar == null) return;
        navBar.removeAllViews();
        navBar.setOrientation(LinearLayout.VERTICAL);
        navBar.setBackgroundColor(C_CARD);
        navBar.setPadding(0, 0, 0, 0);
        navBar.addView(hairline());
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(6), dp(6), dp(6), dp(8));
        navBar.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        String[] icons = {"\u2630", "\u25A6", "\u2B07"};
        String[] names = {"书库", "书架", "番茄"};
        for (int i = 0; i < 3; i++) {
            final int idx = i;
            LinearLayout it = new LinearLayout(this);
            it.setOrientation(LinearLayout.VERTICAL);
            it.setGravity(Gravity.CENTER);
            it.setPadding(0, dp(4), 0, dp(6));
            it.setLayoutParams(new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView ic = new TextView(this);
            ic.setText(icons[i]);
            ic.setTextSize(17);
            ic.setGravity(Gravity.CENTER);
            ic.setTextColor(idx == tab ? C_ACC : C_DIM);
            TextView lb = new TextView(this);
            lb.setText(names[i]);
            lb.setTextSize(10.5f);
            lb.setGravity(Gravity.CENTER);
            lb.setTextColor(idx == tab ? C_ACC : C_DIM);
            it.addView(ic);
            it.addView(lb);
            it.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { selectTab(idx); }
            });
            row.addView(it);
        }
    }

    private void setNavActive(int i) {
        tab = i;
        buildNav();
    }

    private void selectTab(int i) {
        if (i == 0) showHome();
        else if (i == 1) showShelf();
        else showFanqie();
    }

    /* ---------------- 番茄下载 ---------------- */

    private static final String FQ_HOST = "appassets.local";

    private void showFanqie() {
        screen = 5;
        initColors();
        setNavActive(2);
        if (fq == null) {
            fq = buildFq();
        }
        contentHost.removeAllViews();
        contentHost.addView(fq, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (navBar != null) navBar.setVisibility(View.VISIBLE);
        pushThemeToWeb();
    }

    private String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private WebView buildFq() {
        WebView w = new WebView(this);
        w.setBackgroundColor(C_BG);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        android.webkit.WebSettings st = w.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setDatabaseEnabled(true);
        st.setUseWideViewPort(true);
        st.setLoadWithOverviewMode(true);
        st.setSupportZoom(false);
        st.setBuiltInZoomControls(false);
        st.setMediaPlaybackRequiresUserGesture(false);
        st.setCacheMode(android.webkit.WebSettings.LOAD_DEFAULT);
        st.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        st.setSupportMultipleWindows(false);
        if (Build.VERSION.SDK_INT >= 26) st.setSafeBrowsingEnabled(false);
        w.addJavascriptInterface(new app.fq.Bridge(this, w), "Android");
        w.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pushThemeToWeb();
            }

            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view, android.webkit.WebResourceRequest req) {
                try {
                    Uri u = req.getUrl();
                    if (u != null && FQ_HOST.equals(u.getHost())) {
                        String pth = u.getPath();
                        if (pth == null || pth.length() == 0 || "/".equals(pth)) pth = "/index.html";
                        String name = pth.startsWith("/") ? pth.substring(1) : pth;
                        try {
                            if ("index.html".equals(name)) {
                                InputStream is = getAssets().open(name);
                                byte[] raw = readAll(is);
                                is.close();
                                String th = light ? "theme-light" : "theme-dark";
                                String html = new String(raw, "utf-8");
                                String bcls = light ? "theme-light" : "theme-dark";
                                html = html.replace("<head>",
                                        "<head><script>try{localStorage.setItem('fq_theme',JSON.stringify('" + th
                                                + "'));}catch(e){}</script>"
                                        + "<style>#themeBtn{display:none!important}</style>");
                                html = html.replace("class=\"theme-dark\"", "class=\"" + bcls + "\"");
                                return new android.webkit.WebResourceResponse("text/html", "utf-8",
                                        new java.io.ByteArrayInputStream(html.getBytes("utf-8")));
                            }
                            InputStream is = getAssets().open(name);
                            return new android.webkit.WebResourceResponse(mimeOf(name), "utf-8", is);
                        } catch (Exception e) {
                            return new android.webkit.WebResourceResponse("text/plain", "utf-8",
                                    new java.io.ByteArrayInputStream(("not found: " + name).getBytes()));
                        }
                    }
                } catch (Throwable ignore) { }
                return null;
            }
        });
        w.setDownloadListener(new DownloadListener() {
            public void onDownloadStart(String url, String ua, String cd, String mime, long len) {
                try {
                    DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                    String name = URLUtil.guessFileName(url, cd, mime);
                    r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    dm.enqueue(r);
                    toast("开始下载 " + name);
                } catch (Throwable e) {
                    toast("下载失败：" + e.getMessage());
                }
            }
        });
        w.loadUrl("https://" + FQ_HOST + "/index.html");
        return w;
    }

    /* ---------------- 返回键 ---------------- */

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            if (screen == 3 && web != null && web.canGoBack()) {
                web.goBack();
                return true;
            }
            if (screen == 5 && web != null) {
                if (app.fq.Bridge.sheetOpen) {
                    web.evaluateJavascript("(function(){try{var m=document.querySelector('.mask,.sheetMask,.sheet-mask,#mask');"
                            + "if(m){m.click();return 'ok'}document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));"
                            + "return 'esc'}catch(e){return 'err'}})()", null);
                    return true;
                }
                if (web.canGoBack()) {
                    web.goBack();
                    return true;
                }
            }
            if (screen != 0) {
                showHome();
                return true;
            }
        }
        return super.onKeyDown(code, e);
    }

    /* ---------------- 继续阅读 / 书架 ---------------- */

    private JSONObject pickReading(JSONArray arr) {
        JSONObject best = null;
        int bestIdx = 0;
        for (int i = 0; i < arr.length(); i++) {
            try {
                JSONObject b = arr.getJSONObject(i);
                int li = b.optInt("last_idx", 0);
                if (li > bestIdx) { bestIdx = li; best = b; }
            } catch (Throwable ignore) { }
        }
        return best;
    }

    private int coverColor(String s) {
        int[] pal = {0xFF3B5BDB, 0xFF7048E8, 0xFF1C7ED6, 0xFF0CA678,
                0xFFE8590C, 0xFFD6336C, 0xFF1098AD, 0xFF846358};
        int h = 7;
        for (int i = 0; i < s.length(); i++) h = h * 31 + s.charAt(i);
        return pal[Math.abs(h) % pal.length];
    }

    private final java.util.HashMap<String, Bitmap> cvMem = new java.util.HashMap<String, Bitmap>();
    private java.util.concurrent.ExecutorService cvPool =
            java.util.concurrent.Executors.newFixedThreadPool(3);

    private Bitmap roundBmp(Bitmap src, int radius) {
        try {
            int w = src.getWidth(), h = src.getHeight();
            Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(out);
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            RectF rf = new RectF(0, 0, w, h);
            c.drawRoundRect(rf, radius, radius, p);
            p.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
            c.drawBitmap(src, new Rect(0, 0, w, h), rf, p);
            return out;
        } catch (Throwable t) {
            return src;
        }
    }

    private Bitmap centerCrop(Bitmap src, int tw, int th) {
        try {
            int w = src.getWidth(), h = src.getHeight();
            float r = Math.max((float) tw / w, (float) th / h);
            int nw = Math.round(w * r), nh = Math.round(h * r);
            Bitmap s2 = Bitmap.createScaledBitmap(src, nw, nh, true);
            int x = Math.max(0, (nw - tw) / 2), y = Math.max(0, (nh - th) / 2);
            if (x + tw > nw) x = Math.max(0, nw - tw);
            if (y + th > nh) y = Math.max(0, nh - th);
            return Bitmap.createBitmap(s2, x, y, Math.min(tw, nw), Math.min(th, nh));
        } catch (Throwable t) {
            return src;
        }
    }

    private byte[] httpBytes(String url) {
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(12000);
            c.setRequestProperty("User-Agent", "shuku-app");
            if (c.getResponseCode() != 200) return null;
            java.io.InputStream is = c.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            is.close();
            return bo.toByteArray();
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) try { c.disconnect(); } catch (Throwable ignore) { }
        }
    }

    private void loadCover(final ImageView iv, final View holder, final int bid,
                           final String title, final int w, final int h) {
        final String key = "c" + bid;
        Bitmap mem = cvMem.get(key);
        if (mem != null) {
            iv.setImageBitmap(mem);
            return;
        }
        cvPool.execute(new Runnable() {
            public void run() {
                byte[] data = null;
                try {
                    java.io.File f = new java.io.File(getCacheDir(), "covers/" + bid + ".img");
                    if (f.exists() && f.length() > 800) {
                        data = new byte[(int) f.length()];
                        java.io.FileInputStream in = new java.io.FileInputStream(f);
                        int off = 0, n;
                        while (off < data.length && (n = in.read(data, off, data.length - off)) > 0) off += n;
                        in.close();
                    }
                } catch (Throwable ignore) { }
                if (data == null) {
                    data = httpBytes(base() + "/cover/" + bid);
                    if (data != null && data.length > 800) {
                        try {
                            java.io.File dir = new java.io.File(getCacheDir(), "covers");
                            dir.mkdirs();
                            java.io.FileOutputStream fo = new java.io.FileOutputStream(
                                    new java.io.File(dir, bid + ".img"));
                            fo.write(data);
                            fo.close();
                        } catch (Throwable ignore) { }
                    }
                }
                if (data == null || data.length < 800) return;
                Bitmap bm = BitmapFactory.decodeByteArray(data, 0, data.length);
                if (bm == null) return;
                final Bitmap fin = roundBmp(centerCrop(bm, dp(w) * 2, dp(h) * 2), dp(9) * 2);
                runOnUiThread(new Runnable() {
                    public void run() {
                        cvMem.put(key, fin);
                        holder.setVisibility(View.GONE);
                        iv.setImageBitmap(fin);
                    }
                });
            }
        });
    }

    private View coverView(final org.json.JSONObject b, final int w, final int h) {
        final int bid = b.optInt("id", 0);
        final String title = b.optString("title", "");
        FrameLayout box = new FrameLayout(this);
        box.setLayoutParams(new LinearLayout.LayoutParams(dp(w), dp(h)));
        ImageView iv = new ImageView(this);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        box.addView(iv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View ph = coverBlock(title, w, h);
        box.addView(ph, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (bid > 0) loadCover(iv, ph, bid, title, w, h);
        return box;
    }

    private View coverBlock(String title, int w, int h) {
        TextView t = new TextView(this);
        String c = title == null || title.isEmpty() ? "书" : title.substring(0, 1);
        t.setText(c);
        t.setTextSize(w <= 60 ? 20 : 26);
        t.setTextColor(0xFFFFFFFF);
        t.setTypeface(Typeface.create("serif", Typeface.BOLD));
        t.setGravity(Gravity.CENTER);
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{coverColor(title == null ? "" : title), 0xFF1B1B24});
        g.setCornerRadius(dp(9));
        t.setBackground(g);
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(w), dp(h)));
        return t;
    }

    private View continueCard(final JSONObject b) {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable g = new GradientDrawable();
        g.setColor(0xFF17203A);
        g.setCornerRadius(dp(16));
        g.setStroke(dp(1), 0xFF2E3E66);
        l.setBackground(g);
        l.setPadding(dp(14), dp(14), dp(14), dp(14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(20), dp(6), dp(20), dp(4));
        l.setLayoutParams(lp);

        l.addView(coverView(b, 46, 62));

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        mid.setPadding(dp(12), 0, dp(8), 0);
        mid.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        mid.addView(tv("接着读", 10.5f, 0xFF7EA6FF, true));
        mid.addView(tv(b.optString("title", "未命名"), 15, C_TXT, true));
        mid.addView(tv("第 " + (b.optInt("last_idx", 0) + 1) + " 章 · 已读 "
                + b.optInt("progress", 0) + "%", 11.5f, C_DIM, false));
        l.addView(mid);

        Button go = btn("继续", true);
        go.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                showReader(base() + "/read/" + b.optInt("id") + "/"
                        + b.optInt("last_idx", 0) + "?resume=1");
            }
        });
        l.addView(go);
        return l;
    }

    private void showShelf() {
        screen = 4;
        initColors();
        setNavActive(1);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = toolbar("书架", true);
        TextView rf = iconBtn("\u27F3");
        rf.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showShelf(); }
        });
        bar.addView(rf);
        col.addView(bar);
        col.addView(hairline());

        LinearLayout srow = new LinearLayout(this);
        srow.setOrientation(LinearLayout.HORIZONTAL);
        srow.setGravity(Gravity.CENTER_VERTICAL);
        srow.setPadding(dp(16), dp(8), dp(16), dp(2));
        shelfInput = new EditText(this);
        shelfInput.setSingleLine(true);
        shelfInput.setTextSize(13);
        shelfInput.setHint("搜书名 / 作者 / 分类");
        shelfInput.setTextColor(C_TXT);
        shelfInput.setHintTextColor(C_DIM);
        shelfInput.setText(shelfQ);
        GradientDrawable sg = new GradientDrawable();
        sg.setColor(C_SOFT);
        sg.setCornerRadius(dp(11));
        shelfInput.setBackground(sg);
        shelfInput.setPadding(dp(12), dp(4), dp(12), dp(4));
        srow.addView(shelfInput, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        col.addView(srow);

        final LinearLayout chips = new LinearLayout(this);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        chips.setPadding(dp(16), dp(0), dp(16), dp(6));
        col.addView(chips);

        final LinearLayout recentBox = new LinearLayout(this);
        recentBox.setOrientation(LinearLayout.VERTICAL);
        col.addView(recentBox);
        fillRecent(recentBox);

        final LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        ScrollView sv = new ScrollView(this);
        sv.addView(list);
        col.addView(sv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        final TextView hint = tv("", 12, C_DIM, false);
        hint.setPadding(dp(22), dp(6), dp(22), dp(6));
        col.addView(hint);

        setContent(col);
        buildChips(chips, list, hint);
        shelfInput.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            public void onTextChanged(CharSequence s, int a, int b, int c) { }
            public void afterTextChanged(Editable s) {
                shelfQ = s.toString().trim();
                reloadShelf(list, hint);
            }
        });
        reloadShelf(list, hint);
    }

    private String agoText(String added) {
        try {
            String d = added == null ? "" : added.trim();
            if (d.length() > 10) d = d.substring(0, 10);
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd");
            java.util.Date t = f.parse(d);
            long days = (System.currentTimeMillis() - t.getTime()) / 86400000L;
            if (days <= 0) return "今天";
            if (days == 1) return "昨天";
            if (days < 31) return days + " 天前";
            return d;
        } catch (Throwable e) {
            return added == null ? "" : added;
        }
    }

    private void fillRecent(final LinearLayout box) {
        box.removeAllViews();
        final String last = sp.getString("lastUp", "");
        if (last != null && !last.isEmpty()) {
            String[] p = last.split("\\|");
            try {
                long when = Long.parseLong(p.length > 2 ? p[2] : "0");
                if (System.currentTimeMillis() - when < 15 * 60 * 1000L) {
                    TextView b = tv("\u2713 刚刚入库《" + p[0] + "》· " + (p.length > 1 ? p[1] : "0") + " 章", 11.5f,
                            0xFF1B8A5A, false);
                    GradientDrawable g = new GradientDrawable();
                    g.setColor(0x1A1B8A5A);
                    g.setCornerRadius(dp(10));
                    b.setBackground(g);
                    b.setPadding(dp(12), dp(8), dp(12), dp(8));
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    lp.setMargins(dp(16), dp(8), dp(16), 0);
                    b.setLayoutParams(lp);
                    box.addView(b);
                }
            } catch (Throwable ignore) { }
        }
        new Thread(new Runnable() {
            public void run() {
                try {
                    String r = get(base() + "/api/books?sort=added&per=8");
                    JSONObject o = new JSONObject(r);
                    JSONArray arr = o.optJSONArray("data");
                    if (arr == null || arr.length() == 0) return;
                    final JSONArray a2 = arr;
                    runOnUiThread(new Runnable() {
                        public void run() {
                            try { buildRecent(box, a2); } catch (Throwable ignore) { }
                        }
                    });
                } catch (Throwable ignore) { }
            }
        }).start();
    }

    private void buildRecent(LinearLayout box, JSONArray arr) {
        box.removeAllViews();
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(18), dp(10), dp(18), dp(2));
        head.addView(tv("最近入库", 12.5f, C_DIM, true));
        TextView cnt = tv("  " + arr.length() + " 本", 11.5f, C_DIM, false);
        head.addView(cnt);
        box.addView(head);

        android.widget.HorizontalScrollView hs = new android.widget.HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(12), dp(4), dp(12), dp(10));
        for (int i = 0; i < arr.length(); i++) {
            final JSONObject b = arr.optJSONObject(i);
            if (b == null) continue;
            LinearLayout cell = new LinearLayout(this);
            cell.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(dp(72),
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.rightMargin = dp(10);
            cell.setLayoutParams(clp);
            cell.addView(coverView(b, 72, 96));
            TextView nm = tv(b.optString("title", ""), 11, C_TXT, false);
            nm.setMaxLines(1);
            nm.setEllipsize(android.text.TextUtils.TruncateAt.END);
            nm.setPadding(0, dp(5), 0, 0);
            cell.addView(nm);
            cell.addView(tv(agoText(b.optString("added")) + " · " + b.optInt("chapters") + " 章", 10, C_DIM, false));
            cell.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    showReader(base() + "/book/" + b.optInt("id"));
                }
            });
            row.addView(cell);
        }
        hs.addView(row);
        box.addView(hs);
        box.addView(hairline());
    }

    private void buildChips(LinearLayout chips, final LinearLayout list, final TextView hint) {
        chips.removeAllViews();
        String[][] defs = {{"all", "全部"}, {"reading", "在读"}, {"unread", "未读"}, {"done", "读完"}};
        for (int i = 0; i < defs.length; i++) {
            final String key = defs[i][0];
            boolean on = key.equals(shelfF);
            TextView c = tv(defs[i][1], 11.5f, on ? 0xFFFFFFFF : C_DIM, true);
            GradientDrawable g = new GradientDrawable();
            g.setColor(on ? C_ACC : C_SOFT);
            g.setCornerRadius(dp(20));
            c.setBackground(g);
            c.setPadding(dp(13), dp(5), dp(13), dp(5));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.rightMargin = dp(7);
            c.setLayoutParams(lp);
            c.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { shelfF = key; showShelf(); }
            });
            chips.addView(c);
        }
    }

    private void reloadShelf(final LinearLayout list, final TextView hint) {
        list.removeAllViews();
        hint.setText("读取中…");
        final String q = shelfQ;
        final String f = shelfF;
        new Thread(new Runnable() {
            public void run() {
                try {
                    String u = base() + "/api/books?per=200&sort=updated&f=" + f
                            + "&q=" + java.net.URLEncoder.encode(q, "UTF-8");
                    JSONObject o = new JSONObject(get(u));
                    final JSONArray arr = o.getJSONArray("data");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            hint.setText(q.isEmpty() ? (arr.length() + " 本") : ("找到 " + arr.length() + " 本"));
                            for (int i = 0; i < arr.length(); i++) {
                                try { list.addView(shelfRow(arr.getJSONObject(i))); } catch (Throwable ignore) { }
                            }
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() { hint.setText("连不上服务器：" + e.getMessage()); }
                    });
                }
            }
        }).start();
    }

    private void bookMenu(final JSONObject b) {
        final int id = b.optInt("id");
        final String title = b.optString("title", "未命名");
        final String[] items = {"下载 TXT 到手机", "番茄下载最近 50 章", "番茄下载指定章节",
                "整本离线缓存", "改分类", "删除（进回收站）"};
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setItems(items, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int i) {
                        if (i == 0) {
                            download(base() + "/dl/txt?ids=" + id);
                        } else if (i == 1) {
                            startFqRange(id, title, -50, 0);
                        } else if (i == 2) {
                            askRange(id, title);
                        } else if (i == 3) {
                            pendingOffline = true;
                            showReader(base() + "/book/" + id);
                            Toast.makeText(MainActivity.this, "开始缓存，请停在这一页别退出",
                                    Toast.LENGTH_LONG).show();
                        } else if (i == 4) {
                            changeCat(id);
                        } else {
                            new AlertDialog.Builder(MainActivity.this)
                                    .setMessage("把《" + title + "》放进回收站？30 天内还能恢复。")
                                    .setPositiveButton("删除", new DialogInterface.OnClickListener() {
                                        public void onClick(DialogInterface d2, int w) { bulkOp("delete", id); }
                                    })
                                    .setNegativeButton("算了", null).show();
                        }
                    }
                }).show();
    }

    private String jsStr(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ");
    }

    private void startFqRange(final int id, final String title, final int from, final int to) {
        showFanqie();
        final String js = (from == -50)
                ? "window.fqRangeLast && window.fqRangeLast('" + id + "','" + jsStr(title) + "',50)"
                : "window.fqRange && window.fqRange('" + id + "','" + jsStr(title) + "'," + from + "," + to + ")";
        runOnUiThread(new Runnable() {
            public void run() {
                try { fq.evaluateJavascript(js, null); } catch (Throwable ignore) { }
            }
        });
        Toast.makeText(this, "已加入下载队列，在番茄页可以看进度", Toast.LENGTH_SHORT).show();
    }

    private void askRange(final int id, final String title) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(10), dp(20), 0);
        final EditText e1 = new EditText(this);
        e1.setHint("从第几章开始（含）");
        e1.setInputType(InputType.TYPE_CLASS_NUMBER);
        final EditText e2 = new EditText(this);
        e2.setHint("到第几章结束（含），留空=到最后一章");
        e2.setInputType(InputType.TYPE_CLASS_NUMBER);
        box.addView(e1);
        box.addView(e2);
        new AlertDialog.Builder(this)
                .setTitle(title + " · 下载范围")
                .setView(box)
                .setPositiveButton("开始下载", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        int a = 1, b = 0;
                        try { a = Integer.parseInt(e1.getText().toString().trim()); } catch (Throwable ignore) { }
                        try { b = Integer.parseInt(e2.getText().toString().trim()); } catch (Throwable ignore) { }
                        if (a < 1) a = 1;
                        startFqRange(id, title, a - 1, b);
                    }
                })
                .setNegativeButton("算了", null).show();
    }

    private void changeCat(final int id) {
        final EditText e = new EditText(this);
        e.setHint("分类名，例如 玄幻 / 都市 / 未分类");
        e.setTextSize(14);
        new AlertDialog.Builder(this).setTitle("改分类").setView(e)
                .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        final String cat = e.getText().toString().trim();
                        if (cat.isEmpty()) return;
                        new Thread(new Runnable() {
                            public void run() {
                                try {
                                    String r = postRaw(base() + "/api/bulk?op=cat&key=" + Uri.encode(key())
                                            + "&cat=" + Uri.encode(cat) + "&ids=" + id, new byte[0]);
                                    final boolean ok = new JSONObject(r).optBoolean("ok");
                                    runOnUiThread(new Runnable() {
                                        public void run() {
                                            Toast.makeText(MainActivity.this, ok ? "改好了" : "改失败", Toast.LENGTH_SHORT).show();
                                            if (ok) showShelf();
                                        }
                                    });
                                } catch (final Exception ex) {
                                    runOnUiThread(new Runnable() {
                                        public void run() { Toast.makeText(MainActivity.this, "网络错误", Toast.LENGTH_SHORT).show(); }
                                    });
                                }
                            }
                        }).start();
                    }
                }).setNegativeButton("取消", null).show();
    }

    private void bulkOp(final String op, final int id) {
        new Thread(new Runnable() {
            public void run() {
                try {
                    String r = postRaw(base() + "/api/bulk?op=" + op + "&key=" + Uri.encode(key())
                            + "&ids=" + id, new byte[0]);
                    final boolean ok = new JSONObject(r).optBoolean("ok");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            Toast.makeText(MainActivity.this, ok ? "已处理" : "失败", Toast.LENGTH_SHORT).show();
                            if (ok) showShelf();
                        }
                    });
                } catch (Exception ex) {
                    runOnUiThread(new Runnable() {
                        public void run() { Toast.makeText(MainActivity.this, "网络错误", Toast.LENGTH_SHORT).show(); }
                    });
                }
            }
        }).start();
    }

    private View shelfRow(final JSONObject b) {
        final int id = b.optInt("id");
        String title = b.optString("title", "未命名");
        String author = b.optString("author", "");
        int chapters = b.optInt("chapters");
        int prog = b.optInt("progress", 0);
        int li = b.optInt("last_idx", 0);

        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable g = new GradientDrawable();
        g.setColor(C_CARD);
        g.setCornerRadius(dp(14));
        g.setStroke(dp(1), C_LINE);
        l.setBackground(g);
        l.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(16), 0, dp(16), dp(8));
        l.setLayoutParams(lp);

        l.setOnLongClickListener(new View.OnLongClickListener() {
            public boolean onLongClick(View v) { bookMenu(b); return true; }
        });
        l.addView(coverView(b, 50, 68));

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        mid.setPadding(dp(12), 0, dp(8), 0);
        mid.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        mid.addView(tv(title, 14.5f, C_TXT, true));
        mid.addView(tv((author.isEmpty() ? "佚名" : author) + " · " + chapters + " 章", 11.5f, C_DIM, false));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.topMargin = dp(7);
        bar.setLayoutParams(blp);
        ProgressBar pb = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        pb.setMax(100);
        pb.setProgress(Math.max(0, Math.min(100, prog)));
        bar.addView(pb, new LinearLayout.LayoutParams(0, dp(4), 1f));
        TextView pct = tv(" " + prog + "%", 10.5f, C_DIM, false);
        bar.addView(pct);
        mid.addView(bar);
        l.addView(mid);

        l.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                showReader(base() + "/read/" + id + "/" + b.optInt("last_idx", 0) + "?resume=1");
            }
        });
        l.setOnLongClickListener(new View.OnLongClickListener() {
            public boolean onLongClick(View v) {
                bookMenu(b);
                return true;
            }
        });
        return l;
    }
}

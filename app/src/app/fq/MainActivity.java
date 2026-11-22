package app.fq;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends Activity {
    private static final String HOST = "appassets.local";
    private WebView web;
    private int lastTop = -1, lastBottom = -1, lastIme = -1;
    private boolean pageReady = false;
    private boolean lightBars = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Window w = getWindow();
        w.setStatusBarColor(0x00000000);
        w.setNavigationBarColor(0x00000000);
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                w.setStatusBarContrastEnforced(false);
                w.setNavigationBarContrastEnforced(false);
            } catch (Throwable ignore) { }
        }
        // 全面屏：内容延伸到系统栏底下（Android 15 起系统强制，主动做才不会跳）
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            // 低版本交给系统处理，避免 NO_LIMITS 把 IME 顶掉
            w.setStatusBarColor(0xFF08090D);
            w.setNavigationBarColor(0xFF08090D);
        }

        web = new WebView(this);
        web.setBackgroundColor(0xFF08090D);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);
        if (Build.VERSION.SDK_INT >= 33) {
            try { s.setAlgorithmicDarkeningAllowed(false); } catch (Throwable ignore) { }
        }

        web.addJavascriptInterface(new Bridge(this, web), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInsets(true);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                try {
                    Uri u = req.getUrl();
                    if (u != null && HOST.equals(u.getHost())) {
                        String p = u.getPath();
                        if (p == null || p.length() == 0 || "/".equals(p)) p = "/index.html";
                        String name = p.startsWith("/") ? p.substring(1) : p;
                        try {
                            InputStream is = getAssets().open(name);
                            return new WebResourceResponse(mimeOf(name), "utf-8", is);
                        } catch (IOException e) {
                            return new WebResourceResponse("text/plain", "utf-8",
                                    new ByteArrayInputStream(("not found: " + name).getBytes()));
                        }
                    }
                } catch (Throwable ignore) { }
                return null;
            }
        });

        web.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top = 0, bottom = 0, ime = 0;
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets sys = insets.getInsets(WindowInsets.Type.systemBars());
                    top = sys.top;
                    bottom = sys.bottom;
                    android.graphics.Insets im = insets.getInsets(WindowInsets.Type.ime());
                    ime = Math.max(0, im.bottom - sys.bottom);
                }
                applyInsets(top, bottom, ime);
                return insets;
            }
        });

        // 返回手势 / 返回键
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    new android.window.OnBackInvokedCallback() {
                        @Override
                        public void onBackInvoked() {
                            if (!handleBack()) finish();
                        }
                    });
        }

        if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 7);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 9); } catch (Throwable ignore) { }
        }

        web.loadUrl("https://" + HOST + "/index.html");
    }

    private void applyInsets(int top, int bottom, int ime) {
        if (top == lastTop && bottom == lastBottom && ime == lastIme) return;
        lastTop = top; lastBottom = bottom; lastIme = ime;
        pushInsets(false);
    }

    private void pushInsets(boolean force) {
        if (web == null || !pageReady) return;
        if (!force && lastTop < 0) return;
        String js = "window.__insets&&window.__insets(" + Math.max(0, lastTop) + "," +
                Math.max(0, lastBottom) + "," + Math.max(0, lastIme) + ")";
        try { web.evaluateJavascript(js, null); } catch (Throwable ignore) { }
    }

    /** 浅色主题时把状态栏/导航栏图标切成深色 */
    public void applyBars(final boolean light) {
        lightBars = light;
        runOnUiThread(new Runnable() {
            public void run() {
                try {
                    Window w = getWindow();
                    if (Build.VERSION.SDK_INT >= 30) {
                        WindowInsetsController c = w.getInsetsController();
                        if (c != null) {
                            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
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
        });
    }

    /** 返回：先关抽屉，再退出。返回 true = 已消费 */
    private boolean handleBack() {
        if (Bridge.sheetOpen && web != null) {
            try {
                web.evaluateJavascript("(function(){var m=document.getElementById('mask');" +
                        "if(m&&m.classList&&m.classList.contains('on')){m.click();return '1';}return '0';})()", null);
            } catch (Throwable ignore) { }
            return true;
        }
        return false;
    }

    public void openDownloads() {
        try {
            Intent i = new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("content://downloads/my_downloads")));
            } catch (Throwable ignore) { }
        }
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK && Build.VERSION.SDK_INT < 33) {
            if (handleBack()) return true;
            finish();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    private static String mimeOf(String n) {
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }
}

package com.fj.bookshelf;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台服务：下载期间把进程钉在前台，切后台/锁屏/清任务都不会被系统回收。
 * 真正的下载逻辑仍在网页里跑，这里只负责保活 + 常驻进度通知。
 */
public class DownloadService extends Service {

    private static final String CH = "fq_service";
    private static final int NID = 9002;
    private static DownloadService inst;

    private static String sTitle = "正在下载";
    private static String sText = "";
    private static int sPct = 0;

    public static boolean isRunning() {
        return inst != null;
    }

    public static void start(Context c, String title) {
        sTitle = (title == null || title.isEmpty()) ? "正在下载" : title;
        sText = "准备中…";
        sPct = 0;
        try {
            Intent i = new Intent(c, DownloadService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Throwable ignore) { }
    }

    public static void update(String text, int pct) {
        DownloadService d = inst;
        if (d == null) return;
        sText = text == null ? "" : text;
        sPct = Math.max(0, Math.min(100, pct));
        try { d.push(); } catch (Throwable ignore) { }
    }

    public static void stop(Context c) {
        try {
            if (c != null) c.stopService(new Intent(c, DownloadService.class));
        } catch (Throwable ignore) { }
        inst = null;
    }

    @Override
    public IBinder onBind(Intent i) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            NotificationChannel ch = new NotificationChannel(CH, "下载进行中",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("下载期间保持后台运行");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        startForeground(NID, build());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NID, build());
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (inst == this) inst = null;
        super.onDestroy();
    }

    private PendingIntent tap() {
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i == null) return null;
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getActivity(this, 0, i, fl);
    }

    private Notification build() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(this, CH);
        else b = new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(sTitle)
                .setContentText(sText)
                .setProgress(100, sPct, sPct <= 0)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false);
        PendingIntent p = tap();
        if (p != null) b.setContentIntent(p);
        return b.build();
    }

    private void push() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NID, build());
    }
}

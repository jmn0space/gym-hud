package app.gymhud;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.content.ContextCompat;

/**
 * Holds the walking notification as a foreground service, so an aggressive OEM
 * battery manager (MIUI/HyperOS) does not kill the app mid-session and leave the
 * lock-screen buttons talking to nobody.
 */
public class WalkingService extends Service {

    private static Notification pending;
    private static boolean running;

    static void show(Context context, Notification notification) {
        pending = notification;
        if (running) {
            // Already foreground: a plain re-post, which Android allows from the
            // background, where starting a service again would not be.
            context.getSystemService(NotificationManager.class).notify(WalkingNotificationPlugin.ID, notification);
        } else {
            ContextCompat.startForegroundService(context, new Intent(context, WalkingService.class));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (pending == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(WalkingNotificationPlugin.ID, pending, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(WalkingNotificationPlugin.ID, pending);
        }
        running = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

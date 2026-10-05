package app.gymhud;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The walking session on the lock screen and notification shade: Android itself
 * ticks the timer (a chronometer from `chronometerBase`), so nothing has to run
 * every second, and nothing touches audio focus. Buttons come back to the web
 * layer as "action" events, which run the same commands as the on-screen ones.
 */
@CapacitorPlugin(
    name = "WalkingNotification",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class WalkingNotificationPlugin extends Plugin {

    static final String CHANNEL = "walking";
    static final int ID = 1;
    private static final String ACTION = "app.gymhud.WALKING_ACTION";
    private static WalkingNotificationPlugin instance;

    @Override
    public void load() {
        instance = this;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Walking session", NotificationManager.IMPORTANCE_LOW);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setSound(null, null);
        getContext().getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @PluginMethod
    public void show(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        post(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        // Denied still posts: the foreground service keeps the session alive, the
        // user just does not see it until notifications are allowed in settings.
        post(call);
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getContext().stopService(new Intent(getContext(), WalkingService.class));
        call.resolve();
    }

    private void post(PluginCall call) {
        Context context = getContext();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_walk)
            .setContentTitle(call.getString("title", ""))
            .setContentText(call.getString("text", ""))
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    context,
                    0,
                    new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE
                )
            );

        Long base = call.getLong("chronometerBase");
        if (base != null) {
            builder.setWhen(base).setShowWhen(true).setUsesChronometer(true);
        } else {
            builder.setShowWhen(false);
        }

        JSArray actions = call.getArray("actions", new JSArray());
        try {
            for (int i = 0; i < actions.length(); i++) {
                JSONObject action = actions.getJSONObject(i);
                String id = action.getString("id");
                Intent tap = new Intent(context, ActionReceiver.class).setAction(ACTION).putExtra("id", id);
                builder.addAction(0, action.getString("title"), PendingIntent.getBroadcast(context, i + 1, tap, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            }
        } catch (JSONException e) {
            call.reject("Invalid actions", e);
            return;
        }

        WalkingService.show(context, builder.build());
        call.resolve();
    }

    /** Notification button taps, forwarded to whatever the web layer registered. */
    public static class ActionReceiver extends BroadcastReceiver {

        @Override
        public void onReceive(Context context, Intent intent) {
            if (instance == null) return;
            JSObject data = new JSObject();
            data.put("id", intent.getStringExtra("id"));
            instance.notifyListeners("action", data);
        }
    }
}

package com.hmd.hmdchat.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public final class RuntimeStore {
    private static final String PREFS = "hmdchat-runtime";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_DEVICE_NAME = "device_name";
    private static final String KEY_MESSAGES = "messages";
    private static final String KEY_SETTINGS = "settings";
    private static final String KEY_PENDING_SHARE = "pending_share";

    private final SharedPreferences prefs;

    RuntimeStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        ensureDefaults();
    }

    private void ensureDefaults() {
        SharedPreferences.Editor editor = prefs.edit();
        if (!prefs.contains(KEY_DEVICE_ID)) {
            editor.putString(KEY_DEVICE_ID, "android-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (!prefs.contains(KEY_DEVICE_NAME)) {
            editor.putString(KEY_DEVICE_NAME, Build.MODEL == null ? "Android" : Build.MODEL);
        }
        if (!prefs.contains(KEY_MESSAGES)) {
            editor.putString(KEY_MESSAGES, "[]");
        }
        if (!prefs.contains(KEY_SETTINGS)) {
            JSONObject settings = new JSONObject();
            try {
                settings.put("receivedFilesDir", "Android storage");
                settings.put("deviceName", getDeviceName());
            } catch (JSONException ignored) {
            }
            editor.putString(KEY_SETTINGS, settings.toString());
        }
        editor.apply();
    }

    String getDeviceId() {
        return prefs.getString(KEY_DEVICE_ID, "android-unknown");
    }

    String getDeviceName() {
        return prefs.getString(KEY_DEVICE_NAME, "Android");
    }

    JSONObject getSettings() {
        try {
            return new JSONObject(prefs.getString(KEY_SETTINGS, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    JSONObject getPendingShare() {
        try {
            String raw = prefs.getString(KEY_PENDING_SHARE, "");
            if (raw == null || raw.isEmpty()) {
                return null;
            }
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    void setPendingShare(JSONObject pendingShare) {
        SharedPreferences.Editor editor = prefs.edit();
        if (pendingShare == null) {
            editor.remove(KEY_PENDING_SHARE);
        } else {
            editor.putString(KEY_PENDING_SHARE, pendingShare.toString());
        }
        editor.apply();
    }

    JSONObject updateSettings(JSONObject patch) {
        JSONObject settings = getSettings();
        if (patch == null) {
            return settings;
        }

        JSONArray names = patch.names();
        if (names == null) {
            return settings;
        }

        for (int i = 0; i < names.length(); i++) {
            String key = names.optString(i, "");
            if (key.isEmpty()) {
                continue;
            }
            try {
                settings.put(key, patch.opt(key));
            } catch (JSONException ignored) {
            }
        }

        prefs.edit().putString(KEY_SETTINGS, settings.toString()).apply();
        return settings;
    }

    List<JSONObject> getMessages() {
        List<JSONObject> messages = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString(KEY_MESSAGES, "[]"));
            for (int i = 0; i < array.length(); i++) {
                messages.add(array.getJSONObject(i));
            }
        } catch (JSONException ignored) {
        }
        return messages;
    }

    void setMessages(List<JSONObject> messages) {
        JSONArray array = new JSONArray();
        for (JSONObject message : messages) {
            array.put(message);
        }
        prefs.edit().putString(KEY_MESSAGES, array.toString()).apply();
    }

    void appendMessage(JSONObject message) {
        List<JSONObject> messages = getMessages();
        messages.add(message);
        setMessages(messages);
    }

    void replaceMessage(JSONObject updatedMessage) {
        List<JSONObject> messages = getMessages();
        for (int i = 0; i < messages.size(); i++) {
            JSONObject message = messages.get(i);
            if (updatedMessage.optString("id").equals(message.optString("id"))) {
                messages.set(i, updatedMessage);
                setMessages(messages);
                return;
            }
        }
        messages.add(updatedMessage);
        setMessages(messages);
    }
}

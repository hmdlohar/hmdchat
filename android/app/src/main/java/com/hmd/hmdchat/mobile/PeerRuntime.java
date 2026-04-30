package com.hmd.hmdchat.mobile;

import android.content.Intent;
import android.content.Context;
import android.database.Cursor;
import android.net.wifi.WifiManager;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.text.TextUtils;

import javax.jmdns.JmDNS;
import javax.jmdns.ServiceEvent;
import javax.jmdns.ServiceInfo;
import javax.jmdns.ServiceListener;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoHTTPD.IHTTPSession;
import fi.iki.elonen.NanoHTTPD.Method;
import fi.iki.elonen.NanoHTTPD.Response;
import fi.iki.elonen.NanoHTTPD.Response.IStatus;
import fi.iki.elonen.NanoHTTPD.ResponseException;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class PeerRuntime {
    public static final int PORT = 33445;
    private static final String SERVICE_TYPE = "_hmdchat._tcp.local.";
    private static PeerRuntime instance;

    private final Context context;
    private final RuntimeStore store;
    private final Map<String, JSONObject> peers = new ConcurrentHashMap<>();
    private final int port;
    private final String deviceId;
    private final String deviceName;
    private final SimpleDateFormat isoFormatter;

    private LocalServer server;
    private JmDNS jmdns;
    private WifiManager.MulticastLock multicastLock;
    private String preferredAddress = "127.0.0.1";
    private String lastHandledShareSignature = "";

    public static synchronized PeerRuntime getInstance(Context context) {
        if (instance == null) {
            instance = new PeerRuntime(context.getApplicationContext(), PORT);
        }
        return instance;
    }

    private PeerRuntime(Context context, int port) {
        this.context = context;
        this.port = port;
        this.store = new RuntimeStore(context);
        this.deviceId = store.getDeviceId();
        this.deviceName = store.getDeviceName();
        this.isoFormatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        this.isoFormatter.setTimeZone(TimeZone.getTimeZone("UTC"));
    }

    public synchronized void start() {
        if (server != null) {
            return;
        }

        preferredAddress = resolvePreferredAddress();
        server = new LocalServer(port);
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        } catch (IOException e) {
            server = null;
            return;
        }
        startDiscovery();
    }

    public synchronized void stop() {
        if (server != null) {
            server.stop();
            server = null;
        }

        if (jmdns != null) {
            try {
                jmdns.unregisterAllServices();
                jmdns.close();
            } catch (IOException ignored) {
            }
            jmdns = null;
        }

        if (multicastLock != null && multicastLock.isHeld()) {
            multicastLock.release();
        }
        multicastLock = null;
    }

    private void startDiscovery() {
        try {
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                multicastLock = wifiManager.createMulticastLock("hmdchat-mdns");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }

            InetAddress bindAddress = InetAddress.getByName(preferredAddress);
            jmdns = JmDNS.create(bindAddress, deviceName + "-" + port);

            Map<String, String> props = new HashMap<>();
            props.put("id", deviceId);
            props.put("name", deviceName);

            ServiceInfo info = ServiceInfo.create(
                SERVICE_TYPE,
                deviceName + "-" + port,
                port,
                0,
                0,
                props
            );

            jmdns.registerService(info);
            jmdns.addServiceListener(SERVICE_TYPE, new ServiceListener() {
                @Override
                public void serviceAdded(ServiceEvent event) {
                    if (jmdns != null) {
                        jmdns.requestServiceInfo(event.getType(), event.getName(), true);
                    }
                }

                @Override
                public void serviceRemoved(ServiceEvent event) {
                    String peerId = readServiceProperty(event.getInfo(), "id");
                    if (TextUtils.isEmpty(peerId)) {
                        return;
                    }
                    JSONObject peer = peers.get(peerId);
                    if (peer == null) {
                        return;
                    }
                    try {
                        peer.put("online", false);
                        peer.put("lastSeenAt", nowIso());
                    } catch (JSONException ignored) {
                    }
                }

                @Override
                public void serviceResolved(ServiceEvent event) {
                    ServiceInfo info = event.getInfo();
                    String peerId = readServiceProperty(info, "id");
                    if (TextUtils.isEmpty(peerId) || deviceId.equals(peerId)) {
                        return;
                    }

                    String host = null;
                    for (InetAddress address : info.getInet4Addresses()) {
                        host = address.getHostAddress();
                        break;
                    }

                    if (TextUtils.isEmpty(host)) {
                        return;
                    }

                    JSONObject peer = new JSONObject();
                    try {
                        peer.put("id", peerId);
                        peer.put("name", readServiceProperty(info, "name", info.getName()));
                        peer.put("host", host);
                        peer.put("port", info.getPort());
                        peer.put("online", true);
                        peer.put("lastSeenAt", nowIso());
                        peer.put("source", "mdns");
                    } catch (JSONException ignored) {
                    }
                    peers.put(peerId, peer);
                }
            });
        } catch (Exception ignored) {
        }
    }

    private String readServiceProperty(ServiceInfo info, String key) {
        return readServiceProperty(info, key, "");
    }

    private String readServiceProperty(ServiceInfo info, String key, String fallback) {
        if (info == null) {
            return fallback;
        }
        String value = info.getPropertyString(key);
        return value == null ? fallback : value;
    }

    private String resolvePreferredAddress() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (!address.isLoopbackAddress() && address instanceof Inet4Address) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "127.0.0.1";
    }

    private JSONObject selfJson() throws JSONException {
        JSONObject self = new JSONObject();
        self.put("id", deviceId);
        self.put("name", deviceName);
        self.put("port", port);
        JSONArray addresses = new JSONArray();
        addresses.put("127.0.0.1");
        if (!"127.0.0.1".equals(preferredAddress)) {
            addresses.put(preferredAddress);
        }
        self.put("addresses", addresses);
        return self;
    }

    private JSONArray peersJson() {
        List<JSONObject> values = new ArrayList<>(peers.values());
        values.sort(Comparator.comparing(o -> o.optString("name", "")));
        return new JSONArray(values);
    }

    private JSONArray getConversationSummary() {
        Map<String, JSONObject> conversations = new HashMap<>();
        for (JSONObject message : store.getMessages()) {
            String peerId = message.optString("peerId", "");
            JSONObject current = conversations.get(peerId);
            if (current == null) {
                current = new JSONObject();
                try {
                    current.put("peerId", peerId);
                    current.put("lastMessage", message);
                    current.put("unreadCount", 0);
                } catch (JSONException ignored) {
                }
                conversations.put(peerId, current);
            }

            String currentDate = current.optJSONObject("lastMessage") != null
                ? current.optJSONObject("lastMessage").optString("createdAt", "")
                : "";
            String nextDate = message.optString("createdAt", "");
            if (nextDate.compareTo(currentDate) > 0) {
                try {
                    current.put("lastMessage", message);
                } catch (JSONException ignored) {
                }
            }

            if ("incoming".equals(message.optString("direction")) && message.isNull("readAt")) {
                try {
                    current.put("unreadCount", current.optInt("unreadCount", 0) + 1);
                } catch (JSONException ignored) {
                }
            }
        }

        List<JSONObject> items = new ArrayList<>(conversations.values());
        items.sort((a, b) -> {
            String ad = a.optJSONObject("lastMessage") != null
                ? a.optJSONObject("lastMessage").optString("createdAt", "")
                : "";
            String bd = b.optJSONObject("lastMessage") != null
                ? b.optJSONObject("lastMessage").optString("createdAt", "")
                : "";
            return bd.compareTo(ad);
        });
        return new JSONArray(items);
    }

    private JSONObject stateJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("self", selfJson());
        json.put("settings", store.getSettings());
        json.put("peers", peersJson());
        json.put("conversations", getConversationSummary());
        json.put("pendingShare", store.getPendingShare());
        return json;
    }

    private Response jsonResponse(IStatus status, JSONObject body) {
        Response response = NanoHTTPD.newFixedLengthResponse(status, "application/json", body.toString());
        addCorsHeaders(response);
        return response;
    }

    private Response jsonArrayResponse(IStatus status, JSONArray body) {
        Response response = NanoHTTPD.newFixedLengthResponse(status, "application/json", body.toString());
        addCorsHeaders(response);
        return response;
    }

    private Response emptyResponse(IStatus status) {
        Response response = NanoHTTPD.newFixedLengthResponse(status, "text/plain", "");
        addCorsHeaders(response);
        return response;
    }

    private void addCorsHeaders(Response response) {
        response.addHeader("Access-Control-Allow-Origin", "*");
        response.addHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
        response.addHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    private JSONObject readJsonBody(IHTTPSession session) throws IOException, JSONException {
        Map<String, String> files = new HashMap<>();
        try {
            session.parseBody(files);
        } catch (ResponseException error) {
            throw new IOException(error);
        }
        String body = files.get("postData");
        if (body == null || body.isEmpty()) {
            return new JSONObject();
        }
        return new JSONObject(body);
    }

    private JSONArray messagesForPeer(String peerId) {
        List<JSONObject> filtered = new ArrayList<>();
        for (JSONObject message : store.getMessages()) {
            if (peerId.equals(message.optString("peerId"))) {
                filtered.add(message);
            }
        }
        filtered.sort(Comparator.comparing(o -> o.optString("createdAt", "")));
        return new JSONArray(filtered);
    }

    private JSONObject connectPeer(String rawAddress) throws IOException, JSONException {
        String[] parts = rawAddress.split(":");
        if (parts.length != 2) {
            throw new IOException("Address must look like host:port.");
        }
        String host = parts[0].trim();
        int peerPort = Integer.parseInt(parts[1].trim());

        JSONObject hello = httpJson("GET", "http://" + host + ":" + peerPort + "/api/hello", null);
        JSONObject self = hello.getJSONObject("self");
        String peerId = self.getString("id");

        JSONObject peer = new JSONObject();
        peer.put("id", peerId);
        peer.put("name", self.optString("name", peerId));
        peer.put("host", host);
        peer.put("port", peerPort);
        peer.put("online", true);
        peer.put("lastSeenAt", nowIso());
        peer.put("source", "manual");
        peers.put(peerId, peer);
        return peer;
    }

    private JSONObject httpJson(String method, String urlValue, JSONObject body) throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(urlValue).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(2500);
        connection.setReadTimeout(2500);
        connection.setRequestProperty("Content-Type", "application/json");

        if (body != null) {
            connection.setDoOutput(true);
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream outputStream = connection.getOutputStream()) {
                outputStream.write(payload);
            }
        }

        int code = connection.getResponseCode();
        InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String response = readAll(stream);
        if (code >= 400) {
            throw new IOException(response);
        }
        return new JSONObject(response);
    }

    private String readAll(InputStream stream) throws IOException {
        if (stream == null) {
            return "";
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
            return builder.toString();
        }
    }

    private JSONObject makeTextMessage(JSONObject body, String direction) throws JSONException {
        JSONObject message = new JSONObject();
        message.put("id", body.optString("messageId", UUID.randomUUID().toString()));
        message.put("peerId", body.optString("incoming".equals(direction) ? "senderId" : "peerId"));
        message.put("peerName", body.optString("incoming".equals(direction) ? "senderName" : "peerName"));
        message.put("direction", direction);
        message.put("kind", "text");
        message.put("text", body.optString("text", ""));
        message.put("createdAt", body.optString("createdAt", nowIso()));
        if ("incoming".equals(direction)) {
            message.put("deliveredAt", nowIso());
            message.put("readAt", JSONObject.NULL);
        } else {
            message.put("deliveredAt", JSONObject.NULL);
            message.put("readAt", JSONObject.NULL);
        }
        message.put("file", JSONObject.NULL);
        return message;
    }

    private void markConversationRead(String peerId) {
        List<JSONObject> messages = store.getMessages();
        for (JSONObject message : messages) {
            if (peerId.equals(message.optString("peerId"))
                && "incoming".equals(message.optString("direction"))
                && message.isNull("readAt")) {
                try {
                    message.put("readAt", nowIso());
                } catch (JSONException ignored) {
                }
            }
        }
        store.setMessages(messages);
    }

    private String nowIso() {
        synchronized (isoFormatter) {
            return isoFormatter.format(new Date());
        }
    }

    private String cleanRemoteIp(String value) {
        if (value == null) {
            return "";
        }
        if (value.startsWith("/")) {
            return value.substring(1);
        }
        return value;
    }

    private String firstParam(IHTTPSession session, String key) {
        List<String> values = session.getParameters().get(key);
        if (values == null || values.isEmpty()) {
            return "";
        }
        String value = values.get(0);
        return value == null ? "" : value;
    }

    private File ensureReceivedDir() {
        File dir = new File(context.getFilesDir(), "received");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    private File ensureSentDir() {
        File dir = new File(context.getFilesDir(), "sent");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    private File ensureSharedDir() {
        File dir = new File(context.getFilesDir(), "shared");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    private String sanitizeFilename(String value) {
        String safe = value == null ? "" : value.replaceAll("[\\\\/:*?\"<>|\\n\\r]+", "_").trim();
        return safe.isEmpty() ? "upload.bin" : safe;
    }

    private void copyFile(File source, File target) throws IOException {
        try (InputStream input = new FileInputStream(source);
             OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
    }

    private String detectDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        String last = uri.getLastPathSegment();
        return last == null || last.isEmpty() ? "shared.bin" : last;
    }

    private long detectSize(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0) {
                    return cursor.getLong(index);
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return 0L;
    }

    private JSONObject buildFileMeta(File localFile, String originalName, String mimeType) throws JSONException {
        JSONObject file = new JSONObject();
        file.put("originalName", originalName);
        file.put("storedName", localFile.getName());
        file.put("path", localFile.getAbsolutePath());
        file.put("size", localFile.length());
        file.put("mimeType", mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
        return file;
    }

    private void writeMultipartField(PrintWriter writer, String boundary, String name, String value) {
        writer.append("--").append(boundary).append("\r\n");
        writer.append("Content-Disposition: form-data; name=\"").append(name).append("\"\r\n\r\n");
        writer.append(value == null ? "" : value).append("\r\n");
        writer.flush();
    }

    private JSONObject postMultipartFile(JSONObject peer, File file, JSONObject fields) throws IOException, JSONException {
        String boundary = "----hmdchat-" + UUID.randomUUID();
        HttpURLConnection connection = (HttpURLConnection) new URL(
            "http://" + peer.optString("host") + ":" + peer.optInt("port") + "/api/inbox/file"
        ).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

        try (OutputStream output = connection.getOutputStream();
             PrintWriter writer = new PrintWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8), true)) {
            JSONArray names = fields.names();
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String key = names.optString(i, "");
                    writeMultipartField(writer, boundary, key, fields.optString(key, ""));
                }
            }

            writer.append("--").append(boundary).append("\r\n");
            writer.append("Content-Disposition: form-data; name=\"file\"; filename=\"")
                .append(sanitizeFilename(fields.optString("originalName", file.getName())))
                .append("\"\r\n");
            writer.append("Content-Type: ")
                .append(fields.optString("mimeType", "application/octet-stream"))
                .append("\r\n\r\n");
            writer.flush();

            try (InputStream input = new FileInputStream(file)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                }
                output.flush();
            }

            writer.append("\r\n--").append(boundary).append("--\r\n");
            writer.flush();
        }

        int code = connection.getResponseCode();
        InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String response = readAll(stream);
        if (code >= 400) {
            throw new IOException(response.isEmpty() ? ("File upload failed with " + code) : response);
        }
        return response.isEmpty() ? new JSONObject() : new JSONObject(response);
    }

    private JSONObject sendStoredFile(JSONObject peer, File localFile, String originalName, String mimeType, String caption) throws IOException, JSONException {
        String createdAt = nowIso();
        String messageId = UUID.randomUUID().toString();

        JSONObject message = new JSONObject();
        message.put("id", messageId);
        message.put("peerId", peer.optString("id"));
        message.put("peerName", peer.optString("name", peer.optString("id")));
        message.put("direction", "outgoing");
        message.put("kind", "file");
        message.put("text", caption == null ? "" : caption);
        message.put("createdAt", createdAt);
        message.put("deliveredAt", JSONObject.NULL);
        message.put("readAt", JSONObject.NULL);
        message.put("file", buildFileMeta(localFile, originalName, mimeType));

        store.appendMessage(message);

        JSONObject fields = new JSONObject();
        fields.put("originalName", originalName);
        fields.put("mimeType", mimeType);
        fields.put("size", String.valueOf(localFile.length()));
        fields.put("senderId", deviceId);
        fields.put("senderName", deviceName);
        fields.put("senderPort", String.valueOf(port));
        fields.put("messageId", messageId);
        fields.put("caption", caption == null ? "" : caption);
        fields.put("createdAt", createdAt);

        JSONObject response = postMultipartFile(peer, localFile, fields);
        message.put("deliveredAt", response.optString("deliveredAt", nowIso()));
        store.replaceMessage(message);

        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("message", message);
        return json;
    }

    public synchronized void importShareIntent(Intent intent) {
        if (intent == null) {
            return;
        }

        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return;
        }

        Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String signature = action + "|" + String.valueOf(stream) + "|" + String.valueOf(text);
        if (signature.equals(lastHandledShareSignature)) {
            return;
        }
        lastHandledShareSignature = signature;

        try {
            if (stream != null) {
                String mimeType = intent.getType();
                String originalName = detectDisplayName(stream);
                File finalDir = ensureSharedDir();
                File finalFile = new File(finalDir, System.currentTimeMillis() + "-" + sanitizeFilename(originalName));
                try (InputStream input = context.getContentResolver().openInputStream(stream);
                     OutputStream output = new FileOutputStream(finalFile)) {
                    if (input == null) {
                        return;
                    }
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                    }
                }

                JSONObject pending = new JSONObject();
                pending.put("type", "file");
                pending.put("text", text == null ? "" : text);
                pending.put("createdAt", nowIso());
                pending.put("file", buildFileMeta(finalFile, originalName, mimeType));
                long detectedSize = detectSize(stream);
                if (detectedSize > 0) {
                    pending.getJSONObject("file").put("size", detectedSize);
                }
                store.setPendingShare(pending);
                return;
            }

            if (text != null && !text.isEmpty()) {
                JSONObject pending = new JSONObject();
                pending.put("type", "text");
                pending.put("text", text);
                pending.put("createdAt", nowIso());
                store.setPendingShare(pending);
            }
        } catch (Exception ignored) {
        }
    }

    private JSONObject storeIncomingFile(IHTTPSession session) throws IOException, JSONException {
        Map<String, String> files = new HashMap<>();
        try {
            session.parseBody(files);
        } catch (ResponseException error) {
            throw new IOException(error);
        }

        String tempPath = files.get("file");
        if (tempPath == null || tempPath.isEmpty()) {
            throw new IOException("File is required.");
        }

        String originalName = firstParam(session, "originalName");
        if (originalName.isEmpty()) {
            originalName = "upload.bin";
        }
        String mimeType = firstParam(session, "mimeType");
        if (mimeType.isEmpty()) {
            mimeType = "application/octet-stream";
        }
        String caption = firstParam(session, "caption");
        String senderId = firstParam(session, "senderId");
        String senderName = firstParam(session, "senderName");
        String createdAt = firstParam(session, "createdAt");
        String messageId = firstParam(session, "messageId");
        String senderPortRaw = firstParam(session, "senderPort");

        int senderPort = PORT;
        try {
            senderPort = Integer.parseInt(senderPortRaw);
        } catch (NumberFormatException ignored) {
        }

        File tempFile = new File(tempPath);
        File finalDir = ensureReceivedDir();
        String safeName = sanitizeFilename(originalName);
        File finalFile = new File(finalDir, System.currentTimeMillis() + "-" + safeName);
        copyFile(tempFile, finalFile);
        tempFile.delete();

        JSONObject peer = new JSONObject();
        peer.put("id", senderId);
        peer.put("name", senderName.isEmpty() ? senderId : senderName);
        peer.put("host", cleanRemoteIp(session.getRemoteIpAddress()));
        peer.put("port", senderPort);
        peer.put("online", true);
        peer.put("lastSeenAt", nowIso());
        peer.put("source", "incoming");
        peers.put(senderId, peer);

        long size = finalFile.length();
        String sizeRaw = firstParam(session, "size");
        if (!sizeRaw.isEmpty()) {
            try {
                size = Long.parseLong(sizeRaw);
            } catch (NumberFormatException ignored) {
            }
        }

        String deliveredAt = nowIso();
        JSONObject message = new JSONObject();
        message.put("id", messageId.isEmpty() ? UUID.randomUUID().toString() : messageId);
        message.put("peerId", senderId);
        message.put("peerName", senderName.isEmpty() ? senderId : senderName);
        message.put("direction", "incoming");
        message.put("kind", "file");
        message.put("text", caption);
        message.put("createdAt", createdAt.isEmpty() ? deliveredAt : createdAt);
        message.put("deliveredAt", deliveredAt);
        message.put("readAt", JSONObject.NULL);

        JSONObject file = new JSONObject();
        file.put("originalName", originalName);
        file.put("storedName", finalFile.getName());
        file.put("path", finalFile.getAbsolutePath());
        file.put("size", size);
        file.put("mimeType", mimeType);
        message.put("file", file);

        store.appendMessage(message);

        JSONObject json = new JSONObject();
        json.put("ok", true);
        json.put("deliveredAt", deliveredAt);
        return json;
    }

    private final class LocalServer extends NanoHTTPD {
        LocalServer(int port) {
            super("0.0.0.0", port);
        }

        @Override
        public Response serve(IHTTPSession session) {
            try {
                String uri = session.getUri();
                Method method = session.getMethod();

                if (method == Method.OPTIONS) {
                    return emptyResponse(Response.Status.OK);
                }

                if ("/health".equals(uri)) {
                    JSONObject json = new JSONObject();
                    json.put("ok", true);
                    json.put("port", port);
                    json.put("deviceId", deviceId);
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/hello".equals(uri)) {
                    JSONObject json = new JSONObject();
                    json.put("self", selfJson());
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/state".equals(uri)) {
                    return jsonResponse(Response.Status.OK, stateJson());
                }

                if ("/api/settings".equals(uri) && method == Method.GET) {
                    JSONObject json = new JSONObject();
                    json.put("settings", store.getSettings());
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/settings".equals(uri) && method == Method.PUT) {
                    JSONObject body = readJsonBody(session);
                    JSONObject settings = store.updateSettings(body);
                    JSONObject json = new JSONObject();
                    json.put("ok", true);
                    json.put("settings", settings);
                    return jsonResponse(Response.Status.OK, json);
                }

                if (uri.startsWith("/api/messages/")) {
                    String peerId = uri.substring("/api/messages/".length());
                    JSONObject json = new JSONObject();
                    json.put("peerId", peerId);
                    json.put("messages", messagesForPeer(peerId));
                    return jsonResponse(Response.Status.OK, json);
                }

                if (uri.startsWith("/api/files/") && method == Method.GET) {
                    String messageId = uri.substring("/api/files/".length());
                    for (JSONObject message : store.getMessages()) {
                        if (!messageId.equals(message.optString("id"))) {
                            continue;
                        }
                        JSONObject file = message.optJSONObject("file");
                        if (file == null) {
                            break;
                        }

                        File localFile = new File(file.optString("path", ""));
                        if (!localFile.exists()) {
                            break;
                        }

                        Response response = NanoHTTPD.newChunkedResponse(
                            Response.Status.OK,
                            file.optString("mimeType", "application/octet-stream"),
                            new FileInputStream(localFile)
                        );
                        response.addHeader("Content-Length", String.valueOf(localFile.length()));
                        response.addHeader(
                            "Content-Disposition",
                            "inline; filename=\"" + sanitizeFilename(file.optString("originalName", localFile.getName())) + "\""
                        );
                        addCorsHeaders(response);
                        return response;
                    }

                    JSONObject err = new JSONObject();
                    err.put("error", "File not found.");
                    return jsonResponse(Response.Status.NOT_FOUND, err);
                }

                if ("/api/peers/connect".equals(uri) && method == Method.POST) {
                    JSONObject body = readJsonBody(session);
                    JSONObject peer = connectPeer(body.optString("address", ""));
                    JSONObject json = new JSONObject();
                    json.put("ok", true);
                    json.put("peer", peer);
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/send/text".equals(uri) && method == Method.POST) {
                    JSONObject body = readJsonBody(session);
                    String peerId = body.optString("peerId", "");
                    JSONObject peer = peers.get(peerId);
                    if (peer == null) {
                        JSONObject err = new JSONObject();
                        err.put("error", "Peer is offline or unknown.");
                        return jsonResponse(Response.Status.NOT_FOUND, err);
                    }

                    JSONObject outgoing = new JSONObject();
                    outgoing.put("messageId", UUID.randomUUID().toString());
                    outgoing.put("senderId", deviceId);
                    outgoing.put("senderName", deviceName);
                    outgoing.put("senderPort", port);
                    outgoing.put("text", body.optString("text", ""));
                    outgoing.put("createdAt", nowIso());

                    JSONObject message = new JSONObject();
                    message.put("id", outgoing.getString("messageId"));
                    message.put("peerId", peerId);
                    message.put("peerName", peer.optString("name", peerId));
                    message.put("direction", "outgoing");
                    message.put("kind", "text");
                    message.put("text", outgoing.optString("text", ""));
                    message.put("createdAt", outgoing.optString("createdAt"));
                    message.put("deliveredAt", JSONObject.NULL);
                    message.put("readAt", JSONObject.NULL);
                    message.put("file", JSONObject.NULL);

                    store.appendMessage(message);
                    JSONObject response = httpJson(
                        "POST",
                        "http://" + peer.optString("host") + ":" + peer.optInt("port") + "/api/inbox/text",
                        outgoing
                    );
                    message.put("deliveredAt", response.optString("deliveredAt", nowIso()));
                    store.replaceMessage(message);

                    JSONObject json = new JSONObject();
                    json.put("ok", true);
                    json.put("message", message);
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/send/file".equals(uri) && method == Method.POST) {
                    Map<String, String> files = new HashMap<>();
                    try {
                        session.parseBody(files);
                    } catch (ResponseException error) {
                        throw new IOException(error);
                    }

                    String peerId = firstParam(session, "peerId");
                    String caption = firstParam(session, "caption");
                    JSONObject peer = peers.get(peerId);
                    if (peer == null) {
                        JSONObject err = new JSONObject();
                        err.put("error", "Peer is offline or unknown.");
                        return jsonResponse(Response.Status.NOT_FOUND, err);
                    }

                    String tempPath = files.get("file");
                    if (tempPath == null || tempPath.isEmpty()) {
                        JSONObject err = new JSONObject();
                        err.put("error", "File is required.");
                        return jsonResponse(Response.Status.BAD_REQUEST, err);
                    }

                    String originalName = firstParam(session, "originalName");
                    if (originalName.isEmpty()) {
                        originalName = "upload.bin";
                    }
                    String mimeType = firstParam(session, "mimeType");
                    if (mimeType.isEmpty()) {
                        mimeType = "application/octet-stream";
                    }

                    File tempFile = new File(tempPath);
                    File finalDir = ensureSentDir();
                    File finalFile = new File(finalDir, System.currentTimeMillis() + "-" + sanitizeFilename(originalName));
                    copyFile(tempFile, finalFile);
                    tempFile.delete();

                    JSONObject json = sendStoredFile(peer, finalFile, originalName, mimeType, caption);
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/inbox/text".equals(uri) && method == Method.POST) {
                    JSONObject body = readJsonBody(session);
                    String senderId = body.optString("senderId", "");
                    JSONObject peer = new JSONObject();
                    peer.put("id", senderId);
                    peer.put("name", body.optString("senderName", senderId));
                    peer.put("host", cleanRemoteIp(session.getRemoteIpAddress()));
                    peer.put("port", body.optInt("senderPort", PORT));
                    peer.put("online", true);
                    peer.put("lastSeenAt", nowIso());
                    peer.put("source", "incoming");
                    peers.put(senderId, peer);

                    JSONObject message = makeTextMessage(body, "incoming");
                    store.appendMessage(message);

                    JSONObject json = new JSONObject();
                    json.put("ok", true);
                    json.put("deliveredAt", nowIso());
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/inbox/file".equals(uri) && method == Method.POST) {
                    JSONObject json = storeIncomingFile(session);
                    return jsonResponse(Response.Status.OK, json);
                }

                if ("/api/share/send".equals(uri) && method == Method.POST) {
                    JSONObject body = readJsonBody(session);
                    String peerId = body.optString("peerId", "");
                    JSONObject peer = peers.get(peerId);
                    if (peer == null) {
                        JSONObject err = new JSONObject();
                        err.put("error", "Peer is offline or unknown.");
                        return jsonResponse(Response.Status.NOT_FOUND, err);
                    }

                    JSONObject pending = store.getPendingShare();
                    if (pending == null) {
                        JSONObject err = new JSONObject();
                        err.put("error", "No shared item is pending.");
                        return jsonResponse(Response.Status.BAD_REQUEST, err);
                    }

                    JSONObject result;
                    if ("text".equals(pending.optString("type"))) {
                        JSONObject outgoing = new JSONObject();
                        outgoing.put("peerId", peerId);
                        outgoing.put("text", pending.optString("text", ""));

                        JSONObject payload = new JSONObject();
                        payload.put("messageId", UUID.randomUUID().toString());
                        payload.put("senderId", deviceId);
                        payload.put("senderName", deviceName);
                        payload.put("senderPort", port);
                        payload.put("text", outgoing.optString("text", ""));
                        payload.put("createdAt", nowIso());

                        JSONObject message = new JSONObject();
                        message.put("id", payload.getString("messageId"));
                        message.put("peerId", peerId);
                        message.put("peerName", peer.optString("name", peerId));
                        message.put("direction", "outgoing");
                        message.put("kind", "text");
                        message.put("text", payload.optString("text", ""));
                        message.put("createdAt", payload.optString("createdAt"));
                        message.put("deliveredAt", JSONObject.NULL);
                        message.put("readAt", JSONObject.NULL);
                        message.put("file", JSONObject.NULL);

                        store.appendMessage(message);
                        JSONObject response = httpJson(
                            "POST",
                            "http://" + peer.optString("host") + ":" + peer.optInt("port") + "/api/inbox/text",
                            payload
                        );
                        message.put("deliveredAt", response.optString("deliveredAt", nowIso()));
                        store.replaceMessage(message);

                        result = new JSONObject();
                        result.put("ok", true);
                        result.put("message", message);
                    } else {
                        JSONObject file = pending.optJSONObject("file");
                        if (file == null) {
                            JSONObject err = new JSONObject();
                            err.put("error", "Pending shared file is missing.");
                            return jsonResponse(Response.Status.BAD_REQUEST, err);
                        }

                        File localFile = new File(file.optString("path", ""));
                        if (!localFile.exists()) {
                            JSONObject err = new JSONObject();
                            err.put("error", "Pending shared file no longer exists.");
                            return jsonResponse(Response.Status.BAD_REQUEST, err);
                        }

                        result = sendStoredFile(
                            peer,
                            localFile,
                            file.optString("originalName", localFile.getName()),
                            file.optString("mimeType", "application/octet-stream"),
                            pending.optString("text", "")
                        );
                    }

                    store.setPendingShare(null);
                    return jsonResponse(Response.Status.OK, result);
                }

                if ("/api/share/clear".equals(uri) && method == Method.POST) {
                    store.setPendingShare(null);
                    JSONObject json = new JSONObject();
                    json.put("ok", true);
                    return jsonResponse(Response.Status.OK, json);
                }

                if (uri.startsWith("/api/conversations/") && uri.endsWith("/read") && method == Method.POST) {
                    String peerId = uri
                        .replace("/api/conversations/", "")
                        .replace("/read", "");
                    markConversationRead(peerId);
                    JSONObject json = new JSONObject();
                    json.put("ok", true);
                    return jsonResponse(Response.Status.OK, json);
                }

                JSONObject err = new JSONObject();
                err.put("error", "Route not implemented on Android runtime yet.");
                return jsonResponse(Response.Status.NOT_FOUND, err);
            } catch (Exception error) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("error", error.getMessage() == null ? "Unknown error" : error.getMessage());
                    return jsonResponse(Response.Status.INTERNAL_ERROR, err);
                } catch (JSONException ignored) {
                    return NanoHTTPD.newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", "Internal error");
                }
            }
        }
    }
}

package xyz.mariosjaque.slopslastcry;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Slop's Last Cry for Android: a full-screen WebView running the same web engine as the PC
 * version. The app contains no game files. On first run the user's own Banshee's Last Cry .ipa
 * (picked with the system file picker, or placed as an OBB) is extracted to the app's private
 * storage, and the setup page converts it there.
 *
 * Pages are served from https://appassets.androidplatform.net/. Each path is looked up first in
 * the converted game folder (files/game/) and then in the bundled web files (assets/www/).
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String BASE = "https://" + HOST + "/";
    static final int REQ_PICK_GAME = 1, REQ_FILE_CHOOSER = 2, REQ_SAVE = 3;

    WebView web;
    File gameDir;
    Uri pickedGame;
    ValueCallback<Uri[]> fileCallback;
    String pendingSaveText;
    final Handler main = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        gameDir = new File(getFilesDir(), "game");
        web = new WebView(this);
        web.setBackgroundColor(0xff000000);
        setContentView(web);
        hideSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "SLCNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                return serve(u.getPath(), req.getRequestHeaders());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                startActivityForResult(i, REQ_FILE_CHOOSER);
                return true;
            }
        });
        if (state == null) web.loadUrl(BASE + (isSetUp() ? "index.html" : "setup.html"));
        else web.restoreState(state);
    }

    boolean isSetUp() {
        return getPrefs().getBoolean("setupDone", false) && new File(gameDir, "engine/data.js").exists();
    }

    SharedPreferences getPrefs() { return getSharedPreferences("slc", MODE_PRIVATE); }

    void hideSystemBars() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    protected void onPause() {
        super.onPause();
        // Stop the game's music and sounds while the app is in the background, then pause the WebView.
        web.evaluateJavascript("window.SLCPause && SLCPause()", null);
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.evaluateJavascript("window.SLCResume && SLCResume()", null);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.SLCBack ? String(window.SLCBack()) : 'false'", v -> {
            if (!"\"true\"".equals(v)) finish();
        });
    }

    // ---------- Serving files ----------
    static final Map<String, String> MIME = new HashMap<>();
    static {
        String[][] m = {{"html", "text/html"}, {"js", "application/javascript"}, {"css", "text/css"}, {"json", "application/json"},
                {"png", "image/png"}, {"jpg", "image/jpeg"}, {"jpeg", "image/jpeg"}, {"gif", "image/gif"}, {"webm", "audio/webm"},
                {"ogg", "audio/ogg"}, {"mp3", "audio/mpeg"}, {"m4a", "audio/mp4"}, {"mp4", "video/mp4"}, {"wav", "audio/wav"},
                {"woff2", "font/woff2"}, {"ttf", "font/ttf"}, {"txt", "text/plain"}, {"svg", "image/svg+xml"}};
        for (String[] e : m) MIME.put(e[0], e[1]);
    }

    WebResourceResponse serve(String path, Map<String, String> headers) {
        if (path == null || path.equals("/")) path = "/index.html";
        String rel = Uri.decode(path.substring(1));
        if (rel.contains("..")) return notFound();
        int dot = rel.lastIndexOf('.');
        String mime = dot >= 0 ? MIME.get(rel.substring(dot + 1).toLowerCase(Locale.ROOT)) : null;
        if (mime == null) mime = "application/octet-stream";
        String charset = mime.startsWith("text/") || mime.equals("application/javascript") || mime.equals("application/json") ? "utf-8" : null;
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        h.put("Access-Control-Allow-Origin", "*");
        try {
            File f = new File(gameDir, rel);
            if (f.isFile()) {
                long len = f.length();
                h.put("Accept-Ranges", "bytes");
                String range = headers != null ? headers.get("Range") : null;
                if (range == null && headers != null) range = headers.get("range");
                if (range != null && range.startsWith("bytes=")) {
                    // Media elements seek with range requests (used for music loop points).
                    String[] r = range.substring(6).split(",")[0].split("-", -1);
                    long start = r[0].isEmpty() ? Math.max(0, len - Long.parseLong(r[1])) : Long.parseLong(r[0]);
                    long end = (r[0].isEmpty() || r.length < 2 || r[1].isEmpty()) ? len - 1 : Math.min(len - 1, Long.parseLong(r[1]));
                    if (start >= len) return new WebResourceResponse(mime, charset, 416, "Range Not Satisfiable", h, new ByteArrayInputStream(new byte[0]));
                    h.put("Content-Range", "bytes " + start + "-" + end + "/" + len);
                    h.put("Content-Length", String.valueOf(end - start + 1));
                    return new WebResourceResponse(mime, charset, 206, "Partial Content", h, new RangeStream(f, start, end - start + 1));
                }
                h.put("Content-Length", String.valueOf(len));
                return new WebResourceResponse(mime, charset, 200, "OK", h, new FileInputStream(f));
            }
            InputStream in = getAssets().open("www/" + rel);
            return new WebResourceResponse(mime, charset, 200, "OK", h, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    static class RangeStream extends InputStream {
        final RandomAccessFile raf; long left;
        RangeStream(File f, long start, long len) throws IOException { raf = new RandomAccessFile(f, "r"); raf.seek(start); left = len; }
        @Override public int read() throws IOException { if (left <= 0) return -1; left--; return raf.read(); }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = raf.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
        @Override public void close() throws IOException { raf.close(); }
    }

    // ---------- Activity results ----------
    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        Uri u = (res == RESULT_OK && data != null) ? data.getData() : null;
        if (req == REQ_PICK_GAME) {
            pickedGame = u;
            js("window.slcPicked && slcPicked(" + (u != null) + ")");
        } else if (req == REQ_FILE_CHOOSER) {
            if (fileCallback != null) fileCallback.onReceiveValue(u != null ? new Uri[]{u} : null);
            fileCallback = null;
        } else if (req == REQ_SAVE) {
            if (u != null && pendingSaveText != null) {
                try (OutputStream o = getContentResolver().openOutputStream(u)) {
                    o.write(pendingSaveText.getBytes(StandardCharsets.UTF_8));
                    toast("Backup saved");
                } catch (Exception e) { toast("Could not save the backup"); }
            }
            pendingSaveText = null;
        }
    }

    void js(String code) { main.post(() -> web.evaluateJavascript(code, null)); }
    void toast(String t) { main.post(() -> Toast.makeText(this, t, Toast.LENGTH_SHORT).show()); }

    static String q(String s) { return org.json.JSONObject.quote(s == null ? "" : s); }

    // ---------- Extracting the IPA ----------
    File findObb() {
        File dir = getObbDir();
        File[] files = dir != null ? dir.listFiles() : null;
        if (files == null) return null;
        for (File f : files) {
            String n = f.getName().toLowerCase(Locale.ROOT);
            if (f.isFile() && (n.endsWith(".obb") || n.endsWith(".ipa"))) return f;
        }
        return null;
    }

    void extract(boolean fromObb) {
        new Thread(() -> {
            String err = null;
            try {
                File obb = fromObb ? findObb() : null;
                if (obb == null && pickedGame == null) throw new IOException("No game file chosen.");
                long total = obb != null ? obb.length() : -1;
                if (total < 0) {
                    try (android.content.res.AssetFileDescriptor fd = getContentResolver().openAssetFileDescriptor(pickedGame, "r")) {
                        if (fd != null) total = fd.getLength();
                    } catch (Exception ignored) { }
                }
                deleteTree(gameDir);
                File app = new File(gameDir, "ink-en.app");
                CountingStream cs = new CountingStream(new BufferedInputStream(
                        obb != null ? new FileInputStream(obb) : getContentResolver().openInputStream(pickedGame), 1 << 16));
                int count = 0, lastPct = -1;
                boolean any = false;
                byte[] buf = new byte[1 << 16];
                try (ZipInputStream z = new ZipInputStream(cs)) {
                    ZipEntry e;
                    while ((e = z.getNextEntry()) != null) {
                        String name = e.getName();
                        int i = name.indexOf(".app/");
                        if (!name.startsWith("Payload/") || i < 0 || e.isDirectory()) continue;
                        String rel = name.substring(i + 5);
                        if (rel.isEmpty() || rel.contains("..") || rel.startsWith("_CodeSignature/") || rel.startsWith("SC_Info/")
                                || (!rel.contains("/") && rel.toLowerCase(Locale.ROOT).endsWith(".ttf"))) continue;
                        File out = new File(app, rel);
                        File parent = out.getParentFile();
                        if (parent != null) parent.mkdirs();
                        try (OutputStream o = new FileOutputStream(out)) {
                            int n;
                            while ((n = z.read(buf)) > 0) o.write(buf, 0, n);
                        }
                        any = true;
                        count++;
                        if (total > 0) {
                            int pct = (int) (cs.count * 1000 / total);
                            if (pct != lastPct) { lastPct = pct; js("window.slcProgress && slcProgress(" + pct + ",1000)"); }
                        } else if (count % 50 == 0) js("window.slcProgress && slcProgress(" + count + ",3000)");
                    }
                }
                if (!any || !new File(app, "page.plist").exists())
                    throw new IOException("That file doesn't contain Banshee's Last Cry (ink-en.app).");
            } catch (Exception e) {
                err = e.getMessage() != null ? e.getMessage() : e.toString();
            }
            js("window.slcExtracted && slcExtracted(" + (err == null ? "null" : q(err)) + ")");
        }).start();
    }

    static class CountingStream extends java.io.FilterInputStream {
        long count;
        CountingStream(InputStream in) { super(in); }
        @Override public int read() throws IOException { int b = super.read(); if (b >= 0) count++; return b; }
        @Override public int read(byte[] b, int off, int len) throws IOException { int n = super.read(b, off, len); if (n > 0) count += n; return n; }
        @Override public long skip(long n) throws IOException { long s = super.skip(n); count += s; return s; }
    }

    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    // ---------- JavaScript bridge (window.SLCNative) ----------
    class Bridge {
        @JavascriptInterface public String packageName() { return getPackageName(); }

        @JavascriptInterface public boolean hasAccelerometer() {
            android.hardware.SensorManager sm = (android.hardware.SensorManager) getSystemService(SENSOR_SERVICE);
            return sm != null && sm.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER) != null;
        }

        @JavascriptInterface public boolean hasVibrator() {
            android.os.Vibrator v = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
            return v != null && v.hasVibrator();
        }

        @JavascriptInterface public String findGame() { File f = findObb(); return f != null ? f.getAbsolutePath() : ""; }

        @JavascriptInterface public void pickGame() {
            main.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                startActivityForResult(i, REQ_PICK_GAME);
            });
        }

        @JavascriptInterface public void extract(boolean fromObb) { MainActivity.this.extract(fromObb); }

        @JavascriptInterface public String list(String dir) {
            JSONArray a = new JSONArray();
            if (dir.contains("..")) return a.toString();
            File[] files = new File(gameDir, dir).listFiles();
            if (files != null) for (File f : files) if (f.isFile()) a.put(f.getName());
            return a.toString();
        }

        @JavascriptInterface public void writeText(String path, String text) throws IOException {
            write(path, text.getBytes(StandardCharsets.UTF_8), false);
        }

        @JavascriptInterface public void writeBase64(String path, String b64, boolean append) throws IOException {
            write(path, Base64.decode(b64, Base64.DEFAULT), append);
        }

        void write(String path, byte[] data, boolean append) throws IOException {
            if (path.contains("..")) throw new IOException("bad path");
            File f = new File(gameDir, path);
            File parent = f.getParentFile();
            if (parent != null) parent.mkdirs();
            try (OutputStream o = new FileOutputStream(f, append)) { o.write(data); }
        }

        @JavascriptInterface public void setupDone() { getPrefs().edit().putBoolean("setupDone", true).apply(); }

        @JavascriptInterface public void share(String text) {
            main.post(() -> {
                Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(i, null));
            });
        }

        @JavascriptInterface public void saveText(String name, String text) {
            main.post(() -> {
                pendingSaveText = text;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json").putExtra(Intent.EXTRA_TITLE, name);
                startActivityForResult(i, REQ_SAVE);
            });
        }

        @JavascriptInterface public void resetSetup() {
            getPrefs().edit().putBoolean("setupDone", false).apply();
            main.post(() -> web.loadUrl(BASE + "setup.html"));
        }
    }
}

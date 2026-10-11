package dev.armadra.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import dev.armadra.mobile.core.ApkUpdate;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * 应用内更新（#288 §4）：下载安装包到 {@code cache/updates/}、核对 sha256、拉起系统安装器。
 * 判定（地址、摘要、文件名）在 {@link ApkUpdate}；这里只做 Android 那一半。下载在调用方的后台线程上跑。
 */
final class ApkInstaller {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;

    enum Status {
        STARTED("started"),
        PERMISSION_REQUIRED("permissionRequired"),
        CHECKSUM_MISMATCH("checksumMismatch"),
        FAILED("failed");

        final String wire;

        Status(String wire) {
            this.wire = wire;
        }
    }

    static final class Result {
        final Status status;
        final String message;

        Result(Status status, String message) {
            this.status = status;
            this.message = message;
        }
    }

    private ApkInstaller() {}

    static Result install(Activity activity, String url, String sha256) {
        if (!ApkUpdate.downloadable(url)) return new Result(Status.FAILED, "bad url");
        String expected = ApkUpdate.normalizeSha256(sha256);
        if (expected == null) return new Result(Status.FAILED, "bad sha256");
        if (activity == null) return new Result(Status.FAILED, "no activity");
        Context context = activity.getApplicationContext();

        File dir = new File(context.getCacheDir(), ApkUpdate.CACHE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) return new Result(Status.FAILED, "no cache dir");
        File apk = new File(dir, ApkUpdate.fileName(expected));
        // 只留这一个版本的包；上次下好且摘要对得上的直接复用（授权后再点一次不必重下）。
        clearExcept(dir, apk);
        if (!verified(apk, expected)) {
            delete(apk);
            Result downloaded = download(url, expected, apk, new File(dir, apk.getName() + ".part"));
            if (downloaded != null) return downloaded;
        }

        if (!context.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + context.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                activity.startActivity(settings);
            } catch (Exception noSettings) {
                return new Result(Status.FAILED, "no settings");
            }
            return new Result(Status.PERMISSION_REQUIRED, null);
        }

        Uri content = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
        Intent installer = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(content, ApkUpdate.MIME_TYPE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(installer);
        } catch (Exception noInstaller) {
            return new Result(Status.FAILED, "no installer");
        }
        return new Result(Status.STARTED, null);
    }

    /** 下到 {@code .part}，边下边算摘要；对得上才改名成正式文件。成功返回 {@code null}。 */
    private static Result download(String url, String expected, File apk, File part) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            // 跟随重定向（GitHub 资产会跳到对象存储）；HttpURLConnection 不会从 https 跳到 http。
            connection.setInstanceFollowRedirects(true);
            int code = connection.getResponseCode();
            if (!"https".equals(connection.getURL().getProtocol())) return new Result(Status.FAILED, "bad redirect");
            if (code != HttpURLConnection.HTTP_OK) return new Result(Status.FAILED, "http " + code);
            long length = connection.getContentLengthLong();
            if (length > ApkUpdate.MAX_BYTES) return new Result(Status.FAILED, "too large");

            MessageDigest digest = ApkUpdate.sha256();
            long total = 0;
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) != -1; ) {
                    total += n;
                    if (total > ApkUpdate.MAX_BYTES) throw new IOException("too large");
                    digest.update(buffer, 0, n);
                    out.write(buffer, 0, n);
                }
            }
            if (!ApkUpdate.matches(ApkUpdate.hex(digest.digest()), expected)) {
                delete(part);
                return new Result(Status.CHECKSUM_MISMATCH, null);
            }
            if (!part.renameTo(apk)) {
                delete(part);
                return new Result(Status.FAILED, "rename failed");
            }
            return null;
        } catch (Exception failed) {
            delete(part);
            String message = failed.getMessage();
            return new Result(Status.FAILED, message == null ? failed.getClass().getSimpleName() : message);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static boolean verified(File apk, String expected) {
        if (!apk.isFile()) return false;
        try (InputStream in = new FileInputStream(apk)) {
            return ApkUpdate.matches(ApkUpdate.sha256Hex(in, ApkUpdate.MAX_BYTES), expected);
        } catch (IOException unreadable) {
            return false;
        }
    }

    private static void clearExcept(File dir, File keep) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (!file.getName().equals(keep.getName())) delete(file);
        }
    }

    private static void delete(File file) {
        if (file.exists() && !file.delete()) file.deleteOnExit();
    }
}

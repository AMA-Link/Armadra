package dev.armadra.mobile.core;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * 应用内更新（#288 §4）里不依赖 Android SDK 的判定：{@code installApk({ url, sha256 })} 先过这里。
 *
 * <ul>
 *   <li>{@link #downloadable}：安装包只从 https 下载，不带用户名口令与片段；
 *   <li>{@link #normalizeSha256}：页面给的摘要是 64 位十六进制（大小写都收），统一成小写；
 *   <li>{@link #fileName}：缓存里的文件名只由摘要派生，与地址无关，不会被地址里的路径带偏；
 *   <li>{@link #sha256Hex} / {@link #matches}：边读边算摘要，按常量时间比较。
 * </ul>
 */
public final class ApkUpdate {
    /** 缓存子目录，与 {@code res/xml/file_paths.xml} 的 {@code cache-path name="updates"} 对应。 */
    public static final String CACHE_DIR = "updates";
    public static final String MIME_TYPE = "application/vnd.android.package-archive";
    /** 安装包大小上限；超过就不再往下读。 */
    public static final long MAX_BYTES = 512L * 1024 * 1024;
    private static final int MAX_URL_LENGTH = 4096;

    private ApkUpdate() {}

    public static boolean downloadable(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_URL_LENGTH) return false;
        try {
            URI uri = new URI(value);
            return uri.getHost() != null
                    && "https".equals(uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT))
                    && uri.getRawUserInfo() == null
                    && uri.getRawFragment() == null;
        } catch (Exception malformed) {
            return false;
        }
    }

    /** 64 位十六进制返回小写形式，其它（含空白、前缀、长度不对）返回 {@code null}。 */
    public static String normalizeSha256(String value) {
        if (value == null || value.length() != 64) return null;
        for (int i = 0; i < value.length(); i++) {
            if (Character.digit(value.charAt(i), 16) < 0) return null;
        }
        return value.toLowerCase(Locale.ROOT);
    }

    /** 缓存里的文件名；参数须是 {@link #normalizeSha256} 的结果。 */
    public static String fileName(String sha256) {
        return "armadra-" + sha256.substring(0, 16) + ".apk";
    }

    /** 读完整个流算 sha256（小写十六进制）；超过 {@code maxBytes} 抛 {@link IOException}。 */
    public static String sha256Hex(InputStream in, long maxBytes) throws IOException {
        MessageDigest digest = sha256();
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        for (int n; (n = in.read(buffer)) != -1; ) {
            total += n;
            if (total > maxBytes) throw new IOException("too large");
            digest.update(buffer, 0, n);
        }
        return hex(digest.digest());
    }

    /** 实际摘要与期望摘要是否一致（期望值大小写不敏感；任一不合法即不一致）。 */
    public static boolean matches(String actualHex, String expectedHex) {
        String actual = normalizeSha256(actualHex);
        String expected = normalizeSha256(expectedHex);
        if (actual == null || expected == null) return false;
        return MessageDigest.isEqual(actual.getBytes(), expected.getBytes());
    }

    public static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        return out.toString();
    }
}

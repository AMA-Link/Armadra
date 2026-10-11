package dev.armadra.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class ApkUpdateTest {
    /** sha256("abc") */
    private static final String ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    @Test
    public void downloadsOnlyOverHttps() {
        assertTrue(ApkUpdate.downloadable(
                "https://github.com/AMA-Link/Armadra/releases/download/v0.6.0/armadra-mobile_0.6.0_android.apk"));
        assertTrue(ApkUpdate.downloadable("HTTPS://example.com/a.apk?x=1"));
        assertFalse(ApkUpdate.downloadable("http://example.com/a.apk"));
        assertFalse(ApkUpdate.downloadable("http://127.0.0.1/a.apk"));
        assertFalse(ApkUpdate.downloadable("https://u:p@example.com/a.apk"));
        assertFalse(ApkUpdate.downloadable("https://example.com/a.apk#frag"));
        assertFalse(ApkUpdate.downloadable("file:///sdcard/a.apk"));
        assertFalse(ApkUpdate.downloadable("content://x/a.apk"));
        assertFalse(ApkUpdate.downloadable("https:///a.apk"));
        assertFalse(ApkUpdate.downloadable("not a url"));
        assertFalse(ApkUpdate.downloadable(""));
        assertFalse(ApkUpdate.downloadable(null));
        assertFalse(ApkUpdate.downloadable("https://example.com/" + "a".repeat(5000)));
    }

    @Test
    public void normalizesHexDigestsCaseInsensitively() {
        assertEquals(ABC, ApkUpdate.normalizeSha256(ABC.toUpperCase()));
        assertEquals(ABC, ApkUpdate.normalizeSha256(ABC));
        assertNull(ApkUpdate.normalizeSha256("sha256:" + ABC));
        assertNull(ApkUpdate.normalizeSha256(ABC.substring(1)));
        assertNull(ApkUpdate.normalizeSha256(ABC + "0"));
        assertNull(ApkUpdate.normalizeSha256(" " + ABC.substring(1)));
        assertNull(ApkUpdate.normalizeSha256(ABC.substring(1) + "g"));
        assertNull(ApkUpdate.normalizeSha256(null));
    }

    @Test
    public void fileNameComesFromTheDigestOnly() {
        assertEquals("armadra-ba7816bf8f01cfea.apk", ApkUpdate.fileName(ABC));
    }

    @Test
    public void hashesAStreamAndComparesCaseInsensitively() throws IOException {
        String actual = ApkUpdate.sha256Hex(stream("abc"), ApkUpdate.MAX_BYTES);
        assertEquals(ABC, actual);
        assertTrue(ApkUpdate.matches(actual, ABC.toUpperCase()));
        assertFalse(ApkUpdate.matches(actual, ABC.replace('b', 'c')));
        assertFalse(ApkUpdate.matches(actual, "nope"));
        assertFalse(ApkUpdate.matches(null, ABC));
    }

    @Test
    public void refusesStreamsOverTheLimit() {
        assertThrows(IOException.class, () -> ApkUpdate.sha256Hex(stream("abcd"), 3));
    }

    private static ByteArrayInputStream stream(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
    }
}

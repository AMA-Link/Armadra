package dev.armadra.mobile.core;

import java.util.regex.Pattern;

/**
 * 客户端流量日桶的行校验（与页面 {@code native-bridge.ts} 的 {@code NativeTrafficRow}、iOS
 * {@code TrafficStore.swift} 同义，设计 §6.4）。一行是「本地日 × 源 × 类别」的收发字节；页面整份交来，
 * 形状或上限不对整份拒绝，免得半份坏数据盖掉历史。
 */
public final class TrafficRows {
    public static final int MAX_ROWS = 20_000;
    /** 页面的整数上限（2^53 - 1）。 */
    private static final double MAX_COUNT = 9_007_199_254_740_991.0;

    private static final Pattern DAY = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");
    private static final Pattern SOURCE_ID = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");

    private TrafficRows() {}

    public static boolean valid(
            String day, String sourceId, String category, double bytesIn, double bytesOut, double streams) {
        if (day == null || !DAY.matcher(day).matches()) return false;
        if (sourceId == null || !SOURCE_ID.matcher(sourceId).matches()) return false;
        if (category == null || category.isEmpty() || category.length() > 32) return false;
        return count(bytesIn) && count(bytesOut) && count(streams);
    }

    private static boolean count(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value) && value >= 0 && value <= MAX_COUNT;
    }
}

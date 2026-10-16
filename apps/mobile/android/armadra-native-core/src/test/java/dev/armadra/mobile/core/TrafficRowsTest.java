package dev.armadra.mobile.core;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TrafficRowsTest {
    @Test
    public void aWellFormedRowIsAccepted() {
        assertTrue(TrafficRows.valid("2026-10-12", "src1", "api", 1, 2, 3));
        assertTrue(TrafficRows.valid("2026-10-12", "a.b_c:d-1", "terminal", 0, 0, 0));
        assertTrue(TrafficRows.valid("2026-10-12", "src1", "x".repeat(32), 9_007_199_254_740_991.0, 0, 0));
    }

    @Test
    public void badShapesAreRefused() {
        assertFalse(TrafficRows.valid("yesterday", "src1", "api", 1, 2, 3));
        assertFalse(TrafficRows.valid("2026-10-12", "../x", "api", 1, 2, 3));
        assertFalse(TrafficRows.valid("2026-10-12", "", "api", 1, 2, 3));
        assertFalse(TrafficRows.valid("2026-10-12", "src1", "", 1, 2, 3));
        assertFalse(TrafficRows.valid("2026-10-12", "src1", "x".repeat(33), 1, 2, 3));
        assertFalse(TrafficRows.valid("2026-10-12", "src1", "api", -1, 2, 3));
        assertFalse(TrafficRows.valid("2026-10-12", "src1", "api", 1, Double.NaN, 3));
        assertFalse(TrafficRows.valid("2026-10-12", "src1", "api", 1, 2, Double.POSITIVE_INFINITY));
        assertFalse(TrafficRows.valid("2026-10-12", "src1", "api", 1e300, 2, 3));
        assertFalse(TrafficRows.valid(null, "src1", "api", 1, 2, 3));
    }
}

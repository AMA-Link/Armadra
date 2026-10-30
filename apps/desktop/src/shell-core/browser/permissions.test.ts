import { describe, expect, it } from "vitest";

import { GUEST_PERMISSIONS_ALLOWED, allowGuestPermission } from "./permissions";

/**
 * The permission rule is an allowlist, and the allowlist is short. Anything
 * not named is denied, which is also what happens to a permission Chromium
 * invents after this file was written.
 */
describe("guest permissions", () => {
  it("denies the hardware and the person's whereabouts", () => {
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "midi",
      "midiSysex",
      "pointerLock",
      "fullscreen",
      "openExternal",
      "clipboard-read",
      "display-capture",
      "hid",
      "serial",
      "usb",
      "idle-detection",
      "window-management",
      "keyboardLock",
      "speaker-selection",
      "storage-access",
      "top-level-storage-access",
      "fileSystem",
      "deprecated-sync-clipboard-read",
      "unknown-permission-of-the-future",
      "",
    ]) {
      expect(allowGuestPermission(permission), permission).toBe(false);
    }
  });

  it("lets a page put text into the clipboard, and nothing more", () => {
    expect(allowGuestPermission("clipboard-sanitized-write")).toBe(true);
    expect(GUEST_PERMISSIONS_ALLOWED).toEqual(["clipboard-sanitized-write"]);
  });
});

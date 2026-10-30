import type { Session } from "electron";

import { allowGuestPermission } from "../../shell-core/browser/permissions";

/**
 * Installs the guest permission rule on a session.
 *
 * Both of Electron's paths are covered: `setPermissionRequestHandler` is the
 * one a page's explicit request goes through (`getUserMedia`,
 * `Notification.requestPermission`, geolocation), and
 * `setPermissionCheckHandler` is the one Chromium asks before features that
 * never prompt (`navigator.permissions.query`, the clipboard, notifications
 * already "granted"). Without the second, a page can still read what the first
 * would have refused.
 *
 * The handlers are session-wide — one `persist:armadra-browser-<ws>` partition
 * is shared by every guest of a workspace — so they are installed once per
 * session and left alone afterwards. Reinstalling on every guest registration
 * would be harmless but would also hide a bug where two callers disagree.
 */
const guarded = new WeakSet<object>();

export function guardGuestPermissions(session: Session): boolean {
  if (guarded.has(session)) return false;
  guarded.add(session);
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowGuestPermission(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) =>
    allowGuestPermission(permission),
  );
  return true;
}

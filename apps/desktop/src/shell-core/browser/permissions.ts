/**
 * What a guest page may be granted when it asks for a browser permission.
 *
 * Electron's default, with no handler installed, is to GRANT: a page in a
 * browser node could turn on the camera, read the location or register for
 * notifications, and nothing would ask anybody. Inside a guest there is no
 * prompt to show, and when an agent drives the page over CDP there is nobody
 * looking at it either. So the rule is a short allowlist and a denial for
 * everything else, including anything Chromium adds later under a name this
 * file has not heard of.
 *
 * The one entry: writing to the clipboard. A page's "copy" button calls
 * `navigator.clipboard.writeText` behind a user gesture; that puts text INTO
 * the clipboard and reads nothing out of it. `clipboard-read` stays denied —
 * the clipboard is the person's, not the page's.
 */
export const GUEST_PERMISSIONS_ALLOWED: readonly string[] = [
  "clipboard-sanitized-write",
];

export function allowGuestPermission(permission: string): boolean {
  return GUEST_PERMISSIONS_ALLOWED.includes(permission);
}

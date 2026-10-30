import { describe, expect, it } from "vitest";
import type { Session } from "electron";

import { guardGuestPermissions } from "./permissions";

/**
 * The regression this pins: a guest session with no permission handler GRANTS
 * every request. Electron itself is not mocked — `permissions.ts` imports only
 * a type from it — so the session below is the two setters and a record of
 * what was installed.
 */

type RequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: unknown,
) => void;
type CheckHandler = (
  contents: unknown,
  permission: string,
  origin: string,
  details: unknown,
) => boolean;

class FakeSession {
  request: RequestHandler | null = null;
  check: CheckHandler | null = null;
  installs = 0;

  setPermissionRequestHandler(handler: RequestHandler | null) {
    this.installs += 1;
    this.request = handler;
  }
  setPermissionCheckHandler(handler: CheckHandler | null) {
    this.installs += 1;
    this.check = handler;
  }

  ask(permission: string): boolean {
    let answer: boolean | null = null;
    this.request?.(null, permission, (granted) => (answer = granted), {});
    if (answer === null) throw new Error("request handler did not answer");
    return answer;
  }
  query(permission: string): boolean {
    if (!this.check) throw new Error("no check handler");
    return this.check(null, permission, "https://example.test", {});
  }
}

function guard(session: FakeSession): boolean {
  return guardGuestPermissions(session as unknown as Session);
}

describe("guest permission handlers", () => {
  it("deny by default, on both paths", () => {
    const session = new FakeSession();
    guard(session);
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "pointerLock",
      "something-new",
    ]) {
      expect(session.ask(permission), `request ${permission}`).toBe(false);
      expect(session.query(permission), `check ${permission}`).toBe(false);
    }
  });

  it("allow only the clipboard write", () => {
    const session = new FakeSession();
    guard(session);
    expect(session.ask("clipboard-sanitized-write")).toBe(true);
    expect(session.query("clipboard-sanitized-write")).toBe(true);
  });

  it("are installed once per session", () => {
    const session = new FakeSession();
    expect(guard(session)).toBe(true);
    expect(guard(session)).toBe(false);
    expect(guard(session)).toBe(false);
    expect(session.installs).toBe(2);
    // Still the guarding handlers, not something a second call replaced.
    expect(session.ask("media")).toBe(false);

    const other = new FakeSession();
    expect(guard(other)).toBe(true);
    expect(other.installs).toBe(2);
  });
});

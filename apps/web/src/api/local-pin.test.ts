import { afterEach, describe, expect, it, vi } from "vitest";

import { localRuntimeApi, runtimeApi } from "./client";
import {
  type Source,
  currentSource,
  localSource,
  onLocal,
  pinLocal,
  setCurrentSourceResolver,
} from "./source";

const other = { sourceId: "other-host" } as unknown as Source;

describe("钉在本机源上", () => {
  afterEach(() => setCurrentSourceResolver(null));

  it("别的源是当前源时，onLocal 与 pinLocal 的方法仍发往本机，之后复原", async () => {
    setCurrentSourceResolver(() => other);
    const seen = vi.fn();
    const api = pinLocal({
      probe: (n: number) => {
        seen(currentSource().sourceId, n);
        return Promise.resolve(n);
      },
      label: "x",
    });
    expect(await api.probe(2)).toBe(2);
    expect(seen).toHaveBeenCalledWith(localSource.sourceId, 2);
    expect(api.label).toBe("x");
    expect(onLocal(() => currentSource())).toBe(localSource);
    expect(currentSource()).toBe(other);
  });

  it("抛错时也复原", () => {
    setCurrentSourceResolver(() => other);
    expect(() =>
      onLocal(() => {
        throw new Error("x");
      }),
    ).toThrow();
    expect(currentSource()).toBe(other);
  });

  it("localRuntimeApi 的请求发往本机，runtimeApi 的发往当前源", async () => {
    const remoteFetch = vi.fn(async () =>
      Response.json({ status: "ok", version: "1" }),
    );
    const remote = {
      sourceId: "other-host",
      httpBase: "http://other.example",
      credentials: { mode: "none" },
      fetch: remoteFetch,
    } as unknown as Source;
    const localFetch = vi
      .spyOn(localSource, "fetch")
      .mockImplementation(async () =>
        Response.json({ status: "ok", version: "1" }),
      );
    setCurrentSourceResolver(() => remote);
    await localRuntimeApi.health().catch(() => undefined);
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(remoteFetch).not.toHaveBeenCalled();
    await runtimeApi.health().catch(() => undefined);
    expect(remoteFetch).toHaveBeenCalledTimes(1);
    localFetch.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 页面的 Trusted Types 策略（设计 saas-host-open §5.4 Q13）：HTML 一律净化，脚本地址只认
 * 本源与挑战组件；浏览器没有 Trusted Types 时原样退回字符串。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** 假的 `trustedTypes`：记下建了哪些策略，造出的值包一层好认出来。 */
function fakeTrustedTypes() {
  const names: string[] = [];
  return {
    names,
    createPolicy(
      name: string,
      rules: {
        createHTML?: (input: string) => string;
        createScriptURL?: (input: string) => string;
      },
    ) {
      if (names.includes(name)) throw new TypeError("duplicate policy");
      names.push(name);
      return {
        createHTML: (input: string) => {
          const html = rules.createHTML!(input);
          return { html, toString: () => html };
        },
        createScriptURL: (input: string) => ({
          url: rules.createScriptURL!(input),
        }),
      };
    },
  };
}

describe("Trusted Types 策略", () => {
  it("HTML 经白名单净化：事件属性、脚本、框架都去掉", async () => {
    const tt = fakeTrustedTypes();
    vi.stubGlobal("trustedTypes", tt);
    const { trustedHTML } = await import("./trusted-types");
    const made = trustedHTML(
      '<p onclick="x()">hi</p><img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script><iframe srcdoc="<b>"></iframe>',
    ) as unknown as { html: string };
    expect(made.html).toBe("<p>hi</p>");
    expect(tt.names).toContain("armadra");
    // 净化器自己的惰性策略。
    expect(tt.names).toContain("armadra-sanitize");
    expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
  });

  it("脚本地址：本源与挑战组件放行，别的来源抛", async () => {
    vi.stubGlobal("trustedTypes", fakeTrustedTypes());
    const { trustedScriptURL } = await import("./trusted-types");
    expect(
      trustedScriptURL("https://challenges.cloudflare.com/turnstile/v0/api.js"),
    ).toEqual({ url: "https://challenges.cloudflare.com/turnstile/v0/api.js" });
    expect(trustedScriptURL("/assets/x.js")).toEqual({
      url: `${location.origin}/assets/x.js`,
    });
    expect(() => trustedScriptURL("https://evil.example/x.js")).toThrow();
  });

  it("没有 Trusted Types：答净化后的字符串", async () => {
    const { trustedHTML } = await import("./trusted-types");
    expect(trustedHTML("<b>ok</b><script>bad()</script>")).toBe("<b>ok</b>");
  });

  it("default 策略：第三方直接写的纯文本放行，带标记的经净化", async () => {
    const tt = fakeTrustedTypes();
    vi.stubGlobal("trustedTypes", tt);
    const rules: Record<string, (input: string) => string> = {};
    const create = tt.createPolicy.bind(tt);
    tt.createPolicy = (name, given) => {
      if (name === "default") rules.html = given.createHTML!;
      return create(name, given);
    };
    const { installDefaultTrustedTypesPolicy } = await import(
      "./trusted-types"
    );
    installDefaultTrustedTypesPolicy();
    expect(tt.names).toContain("default");
    const css = "[data-radix-scroll-area-viewport]{scrollbar-width:none}";
    expect(rules.html!(css)).toBe(css);
    expect(rules.html!('<img src=x onerror="pwned()"><b>ok</b>')).toBe(
      "<b>ok</b>",
    );
  });
});

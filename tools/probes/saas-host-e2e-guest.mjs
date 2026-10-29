// saas-host-e2e 的 E8（设计 saas-host-open §8.1）：host1 经 SaaS 路线建一条只读链接，新 browser context
// 打开：落地页「加入」后地址是 `/h/<host1>`；刷新两次仍在画布（经访客记录续上、云端刷新令牌旋转）；
// 撤销链接后 `/h/` 显示「访问已被收回」、访客记录被清。由 `saas-host-e2e.mjs` 调，共用它的浏览器与 host1。
import { nodeAt } from "./platform-lib.mjs";
import { scenario } from "./ui-features/harness.mjs";

export async function runGuestLink({
  report,
  output,
  ISSUER,
  accounts,
  browser,
  openTab,
  consoleSignIn,
  local,
  serviceId,
  workspace,
  hostId,
  terminal,
}) {
  const s = scenario(
    report,
    "E8 访客经分享链接落 /h/、刷新续上、撤销后收回",
    output,
  );
  const created = await local(`/api/sources/remotes/${serviceId}/links`, {
    method: "POST",
    body: JSON.stringify({
      workspaceId: workspace.id,
      role: "viewer",
      readOnly: true,
      ttlMs: 3_600_000,
      maxUses: 5,
      label: "e8",
    }),
  });
  const linkId = created.link.linkId;
  s.check(
    created.url.startsWith(`${ISSUER}/j/`),
    "SaaS 路线的链接落在控制台来源的 /j/",
  );
  const guestContext = await browser.context();
  const guestTab = await openTab(browser, guestContext, "guest");
  const landingReady = `const buttons = [...document.querySelectorAll("button")];
     if (buttons.some((one) => one.innerText.trim() === "登录后加入")) return "login";
     const button = buttons.find((one) => one.innerText.trim() === "加入");
     return button && !button.disabled ? "join" : null;`;
  await guestTab.goto(created.url);
  let landingKind = await guestTab.until(landingReady, "落地页出现「加入」", {
    timeout: 30_000,
  });
  // 团队设置要求登录才能用链接：以 member（对这台没有授予）登录后再开同一条链接。
  report.e8RequiresAccount = landingKind === "login";
  if (landingKind === "login") {
    s.ok("团队要求登录才能用链接：以没有授予的 member 登录后加入");
    await consoleSignIn(guestTab, accounts.member);
    await guestTab.goto(created.url);
    landingKind = await guestTab.until(
      landingReady,
      "登录后落地页出现「加入」",
      {
        timeout: 30_000,
      },
    );
  }
  const landing = await guestTab.evaluate(
    'return document.querySelector("h1")?.parentElement?.innerText ?? "";',
  );
  s.ok("落地页", String(landing).replace(/\s+/g, " ").slice(0, 120));
  s.check(
    !(await guestTab.evaluate("return location.hash !== '';")),
    "片段读入内存后从地址栏移除",
  );
  await s.shot(guestTab, "e8-landing");
  await guestTab.evaluate(
    `[...document.querySelectorAll("button")].find((one) => one.innerText.trim() === "加入").click(); return true;`,
  );
  const guestReady = `return location.pathname === "/h/${hostId}" && !!document.querySelector('[data-slot="guest-bar"]') && !!document.querySelector('${nodeAt(terminal.id)}') ? true : null;`;
  await guestTab.until(guestReady, "加入后进画布、地址是 /h/<host1>", {
    timeout: 90_000,
  });
  s.ok("加入后地址是 /h/<host1>，访客栏与画布在");
  s.check(
    !(await guestTab.evaluate(
      "return !!document.querySelector('[data-slot=\"host-bar\"]');",
    )),
    "访客没有主机顶栏",
  );
  s.check(
    (await guestTab.evaluate(
      "return Object.keys(localStorage).filter((k) => k.startsWith('armadra.guest.')).length;",
    )) === 1,
    "留下一份访客记录",
  );
  await s.shot(guestTab, "e8-guest-canvas");
  await guestTab.reload();
  // 刷新续不上也先记下、接着验撤销（最后再判这一步失败），一次跑完看全。
  const resumed = await guestTab
    .until(
      `${guestReady.replace(/^return /, "if (").replace(/ \? true : null;$/, ")")} return "canvas";
       const text = document.body.innerText;
       if (location.pathname !== "/h/${hostId}") return "left:" + location.pathname;
       return text.includes("访问已被收回") || text.includes("打不开这台主机") || text.includes("没有这台主机") ? "card:" + text.slice(0, 40) : null;`,
      "刷新后的去向",
      { timeout: 90_000 },
    )
    .catch((error) => `timeout:${error.message}`);
  report.e8Refresh = resumed;
  if (resumed === "canvas") {
    s.ok(
      report.e8RequiresAccount
        ? "刷新仍在画布（Cookie 账号进不了这台，退回访客记录）"
        : "刷新仍在画布（没有 Cookie 会话，用访客记录）",
    );
    // 访客记录里云端刷新令牌的指纹（只比较是否变了，不把令牌带出页面）。
    const tokenPrint = `const raw = Object.entries(localStorage).find(([k]) => k.startsWith("armadra.guest."));
      if (!raw) return null;
      const token = JSON.parse(raw[1]).cloudRefreshToken ?? "";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      return [...new Uint8Array(digest)].slice(0, 4).join(".");`;
    const firstPrint = await guestTab.evaluate(tokenPrint);
    s.check(firstPrint !== null, "刷新后访客记录还在（没被误判作废）");
    // 再刷新一次：上一次续上时令牌已旋转，用旋转后的再续。
    await guestTab.reload();
    await guestTab.until(guestReady, "第二次刷新后仍在画布", {
      timeout: 90_000,
    });
    const secondPrint = await guestTab.evaluate(tokenPrint);
    s.check(secondPrint !== null, "第二次刷新后访客记录还在");
    s.check(
      secondPrint !== firstPrint,
      "第二次刷新又旋转了云端刷新令牌（用旋转后的续上）",
    );
    s.ok("第二次刷新仍在画布，访客栏在");
    await s.shot(guestTab, "e8-guest-refresh2");
  } else {
    console.log(`  FAIL  刷新后没回到画布：${resumed}`);
    await s.shot(guestTab, "e8-guest-refresh");
    // 重新经落地页加入（链接还能用），继续验撤销。
    await guestTab.goto(created.url);
    await guestTab.until(landingReady, "重新加入的落地页", {
      timeout: 30_000,
    });
    await guestTab.evaluate(
      `[...document.querySelectorAll("button")].find((one) => ["加入", "打开"].includes(one.innerText.trim())).click(); return true;`,
    );
    await guestTab.until(guestReady, "重新加入后进画布", { timeout: 90_000 });
  }
  await local(`/api/sources/remotes/${serviceId}/links/${linkId}`, {
    method: "DELETE",
  });
  const revoked =
    "return document.body.innerText.includes('访问已被收回') ? true : null;";
  const live = await guestTab
    .until(revoked, "撤销后页面上显示访问已被收回", { timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  s.ok(
    live
      ? "撤销后开着的 /h/ 盖上「访问已被收回」"
      : "开着的页面 30 秒内没变，刷新再看",
  );
  if (!live) {
    await guestTab.reload();
    await guestTab.until(revoked, "刷新后显示访问已被收回", {
      timeout: 60_000,
    });
    s.ok("刷新后 /h/ 显示「访问已被收回」");
  }
  s.check(
    (await guestTab.evaluate(
      "return Object.keys(localStorage).filter((k) => k.startsWith('armadra.guest.')).length;",
    )) === 0,
    "访客记录已清",
  );
  await s.shot(guestTab, "e8-guest-revoked");
  await guestTab.close();
  s.check(resumed === "canvas", "刷新后经访客记录续上、仍在画布", resumed);
  s.entry.status = "passed";
}

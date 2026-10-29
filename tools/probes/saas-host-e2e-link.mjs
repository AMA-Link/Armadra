// saas-host-e2e 的 E10（设计 saas-host-open §4.3、§8.1，B5）：owner 在控制台主机详情「链接」页签新建链接，
// 拿到整条链接；host1 自己的分享链接列表（分享弹层同一份 `shareLinks` / `shareLinkUrl`）里有同一条且
// 可复制；member 看不到「新建链接」；host1 登出 Armadra 云（`remoteLogout`：删凭据、留登记，与只用
// `--token` 登记、没有设备码登录的主机一样没有可用的登录行）之后再建，提示在主机上 `cloud login`。
// 整条链接只留在探针内存里比较，不写进结果、不截图（结果对话框开着时不截图，出错先关对话框）。
// 由 `saas-host-e2e.mjs` 调（`ARMADRA_SAAS_ONLY` 点名 E10），共用它的浏览器、host1 与 owner 的受信浏览器。
import { scenario, sleep } from "./ui-features/harness.mjs";

/** 页面里按可见文字点按钮（Radix 的触发器认 click）。 */
const clickButton = (label) =>
  `const button = [...document.querySelectorAll("button, a")].find((one) => one.innerText.trim() === ${JSON.stringify(label)} && !one.disabled);
   if (!button) return null;
   button.click();
   return true;`;

/** 受控输入框写值（走 React 的 setter 与 input 事件）。 */
const typeInto = (label, value) =>
  `const field = [...document.querySelectorAll("[role=dialog] label")].find((one) => one.innerText.trim() === ${JSON.stringify(label)});
   const input = field && document.getElementById(field.htmlFor);
   if (!input) return null;
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
   input.dispatchEvent(new Event("input", { bubbles: true }));
   return true;`;

export async function runNewLink({
  report,
  output,
  ISSUER,
  TEAM,
  accounts,
  browser,
  ownerContext,
  openTab,
  consoleSignIn,
  local,
  serviceId,
  hostId,
}) {
  const s = scenario(
    report,
    "E10 控制台新建链接：主人拿到整条链接、主机上同一条可复制、member 看不到、主机没登录云时提示",
    output,
  );
  // host1 对每个云账号的 cloud/login（含 probe）每分钟 5 次；E2 刚用过，等桶满再开始。
  await sleep(61_000);
  const detail = `${ISSUER}/t/${TEAM}/hosts/${hostId}?tab=links`;
  const tab = await openTab(browser, ownerContext, "owner-links");
  await browser.call("Browser.grantPermissions", {
    origin: ISSUER,
    browserContextId: ownerContext,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  let linkId;
  const openDialog = async () => {
    await tab.until(clickButton("新建链接"), "主人的链接页签有「新建链接」", {
      timeout: 30_000,
    });
    await tab.until(
      `return document.querySelector("[role=dialog]")?.innerText.includes("创建链接") ? true : null;`,
      "新建链接对话框",
      { timeout: 10_000 },
    );
  };
  try {
    await tab.goto(detail);
    await openDialog();
    await tab.until(typeInto("备注", "e10"), "填备注", { timeout: 5_000 });
    await s.shot(tab, "e10-form");
    await tab.evaluate(clickButton("创建链接"));
    await tab.until(
      'return document.querySelector("[data-slot=new-link-url] input")?.value ? true : null;',
      "结果对话框给出整条链接",
      { timeout: 60_000 },
    );
    // 整条链接只在探针内存里。
    const url = await tab.evaluate(
      'return document.querySelector("[data-slot=new-link-url] input").value;',
    );
    s.check(
      typeof url === "string" && url.startsWith(`${ISSUER}/j/`),
      "链接落在控制台来源的 /j/",
    );
    s.check(
      /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+\.[A-Za-z0-9_-]{16}$/.test(
        url.split("#")[1] ?? "",
      ),
      "片段带秘密、邀请令牌（本身两段）与身份指纹前 16 位",
      // 只报形状（段数与各段长度），不报内容。
      (url.split("#")[1] ?? "")
        .split(".")
        .map(
          (part) => `${part.length}${/^[A-Za-z0-9_-]*$/.test(part) ? "" : "!"}`,
        )
        .join("."),
    );
    await tab.evaluate(clickButton("复制链接"));
    await tab.until(
      'return document.body.innerText.includes("已复制") ? true : null;',
      "「复制链接」写进剪贴板",
      { timeout: 10_000 },
    );
    s.ok("复制链接");
    s.check(
      !(await tab.evaluate(
        `const url = document.querySelector("[data-slot=new-link-url] input").value;
         return location.href.includes(url.split("#")[1]) ||
           JSON.stringify({ ...localStorage }).includes(url.split("#")[1]) ||
           JSON.stringify({ ...sessionStorage }).includes(url.split("#")[1]);`,
      )),
      "链接片段不进地址与存储",
    );
    const listed = await local(`/api/sources/remotes/${serviceId}/links`);
    const row = listed.links.find((one) => one.label === "e10");
    s.check(row !== undefined, "host1 的分享链接列表里有这一条");
    linkId = row.linkId;
    s.check(
      row.copyable === true && row.target === "host",
      "整台主机、主机上可再复制",
      { copyable: row.copyable, target: row.target, role: row.role },
    );
    const again = await local(
      `/api/sources/remotes/${serviceId}/links/${linkId}/url`,
      { method: "POST", body: "{}" },
    );
    s.check(again.url === url, "host1 再取的整条链接与控制台拿到的同一条");
    await tab.evaluate(clickButton("完成"));
    await tab.until(
      'return document.querySelector("[role=dialog]") ? null : true;',
      "关掉结果对话框",
      { timeout: 10_000 },
    );
    s.check(
      !(await tab.evaluate(
        `return document.body.innerHTML.includes(${JSON.stringify(url.split("#")[1])});`,
      )),
      "关掉之后页面上不再有整条链接",
    );
    await s.shot(tab, "e10-after");

    /* member：团队里别人的主机，没有页签，也没有「新建链接」。 */
    const memberContext = await browser.context();
    const memberTab = await openTab(browser, memberContext, "member-links");
    await consoleSignIn(memberTab, accounts.member);
    await memberTab.goto(detail);
    const memberView = await memberTab.until(
      `const h1 = document.querySelector("h1")?.innerText ?? "";
       const text = document.body.innerText;
       return h1 && h1 !== "" && !document.querySelector('[aria-busy="true"]') ? h1 : text.includes("找不到") ? "notFound" : null;`,
      "member 打开主机详情",
      { timeout: 30_000 },
    );
    await sleep(1_500);
    s.check(
      !(await memberTab.evaluate(
        `return [...document.querySelectorAll("button")].some((one) => one.innerText.trim() === "新建链接");`,
      )),
      "member 看不到「新建链接」",
      memberView,
    );
    await s.shot(memberTab, "e10-member");
    await memberTab.close();

    /* host1 没有可用的 Armadra 云登录行：提示在主机上 cloud login。先撤掉刚建的链接（登出后撤不了）。 */
    await local(`/api/sources/remotes/${serviceId}/links/${linkId}`, {
      method: "DELETE",
    });
    linkId = undefined;
    await local(`/api/sources/remotes/${serviceId}/logout`, {
      method: "POST",
      body: "{}",
    });
    // 上一次建链接刚用过 probe 与登录：同一账号每分钟 5 次，等桶满再试。
    await sleep(61_000);
    await tab.goto(detail);
    await openDialog();
    await tab.evaluate(clickButton("创建链接"));
    const hint = await tab.until(
      `const text = document.querySelector("[role=dialog]")?.innerText ?? "";
       return text.includes("这台主机还没登录 Armadra 云") || text.includes("把你当作成员") || document.querySelector("[data-slot=new-link-failed]") ? text : null;`,
      "主机没登录云时的提示",
      { timeout: 60_000 },
    );
    s.check(
      hint.includes("这台主机还没登录 Armadra 云") &&
        hint.includes(`armadra-server cloud login --issuer ${ISSUER}`),
      "提示「这台主机还没登录 Armadra 云」与 cloud login 命令",
      hint.replace(/\s+/g, " ").slice(0, 160),
    );
    await s.shot(tab, "e10-signed-out");
    s.entry.status = "passed";
  } catch (error) {
    // 没到结果对话框（没有整条链接）时记下对话框里的提示，便于看是哪个码。
    report.e10Dialog = await tab
      .evaluate(
        `return document.querySelector("[data-slot=new-link-url]") ? "<结果对话框>" : (document.querySelector("[role=dialog]")?.innerText ?? document.body.innerText).slice(0, 400);`,
      )
      .catch(() => "");
    throw error;
  } finally {
    // 出错时结果对话框可能还开着：先离开页面，免得入口补截的图里有整条链接。
    await tab.goto("about:blank").catch(() => undefined);
    // 半路出错时撤掉这次建的链接（还没拿到号就按备注找）。
    linkId ??= await local(`/api/sources/remotes/${serviceId}/links`)
      .then(
        (listed) =>
          listed.links.find((one) => one.label === "e10" && !one.revokedAtMs)
            ?.linkId,
      )
      .catch(() => undefined);
    if (linkId !== undefined)
      await local(`/api/sources/remotes/${serviceId}/links/${linkId}`, {
        method: "DELETE",
      }).catch(() => undefined);
  }
}

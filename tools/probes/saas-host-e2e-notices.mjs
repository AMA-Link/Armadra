// `saas-host-e2e.mjs` 的 E7c（AMA-Link/Armadra#607，契约 §81.1）：设备背书进「需要人处理」。
//
// owner 离开 `/h/` 之后经控制台信任页连续背书 member 的两个新浏览器：host1 上多两条未读；member 的
// `/h/` 不弹通知、铃铛里没有「本机」一组；owner 再打开 `/h/` 不补弹，铃铛的「本机」一组列出全部未读；
// 点一条打开设备页，浏览器经中继标不了已读。拆出来只为让主探针不超过单文件行数上限。
import { SAS_ON_PAGE } from "./platform-lib.mjs";
import { scenario, sleep } from "./ui-features/harness.mjs";

export async function endorsementNotices({
  report,
  output,
  issuer,
  team,
  accounts,
  browser,
  openTab,
  consoleSignIn,
  endorse,
  hostUrl,
  trustTab,
  trustRow,
  ready,
  ownerTab,
  memberTab,
  unread,
}) {
  const c = scenario(
    report,
    "E7c 没开 /h/ 时背书不丢、连续多次都在、只给 owner",
    output,
  );
  const unreadBefore = unread();
  const noticeShown = (tab) =>
    tab.evaluate(
      `return [...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes("放行了"));`,
    );
  await ownerTab.goto(`${issuer}/t/${team}/trust`);
  const extra = [];
  for (const round of [2, 3]) {
    const context = await browser.context();
    const tab = await openTab(browser, context, `member-${round}`);
    extra.push(tab);
    await consoleSignIn(tab, accounts.member);
    await tab.goto(hostUrl);
    const sas = await tab.until(
      SAS_ON_PAGE,
      `member 第 ${round} 个浏览器待确认`,
      { timeout: 60_000 },
    );
    await trustTab.reload();
    await trustTab.until(
      `const row = ${trustRow(accounts.member.name)}; return row && [...row.querySelectorAll('button')].some((b) => b.innerText.trim() === "信任") ? true : null;`,
      `信任页列出 member 第 ${round} 个浏览器`,
      { timeout: 60_000 },
    );
    await endorse(accounts.member.name, sas);
    await tab.until(ready, `member 第 ${round} 个浏览器被背书后进入`, {
      timeout: 60_000,
    });
    // 云端的信任请求在主机报回之后才撤下：等一会儿再造下一台，免得点到旧的那条（不反复刷新信任页：
    // 每次刷新都要经通道问一次受信判定，问多了会被限流）。
    await sleep(15_000);
  }
  c.check(unread() === unreadBefore + 2, "host1 上多了两条未读背书", {
    before: unreadBefore,
    after: unread(),
  });
  c.check(!(await noticeShown(memberTab)), "member 的 /h/ 没有弹背书通知");
  await memberTab.clickOn(
    `return document.querySelector('button[aria-label="通知"]');`,
    "member 的铃铛",
  );
  await sleep(1_500);
  c.check(
    !(await memberTab.evaluate(
      `return !!document.querySelector('section[aria-label="本机"]');`,
    )),
    "member 的通知面板没有「本机」一组",
  );
  await c.shot(memberTab, "e7c-member-bell");
  await ownerTab.goto(hostUrl);
  await ownerTab.until(ready, "owner 重新打开 /h/", {
    timeout: 60_000,
  });
  await sleep(2_000);
  c.check(!(await noticeShown(ownerTab)), "错过的背书不补弹（只进铃铛）");
  await ownerTab.clickOn(
    `return document.querySelector('button[aria-label="通知"]');`,
    "owner 的铃铛",
  );
  const listedHost = await ownerTab.until(
    `const section = document.querySelector('section[aria-label="本机"]');
     return section ? [...section.querySelectorAll('li')].map((li) => li.innerText) : null;`,
    "owner 的通知面板有「本机」一组",
    { timeout: 30_000 },
  );
  const hostLines = listedHost.map((line) => line.replace(/\s+/g, " "));
  c.check(
    hostLines.length === unread() &&
      hostLines.filter((line) => line.includes(accounts.member.name)).length >=
        2,
    "「本机」一组列出全部未读背书（含没开 /h/ 时的两次）",
    hostLines,
  );
  await c.shot(ownerTab, "e7c-owner-bell");
  const unreadBeforeClick = unread();
  await ownerTab.clickOn(
    `return document.querySelector('section[aria-label="本机"] li button');`,
    "点「本机」里的一条背书",
  );
  await ownerTab.until(
    `return [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.innerText.trim() === "配对新设备") ? true : null;`,
    "打开设置的设备页",
    { timeout: 30_000 },
  );
  c.ok("点一条背书打开设置的「设备与会话」");
  await sleep(1_500);
  c.check(
    unread() === unreadBeforeClick,
    "浏览器经中继标不了已读（契约 §81.1），主机上仍未读",
    { before: unreadBeforeClick, after: unread() },
  );
  await ownerTab.key("Escape");
  for (const tab of extra) await tab.close();
  c.entry.status = "passed";
}

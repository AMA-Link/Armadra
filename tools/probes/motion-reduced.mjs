// 展示页 `motion` 分区（设计系统 §8）的「减少动效」探针：
//
//   * 两套主题各截一张 `motion-<主题>-1440-reduced-motion.png`；
//   * 基线（不减少）：点重放后，列表错落与发芽这类配方确实有位移 / 缩放动画——
//     证明下面的检测不是空跑；
//   * `prefers-reduced-motion: reduce` 下：每格点重放与操作之后，没有任何位移 /
//     缩放 / 旋转（转圈除外）的动画在跑；没有无限循环的动画（转圈除外）；
//     指示器点下去当拍就在目标位置（不平移）；数字当拍就是新值（不滚动）；
//   * 控制台 error 与未捕获异常一律算失败。
//
// 只起随机端口的 Vite 与新 profile 的无头 Chrome，`ARMADRA_DATA_DIR` 指到空的临时
// 目录，不读写操作员自己的数据目录。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   node tools/probes/motion-reduced.mjs [输出目录]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harness, sleep, startChrome, startVite } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/motion-reduced"));
mkdirSync(output, { recursive: true });

const h = harness(output);
const { report, step } = h;
report.failures = [];
report.console = [];

function check(ok, name, detail = "") {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (ok) step(name, text);
  else {
    report.failures.push({ name, detail: text });
    console.error(`  FAIL  ${name}${text ? ` — ${text}` : ""}`);
  }
}

/**
 * 页面里运行的探测：收集一格里正在跑的动画，标出位移类（transform / translate /
 * scale / rotate）与无限循环的。转圈（`armadra-spin`）是唯一允许的循环与旋转。
 */
const COLLECT = `
  const MOVES = ["transform", "translate", "scale", "rotate"];
  return (recipe) => {
    const cell = document.querySelector('[data-motion-cell="' + recipe + '"]');
    return cell
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running")
      .map((animation) => {
        const keys = new Set(
          animation.effect.getKeyframes().flatMap((frame) => Object.keys(frame)),
        );
        const timing = animation.effect.getComputedTiming();
        return {
          name: animation.animationName ?? "transition:" + animation.transitionProperty,
          moves: MOVES.some((key) => keys.has(key)),
          infinite: timing.iterations === Infinity,
        };
      })
      .filter((animation) => animation.name !== "armadra-spin");
  };
`;

await h.run(async () => {
  const data = h.temp("armadra-motion-");
  const origin = await startVite(h, root, {
    ...process.env,
    ARMADRA_DATA_DIR: data,
    BROWSER: "none",
  });
  step("Vite 已启动", origin);
  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "motion" });
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  let visit = 0;
  const open = async (theme) => {
    visit += 1;
    await page.call("Page.navigate", {
      url: `${origin}/showcase.html?theme=${theme}&only=1&visit=${visit}#motion`,
    });
    await page.waitFor(
      `return document.readyState === "complete" &&
         document.documentElement.dataset.showcaseReady === "true" &&
         !!document.querySelector('[data-motion-cell="check-draw"]');`,
      { timeout: 60_000, what: "motion 分区就绪" },
    );
    await page.evaluate(`await document.fonts.ready; return true;`);
    await sleep(300);
  };
  const reduce = (on) =>
    page.call("Emulation.setEmulatedMedia", {
      features: [
        {
          name: "prefers-reduced-motion",
          value: on ? "reduce" : "no-preference",
        },
      ],
    });

  // 预热：Vite 第一次看到依赖会预构建并整页刷新一次。
  await open("dark");
  await sleep(2000);

  /** 点一格的重放，等 80ms，返回这一格里在跑的位移类 / 无限循环动画。 */
  const replay = async (recipe) =>
    page.evaluate(`
      const collect = (() => { ${COLLECT} })();
      const cell = document.querySelector('[data-motion-cell="${recipe}"]');
      cell.querySelector("button[aria-label]").click();
      await new Promise((done) => setTimeout(done, 80));
      return collect("${recipe}");
    `);

  const RECIPES = [
    "press",
    "pop",
    "indicator",
    "text-swap",
    "number-roll",
    "list-stagger",
    "icon-swap",
    "shake",
    "shimmer",
    "check-draw",
  ];

  /* ---------------------------- 基线：不减少 ---------------------------- */
  await reduce(false);
  await open("dark");
  const baseline = {};
  for (const recipe of RECIPES) baseline[recipe] = await replay(recipe);
  report.baseline = baseline;
  check(
    baseline["list-stagger"].some((animation) => animation.moves),
    "基线：列表错落有位移动画（检测不是空跑）",
    baseline["list-stagger"],
  );
  check(
    baseline.pop.some((animation) => animation.moves),
    "基线：发芽有缩放动画",
    baseline.pop,
  );
  check(
    baseline.shake.some((animation) => animation.moves),
    "基线：shake 有位移动画",
    baseline.shake,
  );
  check(
    baseline.shimmer.some((animation) => animation.infinite),
    "基线：shimmer 是循环",
    baseline.shimmer,
  );
  const probeIndicator = `
    const cell = document.querySelector('[data-motion-cell="indicator"]');
    const tab = [...cell.querySelectorAll("button")].find((node) => node.textContent === "画布");
    tab.click();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await new Promise((done) => setTimeout(done, 40));
    const box = cell.querySelector('[data-slot="indicator"][data-kind="active"]').getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    return { offset: Math.abs(box.left - target.left), left: box.left, target: target.left };
  `;
  const probeNumber = `
    const cell = document.querySelector('[data-motion-cell="number-roll"]');
    const buttons = cell.querySelectorAll("button");
    buttons[buttons.length - 1].click();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return cell.querySelector("[data-numeric]").textContent;
  `;
  await open("dark");
  const slide = await page.evaluate(probeIndicator);
  check(slide.offset > 2, "基线：指示器在平移（40ms 时还没到）", slide);
  await open("dark");
  const rolling = await page.evaluate(probeNumber);
  check(rolling !== "9,031", "基线：数字在滚动（两帧后还不是新值）", rolling);

  /* ---------------------------- 减少动效 ---------------------------- */
  await reduce(true);
  const reduced = {};
  for (const theme of ["dark", "light"]) {
    await open(theme);
    for (const recipe of RECIPES) {
      const running = await replay(recipe);
      reduced[`${theme}:${recipe}`] = running;
      const moving = running.filter((animation) => animation.moves);
      const looping = running.filter((animation) => animation.infinite);
      check(
        moving.length === 0 && looping.length === 0,
        `减少动效 ${theme} · ${recipe}：无位移 / 缩放、无循环`,
        moving.length || looping.length ? { moving, looping } : "",
      );
    }
    await open(theme);
    const metrics = await page.call("Page.getLayoutMetrics");
    const shot = await page.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: 1440,
        height: Math.ceil(metrics.cssContentSize.height),
        scale: 1,
      },
    });
    const file = join(output, `motion-${theme}-1440-reduced-motion.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    report.shots.push(file);
    step(`截图 ${theme}`, file);
  }
  report.reduced = reduced;

  await open("dark");
  const stillSlide = await page.evaluate(probeIndicator);
  check(stillSlide.offset < 1, "减少动效：指示器当拍落到目标位置", stillSlide);
  await open("dark");
  const stillNumber = await page.evaluate(probeNumber);
  check(stillNumber === "9,031", "减少动效：数字当拍就是新值", stillNumber);

  const { errors } = page.drain();
  for (const error of errors) report.console.push(error);
  check(errors.length === 0, "控制台没有 error", errors);
  await reduce(false);
});

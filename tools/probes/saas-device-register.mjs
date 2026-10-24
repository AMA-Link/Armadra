// core 对真实 Armadra 云控制面（Go）的设备码登录与登记到空间（契约 §33.11）。
//
//   node tools/probes/saas-device-register.mjs [输出目录]
//
// 起一次性的 PostgreSQL / Redis / mailpit 容器（随机端口与口令）和本地构建的控制面
// （armadra-cloud 的 `go/cmd/armadra-cloud`，找法见 `cloud-source.mjs`），建一个已验证邮箱、
// 有团队的账号，再跑 `saas-cloud.integration.test.ts`：core 发起设备码、由该账号批准、轮询到
// 就绪、取 `me.spaces`、取注册令牌并经真实的 `CloudRegistry` 登记（`sources.register`、取 JWKS、写登记行）；
// 再对团队成员 B 发授予、合成冲突、改角色、撤销，并按邮箱邀请外人（契约 §33.12）；
// 然后跑 `saas-trust-report.integration.test.ts`：core 的待信任上报器（契约 §31）对真实服务端报
// `trustRequest`（含 `pendingId`）并收尾 `trustResolve`。不起中继节点，隧道是假的，所以不验证隧道。
// 跑完停掉并删除自己起的容器与临时目录。要 Docker 与 Go。产物：<输出目录>/result.json。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NO_CLOUD_HINT, findCloudSource } from "./cloud-source.mjs";
import { root } from "./ui-features/harness.mjs";

const output = resolve(
  process.argv[2] ?? join(root, "target/saas-device-register"),
);
mkdirSync(output, { recursive: true });
const cloudHome = findCloudSource();
if (!cloudHome) {
  console.error(NO_CLOUD_HINT);
  process.exit(2);
}
const load = (path) =>
  import(pathToFileURL(join(cloudHome, "scripts/e2e", path)).href);
const lib = await load("saas-lib.mjs");
const { exec, until } = await load("lib.mjs");
const { freePort } = await load("saas-nodes.mjs");

const IMAGES = {
  postgres: "postgres:17.11-alpine",
  redis: "redis:8.8.3-alpine",
  mailpit: "axllent/mailpit:v1.31.4",
};
// 容器名前缀可改（`PROBE_CONTAINER_PREFIX`），同机并行跑几份时各删各的。
const prefix = process.env.PROBE_CONTAINER_PREFIX ?? "armadra-saas-device";
const tag = randomBytes(4).toString("hex");
const work = mkdtempSync(join(tmpdir(), "armadra-saas-device-"));
const containers = [];
const processes = [];
const result = { status: "failed", steps: [] };
const step = (name) => {
  result.steps.push(name);
  console.log(`  ok  ${name}`);
};

try {
  const ports = {
    pg: await freePort(),
    redis: await freePort(),
    smtp: await freePort(),
    mail: await freePort(),
    cloud: await freePort(),
  };
  const pgPassword = randomBytes(12).toString("hex");
  const base = `http://127.0.0.1:${ports.cloud}`;
  const pgName = `${prefix}-pg-${tag}`;
  const env = {
    ARMADRA_CLOUD_ISSUER: base,
    ARMADRA_CLOUD_APP_ORIGIN: base,
    ARMADRA_CLOUD_LISTEN: `127.0.0.1:${ports.cloud}`,
    ARMADRA_CLOUD_DATABASE_URL: `postgres://armadra:${pgPassword}@127.0.0.1:${ports.pg}/armadra_cloud`,
    ARMADRA_CLOUD_REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
    ARMADRA_CLOUD_MASTER_KEY: randomBytes(32).toString("hex"),
    ARMADRA_CLOUD_RELAY_DOMAIN: "relay.test",
    ARMADRA_CLOUD_TRUSTED_PROXY: "127.0.0.1/32,::1/128",
    ARMADRA_CLOUD_SMTP_HOST: "127.0.0.1",
    ARMADRA_CLOUD_SMTP_PORT: String(ports.smtp),
    ARMADRA_CLOUD_SMTP_TLS: "none",
    ARMADRA_CLOUD_SMTP_FROM: "armadra@probe.test",
    ARMADRA_CLOUD_WEB_ROOT: join(work, "web"),
    ARMADRA_CLOUD_LOG_LEVEL: "info",
  };
  mkdirSync(join(work, "web"));
  writeFileSync(join(work, "web", "index.html"), "<!doctype html>");
  const bin = join(work, "armadra-cloud");
  await exec("go", ["build", "-o", bin, "./cmd/armadra-cloud"], {
    cwd: join(cloudHome, "go"),
  });
  step("构建控制面");

  const launch = async (name, image, map, vars, args) => {
    containers.push(name);
    await lib.startContainer(name, image, map, vars, args);
  };
  await launch(pgName, IMAGES.postgres, [[ports.pg, 5432]], {
    POSTGRES_USER: "armadra",
    POSTGRES_PASSWORD: pgPassword,
    POSTGRES_DB: "armadra_cloud",
  });
  await launch(
    `${prefix}-redis-${tag}`,
    IMAGES.redis,
    [[ports.redis, 6379]],
    {},
    ["redis-server", "--save", "", "--appendonly", "no"],
  );
  await launch(
    `${prefix}-mail-${tag}`,
    IMAGES.mailpit,
    [
      [ports.smtp, 1025],
      [ports.mail, 8025],
    ],
    {},
  );
  await until(
    "PostgreSQL 就绪",
    async () => {
      try {
        await exec("docker", [
          "exec",
          pgName,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "armadra",
          "-d",
          "armadra_cloud",
          "-At",
          "-c",
          "select 1",
        ]);
        return true;
      } catch {
        return false;
      }
    },
    60_000,
    500,
  );
  await until(
    "mailpit 就绪",
    async () =>
      (
        await fetch(`http://127.0.0.1:${ports.mail}/api/v1/info`).catch(() => ({
          ok: false,
        }))
      ).ok,
    30_000,
    200,
  );
  step("一次性容器就绪");

  await lib.runCli(bin, ["migrate"], env);
  const cloud = lib.startProcess("cloud", bin, ["serve"], env);
  processes.push(cloud);
  await until(
    "控制面就绪",
    async () => {
      if (!cloud.running) throw new Error(cloud.logs.join("").slice(-1500));
      try {
        return (await fetch(`${base}/ready`)).ok;
      } catch {
        return false;
      }
    },
    40_000,
    200,
  );
  step("控制面就绪");

  const approver = new lib.Client(base, "A", "bearer");
  await approver.register();
  const mail = lib.mailpit(`http://127.0.0.1:${ports.mail}`);
  const { match } = await mail.link(approver.email, /\/verify#(\S+)/);
  await approver.expectCall(
    "邮箱验证",
    200,
    "",
    "POST",
    "/v1/auth/email/verify",
    {
      body: { token: match[1] },
      anonymous: true,
    },
  );
  const created = await approver.expectCall(
    "建团队",
    200,
    "",
    "POST",
    "/v1/teams",
    {
      body: { slug: `t-${tag}`, name: "研发" },
    },
  );
  const teamId = created.body.teamId;
  step("批准人账号与团队");

  // 团队成员 B：授予与邀请（契约 §33.12）要有人可授。邀请邮件先到，B 之后才注册。
  const member = new lib.Client(base, "B", "bearer");
  await approver.expectCall("邀请成员", 200, "", "POST", "/v1/invitations", {
    body: { kind: "team", teamId, email: member.email, role: "member" },
  });
  const invite = await mail.link(
    member.email,
    /\/invite\/([A-Za-z0-9_-]+)#(\S+)/,
  );
  await member.register();
  const memberMail = await mail.link(member.email, /\/verify#(\S+)/);
  await member.expectCall(
    "成员邮箱验证",
    200,
    "",
    "POST",
    "/v1/auth/email/verify",
    {
      body: { token: memberMail.match[1] },
      anonymous: true,
    },
  );
  await member.expectCall(
    "成员接受邀请",
    200,
    "",
    "POST",
    `/v1/invitations/${invite.match[1]}/accept`,
    { body: { token: invite.match[2] } },
  );
  step("团队成员 B");

  const testEnv = {
    ...process.env,
    SAAS_CLOUD_BASE: base,
    SAAS_APPROVER_TOKEN: approver.access,
    SAAS_APPROVER_PASSWORD: approver.password,
    SAAS_MEMBER_ACCOUNT: member.accountId,
    SAAS_MEMBER_DEVICE: member.deviceId,
    SAAS_MAIL_BASE: `http://127.0.0.1:${ports.mail}`,
  };
  // 逐个文件跑（不并行）：待信任上报的用例会在云端留下与列表相关的状态。
  const runTest = (file) =>
    spawnSync(
      "pnpm",
      ["--filter", "@armadra/desktop", "exec", "vitest", "run", file],
      { cwd: root, env: testEnv, stdio: "inherit" },
    );
  const run = runTest("src/core/sources/saas-cloud.integration.test.ts");
  if (run.status !== 0) throw new Error(`集成测试失败（退出码 ${run.status}）`);
  step("core 设备码登录、空间、注册令牌与登记，授予与邀请（§33.12）");
  const trust = runTest(
    "src/core/sources/saas-trust-report.integration.test.ts",
  );
  if (trust.status !== 0)
    throw new Error(`待信任上报集成测试失败（退出码 ${trust.status}）`);
  step("待信任上报（§31 trustRequest / trustResolve）被真实服务端接受");
  result.status = "ok";
} catch (error) {
  result.error = String(error?.message ?? error);
  console.error(`  FAIL  ${result.error}`);
} finally {
  for (const proc of processes) await proc.stop();
  for (const name of containers) {
    await exec("docker", ["rm", "-f", "-v", name], { allowFail: true });
  }
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
}
process.exit(result.status === "ok" ? 0 : 1);

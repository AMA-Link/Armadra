// armadra-cloud 的本地检出在哪（私有仓，CI 拉不到），以及探针怎么起个人中转。
//
// 检出的顺序：ARMADRA_DEV_STACK_CLOUD_SRC、ARMADRA_PERSONAL_RELAY_HOME，再是仓库旁边的
// `../armadra-cloud`（工作树放在 `worktrees/<仓库>/<用途>/` 下时再往上两层）。认的是带 Go 中继
// 源码的检出：`go/cmd/armadra-relay` 在。
//
// 中继（Go 二进制）按优先级找：
//   1. ARMADRA_RELAY_BIN 指定的二进制；
//   2. 检出里的 `go/bin/armadra-relay`：每次先 `go build`（增量，没改动时很快），找不到 go 时
//      退回已有的二进制并警告；
//   3. 镜像：ARMADRA_PROBE_RELAY_IMAGE，或从检出的 `go/Dockerfile` 构建，
//      `docker run` 起同样的命令行（数据目录等路径原样挂进容器）。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const CLOUD_ENTRY = "go/cmd/armadra-relay";
export const RELAY_BIN = "go/bin/armadra-relay";
export const NO_CLOUD_HINT = `没有 armadra-cloud 的本地检出（${CLOUD_ENTRY}）：设 ARMADRA_DEV_STACK_CLOUD_SRC 或放在仓库旁的 ../armadra-cloud`;

export function findCloudSource(env = process.env, root = ROOT) {
  const candidates = [
    env.ARMADRA_DEV_STACK_CLOUD_SRC,
    env.ARMADRA_PERSONAL_RELAY_HOME,
    resolve(root, "../armadra-cloud"),
    resolve(root, "../../armadra-cloud"),
    resolve(root, "../../../armadra-cloud"),
  ]
    .map((value) => value?.trim())
    .filter(Boolean);
  return (
    candidates.find(
      (directory) =>
        existsSync(join(directory, CLOUD_ENTRY)) &&
        existsSync(join(directory, "go", "go.mod")),
    ) ?? null
  );
}

/** 有没有能用的中继：给了二进制或镜像，或者有检出。 */
export const relayAvailable = (cloudHome, env = process.env) =>
  Boolean(
    cloudHome ||
      env.ARMADRA_RELAY_BIN?.trim() ||
      env.ARMADRA_PROBE_RELAY_IMAGE?.trim(),
  );

export const NO_RELAY_HINT = `${NO_CLOUD_HINT}；或设 ARMADRA_RELAY_BIN（Go 中继二进制）/ ARMADRA_PROBE_RELAY_IMAGE（中继镜像）`;

/**
 * 中继镜像：ARMADRA_PROBE_RELAY_IMAGE 指定就用它，否则从检出 `docker build`
 * （层缓存命中时是秒级）。
 */
export function ensureRelayImage(cloudHome, env = process.env) {
  const given = env.ARMADRA_PROBE_RELAY_IMAGE?.trim();
  if (given) return given;
  if (!cloudHome) throw new Error(NO_RELAY_HINT);
  const tag = "armadra-probe-relay:local";
  const built = spawnSync(
    "docker",
    ["build", "-q", "-f", "go/Dockerfile", "-t", tag, "."],
    { cwd: cloudHome, encoding: "utf8", timeout: 900_000 },
  );
  if (built.status !== 0)
    throw new Error(
      `中继镜像构建失败：${(built.stderr ?? built.error?.message ?? "").slice(-1500)}`,
    );
  return tag;
}

let resolved;

/**
 * 按上面的优先级定下这一次用哪个中继：`{ kind: "bin", path }` 或 `{ kind: "image", image }`。
 * 同一个进程里只定一次。
 */
export function resolveRelay(cloudHome, env = process.env) {
  if (resolved) return resolved;
  const given = env.ARMADRA_RELAY_BIN?.trim();
  if (given) {
    const path = resolve(given);
    if (!existsSync(path))
      throw new Error(`ARMADRA_RELAY_BIN 指向的文件不存在：${path}`);
    return (resolved = { kind: "bin", path });
  }
  if (cloudHome) {
    const path = join(cloudHome, RELAY_BIN);
    // 每次都增量构建，免得用上改源码之前的旧二进制。
    const built = spawnSync(
      "go",
      ["build", "-o", path, "./cmd/armadra-relay"],
      { cwd: join(cloudHome, "go"), encoding: "utf8", timeout: 900_000 },
    );
    if (built.error?.code === "ENOENT") {
      if (existsSync(path)) {
        console.error(
          `找不到 go：沿用已有的 ${path}（可能不是检出现状构建的）`,
        );
        return (resolved = { kind: "bin", path });
      }
      console.error("找不到 go，检出里也没有构建好的中继：改用镜像");
    } else if (built.status === 0 && existsSync(path)) {
      return (resolved = { kind: "bin", path });
    } else {
      throw new Error(
        `go build 中继失败：${(built.stderr ?? built.error?.message ?? "").trim().slice(-1500)}`,
      );
    }
  }
  return (resolved = {
    kind: "image",
    image: ensureRelayImage(cloudHome, env),
  });
}

/** `--name value` 形式的参数取值。 */
const flagValue = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/**
 * 起一次中继命令行（`armadra-relay personal <args>`），答子进程。用镜像时 `docker run --rm`
 * 前台跑同一条命令：参数与 RELAY_*_FILE 里的绝对路径按原路径挂进容器（不存在的先建父目录），
 * serve 一律显式给 `--listen`：Linux 上用宿主网络与当前用户、听 127.0.0.1:<端口>；其余平台听 0.0.0.0、
 * 把 `--port` 发布到 127.0.0.1，`--tls plain` 在那里不支持（直接报错）。
 * 结束子进程时 docker 把信号转给容器。`env` 是子进程的完整环境（缺省 process.env）。
 */
export function spawnRelayCli(
  cloudHome,
  args,
  { env: fullEnv = process.env, stdio } = {},
) {
  const relay = resolveRelay(cloudHome, fullEnv);
  const options = {
    stdio: stdio ?? ["ignore", "pipe", "pipe"],
    env: fullEnv,
  };
  if (relay.kind === "bin")
    return spawn(relay.path, ["personal", ...args], options);

  const relayEnv = Object.keys(fullEnv).filter((name) =>
    name.startsWith("RELAY_"),
  );
  const paths = new Set();
  for (const value of [
    ...args,
    ...relayEnv
      .filter((name) => name.endsWith("_FILE"))
      .map((name) => fullEnv[name]),
  ])
    if (typeof value === "string" && isAbsolute(value)) {
      // 已有的文件或目录原样挂；还没有的（如 init 要建的数据目录）挂它的上一级。
      if (existsSync(value)) paths.add(value);
      else {
        mkdirSync(dirname(value), { recursive: true });
        paths.add(dirname(value));
      }
    }
  const name = `armadra-probe-relay-cli-${randomBytes(4).toString("hex")}`;
  const docker = ["run", "--rm", "--name", name];
  // serve 一律显式给 --listen：Linux 用宿主网络、只听回环；其余平台在容器里听 0.0.0.0，
  // 再只发布到宿主的 127.0.0.1。
  const linux = process.platform === "linux";
  const port = flagValue(args, "--port");
  let command = [...args];
  if (args[0] === "serve" && port) {
    if (!linux && flagValue(args, "--tls") === "plain")
      throw new Error(
        "镜像兜底在这个平台上不支持 --tls plain（明文只许回环，容器里要听 0.0.0.0）：设 ARMADRA_RELAY_BIN 或装好 Go 工具链",
      );
    const listen = `${linux ? "127.0.0.1" : "0.0.0.0"}:${port}`;
    command = command.includes("--listen")
      ? command.map((value, index) =>
          command[index - 1] === "--listen" ? listen : value,
        )
      : [...command, "--listen", listen];
    if (!linux) docker.push("-p", `127.0.0.1:${port}:${port}`);
  }
  if (linux) {
    docker.push("--network", "host");
    if (process.getuid)
      docker.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  for (const path of paths) docker.push("-v", `${path}:${path}`);
  for (const name of relayEnv) docker.push("-e", name);
  docker.push(relay.image, "personal", ...command);
  const child = spawn("docker", docker, options);
  // SIGKILL 转不到容器：docker 客户端一退出就按名字收掉自己起的这一个容器。
  child.once("exit", () =>
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }),
  );
  return child;
}

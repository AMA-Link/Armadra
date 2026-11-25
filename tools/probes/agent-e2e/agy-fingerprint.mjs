import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Antigravity 对用户目录的「零写入」指纹（场景 5 的约定在 ACP 下的对应物）：
 * `~/.gemini` 里属于用户的配置（两处 `settings.json`、`config/` 下的 hook、MCP 与
 * 插件清单）的字节摘要，加上任何名字里带 `armadra` 的条目。agy 自己会写它的对话
 * 库与日志，那些不看；Armadra 只经 `session/new` 与启动旗标工作，所以前后必须相同。
 *
 * 只排除 `antigravity-cli/mcp/armadra/`：ACP 路径上 agy 对交给它的 MCP 服务器
 * （名字是 `armadra`）会自己缓存工具清单与服务器说明，是 agy 写的，Armadra 不写
 * 也不清理。`mcp/` 里别的条目（含名字带 armadra 的）仍照常比对。
 */
/** agy 自己为 `armadra` 这个 MCP 服务器写的缓存目录。 */
function agyOwnCache(directory, name) {
  return name === "armadra" && /antigravity-cli[\\/]mcp$/.test(directory);
}

export function geminiFingerprint(home = homedir()) {
  const gemini = join(home, ".gemini");
  const digest = (path) => {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return null;
    }
  };
  const listing = (path) => {
    try {
      return readdirSync(path).sort();
    } catch {
      return null;
    }
  };
  const named = [];
  const walk = (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (/armadra/i.test(entry.name) && !agyOwnCache(directory, entry.name))
        named.push(join(directory, entry.name));
      // 对话与产物目录很大，也不是我们要看的东西。
      if (
        entry.isDirectory() &&
        !["conversations", "brain", "log", "cache", "implicit"].includes(
          entry.name,
        )
      )
        walk(join(directory, entry.name), depth + 1);
    }
  };
  walk(gemini, 0);
  return {
    settings: digest(join(gemini, "settings.json")),
    cliSettings: digest(join(gemini, "antigravity-cli", "settings.json")),
    mcpConfig: digest(join(gemini, "config", "mcp_config.json")),
    hooks: digest(join(gemini, "config", "hooks.json")),
    plugins: listing(join(gemini, "config", "plugins")),
    armadraNamed: named.sort(),
  };
}

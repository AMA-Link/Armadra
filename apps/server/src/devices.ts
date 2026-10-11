/**
 * `armadra-server devices …`：服务器壳没有界面，经中继端到端通道来的新设备由主人
 * 在这里核对校验码（契约 §77）。对**运行中**的服务器壳操作，取本机会话的方式与
 * `cloud` 子命令相同（`cloud.ts::defaultDeps().connect`）。
 *
 *   devices list
 *   devices approve <pendingId> --sas 482913
 *   devices reject <pendingId>
 *   devices revoke <deviceId> --principal <principalId>
 */

import { single } from "./cli";
import { type CloudDeps, CloudCliError } from "./cloud";

type Values = ReadonlyMap<string, readonly string[]>;
type Emit = (document: unknown, text: () => string) => void;

interface DeviceRow {
  readonly deviceId: string;
  readonly principalId: string;
  readonly principalName: string;
  readonly label: string;
  readonly platform: string;
  readonly status: string;
  readonly pendingId: string | null;
  readonly fingerprint: string;
}

const USAGE =
  "用法: armadra-server devices list | approve <pendingId> --sas <6 位> | reject <pendingId> | revoke <deviceId> --principal <principalId>";

function usage(message: string = USAGE): never {
  throw new CloudCliError("usage", message, true);
}

function argument(positionals: readonly string[], index: number): string {
  const value = positionals[index]?.trim() ?? "";
  if (value === "") usage();
  return value;
}

/** 指纹分组显示前 16 位（与界面一致）。 */
function shortFingerprint(fingerprint: string): string {
  return (fingerprint.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

function line(row: DeviceRow): string {
  const pending = row.pendingId === null ? "" : `  待确认 ${row.pendingId}`;
  return `${row.status.padEnd(8)} ${row.label || "-"} · ${row.platform || "-"} · ${row.principalName || row.principalId} · ${shortFingerprint(row.fingerprint)}${pending}`;
}

export async function runDevices(
  positionals: readonly string[],
  values: Values,
  dataDir: string,
  deps: Pick<CloudDeps, "connect">,
  emit: Emit,
): Promise<void> {
  const action = positionals[0];
  if (action === "list") {
    const core = await deps.connect(dataDir);
    const answer = (await core.call("GET", "/api/devices")) as {
      devices: DeviceRow[];
    };
    emit({ command: "devices list", devices: answer.devices }, () =>
      answer.devices.length === 0
        ? "没有设备"
        : answer.devices.map(line).join("\n"),
    );
    return;
  }
  if (action === "approve") {
    const pendingId = argument(positionals, 1);
    const sas = (single(values, "--sas") ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(sas)) usage("--sas 必须是新设备屏幕上的 6 位数字");
    const core = await deps.connect(dataDir);
    const answer = (await core.call("POST", "/api/devices/approve", {
      pendingId,
      sas,
    })) as { device: DeviceRow };
    emit(
      { command: "devices approve", device: answer.device },
      () => `已允许 ${answer.device.label || answer.device.deviceId}`,
    );
    return;
  }
  if (action === "reject") {
    const pendingId = argument(positionals, 1);
    const core = await deps.connect(dataDir);
    await core.call("POST", "/api/devices/reject", { pendingId });
    emit({ command: "devices reject", pendingId }, () => "已拒绝");
    return;
  }
  if (action === "revoke") {
    const deviceId = argument(positionals, 1);
    const principalId = single(values, "--principal")?.trim() ?? "";
    if (principalId === "") usage("revoke 需要 --principal <principalId>");
    const core = await deps.connect(dataDir);
    await core.call("POST", "/api/devices/revoke", { deviceId, principalId });
    emit({ command: "devices revoke", deviceId, principalId }, () => "已撤销");
    return;
  }
  usage();
}

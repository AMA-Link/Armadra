import { ACCESS_TTL_MS } from "./service";

/**
 * 只给测试的访问密钥寿命（#706）：core 认 `ARMADRA_TEST_ACCESS_TTL_MS`，把 15 分钟的访问期
 * 调短，端到端验「页面跨几个访问期一直在同一条会话上轮转」用。两种壳都听它。
 *
 * 只认 `[1 分钟, 15 分钟]` 之间的整数毫秒：只能调短、不能调长。设了却不在这个范围（或不是
 * 整数）就抛错，core 起不来——不悄悄退回缺省。
 */
export const TEST_ACCESS_TTL_ENV = "ARMADRA_TEST_ACCESS_TTL_MS";
export const MIN_TEST_ACCESS_TTL_MS = 60 * 1000;

export function testAccessTtl(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[TEST_ACCESS_TTL_ENV]?.trim() ?? "";
  if (raw === "") return undefined;
  const value = /^\d{1,12}$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TEST_ACCESS_TTL_MS ||
    value > ACCESS_TTL_MS
  )
    throw new Error(
      `${TEST_ACCESS_TTL_ENV} 要在 ${MIN_TEST_ACCESS_TTL_MS}–${ACCESS_TTL_MS} 毫秒之间`,
    );
  return value;
}

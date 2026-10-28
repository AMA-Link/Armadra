/**
 * 只给测试的 SaaS 会话寿命（设计 Q9）：服务器壳认 `ARMADRA_TEST_SAAS_SESSION_TTL_MS`，
 * 把 Armadra 云来源会话的一小时寿命调短，端到端验「跨寿命续期不断」用。桌面壳不听它。
 *
 * 只认正整数毫秒；认不出的当没设（缺省一小时）。下限 5 分钟由 `CloudLogin` 的
 * 构造校验保证：设得更短 core 起不来，而不是悄悄放宽。
 */
export const TEST_SAAS_SESSION_TTL_ENV = "ARMADRA_TEST_SAAS_SESSION_TTL_MS";

export function testSaasSessionTtl(
  shell: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (shell !== "server") return undefined;
  const raw = env[TEST_SAAS_SESSION_TTL_ENV]?.trim() ?? "";
  if (!/^\d{1,12}$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}

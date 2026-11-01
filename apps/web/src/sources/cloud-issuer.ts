import { resolveCloudIssuer } from "@armadra/shared";

/**
 * 网页与手机用的 Armadra 云地址：默认 `ARMADRA_CLOUD_ISSUER`，开发与测试可在构建时用
 * `VITE_ARMADRA_CLOUD_ISSUER` 覆盖（只收 https，回环另收 http，其余忽略）。
 */
export function cloudIssuer(): string {
  return resolveCloudIssuer(
    import.meta.env.VITE_ARMADRA_CLOUD_ISSUER as string | undefined,
  );
}

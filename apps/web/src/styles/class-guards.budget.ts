/**
 * 样式守卫的存量登记：规则 id → 文件 → 现有个数（`class-guards.test.ts` 说明用法）。
 * 只减不增；批次 3 已归零，表保持空，新增违规直接失败。
 */
export const LEGACY_BUDGET: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  "rounded-bare": {},
  "rounded-scale": {},
  "rounded-arbitrary": {},
  shadow: {},
  "control-height": {},
  "row-height": {},
  "var-class": {},
  "transition-all": {},
  duration: {},
  ease: {},
  "cubic-bezier": {},
  "stroke-width": {},
  "sonner-import": {},
  "text-px": {},
  "text-length-var": {},
  "text-scale": {},
};

/**
 * 破坏性确认按钮（结束会话、删除画布）的样式：危险色实底配白字。
 *
 * 默认的 `AlertDialogAction` 是品牌蓝实底，会把「删除」画成主操作；
 * shadcn 的 `destructive` 变体是浅底红字，放在确认框里分量不够。
 * `--danger-solid` 在两套主题下配白字都 ≥ 4.5:1（`styles/tokens.test.ts`）。
 *
 * 带 `!`：`AlertDialogAction` 经 `Button asChild` 把两份类名拼在一起而不去重，
 * 不加的话谁赢取决于生成顺序，实测是 `bg-primary` 赢。
 */
/**
 * @deprecated 用 `<AlertDialogAction variant="destructive-solid">`（设计系统 §3.1）。
 * 还在用它的两处（`sidebar/BoardRow`、`canvas/FlowWorkspace`）归侧栏包与画布包迁走，
 * 迁完后删除本文件。
 */
export const DANGER_ACTION_CLASS =
  "bg-danger-solid! text-white! hover:bg-danger-solid/90!";

/**
 * 时间线条目的版式（设计系统 §5.1）：一个回合里的条目上下排开，全部共用同一条
 * 左缘与同一档内边距。
 *
 *   * 卡片条目（工具、命令、思考、活动组）：1px 边框，标题行是整行的折叠按钮，
 *     展开的内容在卡片里、标题行下面，不再缩进；
 *   * 文字条目（提问、助手正文、计划摘要）：同样的 1px 边框位（透明或有底色）
 *     与内边距，文字左缘与卡片里的图标、内容对齐；
 *   * 嵌在卡片里的条目（活动组的成员、子代理的内部调用）：没有自己的边框，
 *     标题行与内容的左缘仍是同一条。
 *
 * 宽度一律跟着节点走，没有写死的最大宽度。
 */

/** 所有条目共用的左右内边距。 */
export const ENTRY_INSET = "px-2.5";

/** 卡片条目的外框。 */
export const ENTRY_FRAME =
  "min-w-0 overflow-hidden rounded-control border border-border bg-card";

/** 文字条目：占着与卡片相同的边框位，左缘才对得齐。 */
export const ENTRY_TEXT = "min-w-0 border border-transparent px-2.5";

/**
 * 卡片的标题行（折叠按钮，`Button size=sm` 28 高）：整行宽、左缘与内容一致。按钮自带 1px 透明边框（聚焦时
 * 换色），内边距扣掉这 1px。
 */
export const ENTRY_TRIGGER =
  "w-full min-w-0 justify-start gap-1.5 rounded-none px-[calc(--spacing(2.5)-1px)] font-normal aria-expanded:bg-transparent aria-expanded:hover:bg-hover disabled:opacity-100";

/** 卡片展开的内容：标题行下一条分隔线，内容与标题同一左缘。 */
export const ENTRY_BODY =
  "flex min-w-0 flex-col gap-1.5 border-t border-border px-2.5 py-2";

/** 嵌在卡片里的条目展开的内容：没有分隔线，只有内边距。 */
export const ENTRY_NESTED_BODY = "flex min-w-0 flex-col gap-1.5 px-2.5 pb-2";

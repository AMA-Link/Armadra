import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  beginGesture,
  commitItemText,
  discardItem,
  endGesture,
  updateItem,
} from "../store";

/**
 * 就地文字编辑（React Flow 计划 F23 / F24，归属 whiteboard）。
 *
 * 文字对象的正文与几何形的标签是同一件事，所以共用这一个组件：双击进入
 * 编辑，Esc 或失焦提交；文字对象提交时是空的就整条丢弃。
 *
 * 三条必须成立的规则：
 *
 *  1. 编辑区带 `nodrag` / `nowheel`：否则在里面按住选词会把整个对象拖走，
 *     滚轮会缩放画布。
 *  2. 键盘事件在这里 `stopPropagation`：`keybindings.ts` 的守卫认的是
 *     `textarea`，但 Esc 与 Delete 走的是别的路，拦在源头最稳。
 *  3. 整段编辑只形成**一条**历史：进入时 `beginGesture`，提交时
 *     `endGesture`（§2.7 的 coalesce）。
 */

export interface InlineTextProps {
  itemId: string;
  text: string;
  /** 写回哪个字段：文字对象是 `text`，几何形是 `label`。 */
  field: "text" | "label";
  color: string;
  fontSize: number;
  align?: "left" | "center" | "right";
  /** 空文本时不占位（几何形没有标签就该是干净的形状）。 */
  placeholderHidden?: boolean;
  /** 建好就直接进编辑（文字工具点一下画布）。 */
  autoEdit?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

export function InlineText({
  itemId,
  text,
  field,
  color,
  fontSize,
  align = "left",
  placeholderHidden = false,
  autoEdit = false,
  onEditingChange,
}: InlineTextProps) {
  const t = useT();
  const [editing, setEditing] = React.useState(autoEdit);
  const [draft, setDraft] = React.useState(text);
  const textarea = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (!editing) setDraft(text);
  }, [editing, text]);

  React.useEffect(() => {
    onEditingChange?.(editing);
    if (!editing) return;
    beginGesture("whiteboard.text");
    const element = textarea.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
    return () => endGesture();
  }, [editing, onEditingChange]);

  const commit = React.useCallback(() => {
    setEditing(false);
    // 文字对象空着提交 = 不要这条对象（#714）：双击空白 / 文字工具先建后填，
    // 没填就走，画布上不该留下一条看不见的空文字。几何形的标签为空是常态，
    // 形状本身要留着，所以只管 `text` 字段。
    if (field === "text" && draft.trim() === "") {
      discardItem(itemId);
      return;
    }
    if (draft === text) return;
    if (field === "text") commitItemText(itemId, { text: draft } as never);
    else updateItem(itemId, { [field]: draft } as never);
  }, [draft, field, itemId, text]);

  const style: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent:
      align === "center"
        ? "center"
        : align === "right"
          ? "flex-end"
          : "flex-start",
    padding: 4,
    color,
    fontSize,
    lineHeight: 1.35,
    fontFamily: "var(--font-ui)",
    textAlign: align,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflow: "hidden",
  };

  if (!editing) {
    if (!text && placeholderHidden) {
      return <div style={style} onDoubleClick={() => setEditing(true)} />;
    }
    return (
      <div style={style} onDoubleClick={() => setEditing(true)}>
        {text}
      </div>
    );
  }

  return (
    // ui-exempt: 画布行内编辑——字号、颜色跟随画布对象的样式，不用 ui/textarea 的表单外观
    // eslint-disable-next-line no-restricted-syntax -- 同上：行内编辑的外观跟画布对象走，不是表单控件
    <textarea
      ref={textarea}
      aria-label={t("tool.text")}
      className="nodrag nowheel"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          commit();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        ...style,
        display: "block",
        alignItems: undefined,
        justifyContent: undefined,
        background: "transparent",
        border: "none",
        outline: "none",
        resize: "none",
      }}
    />
  );
}

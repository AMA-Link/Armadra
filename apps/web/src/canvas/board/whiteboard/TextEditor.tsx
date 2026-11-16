import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import { useBoard } from "@armadra/board/react";

import { useT } from "@/app/preferences-store";
import { canvasScheme } from "../../whiteboard/scheme";
import type { Item } from "../../whiteboard/model";
import { colorHex, fontSize } from "../../whiteboard/palette";
import {
  beginGesture,
  commitItemText,
  discardItem,
  endGesture,
  updateItem,
} from "../../whiteboard/store";
import { useBoardTick } from "./ItemSelection";
import {
  fontFamily,
  layoutFor,
  MIN_TEXT_HEIGHT,
  TEXT_LINE,
  TEXT_PAD,
} from "./text";
import {
  getEditing,
  setEditing,
  subscribeEditing,
  type TextEditing,
} from "./text-edit";

/**
 * 白板文字 / 形状标签的就地编辑（设计 §8 Q6：Canvas 绘制 + 编辑时覆盖 `<textarea>`）。
 *
 * 覆盖层的字号、内边距、行高、折行宽度与 `paint` 用的是同一组数（乘相机缩放），
 * 所以编辑前后文字不跳。提交规则与 React Flow 版的 `InlineText` 一致：
 * 文字对象空着提交就整条丢弃（连同撤销记录），整段编辑只形成一条历史。
 */

export function TextEditor() {
  const editing = React.useSyncExternalStore(
    subscribeEditing,
    getEditing,
    () => null,
  );
  return editing ? (
    <EditArea key={`${editing.id}:${editing.field}`} editing={editing} />
  ) : null;
}

function EditArea({ editing }: { editing: TextEditing }) {
  const t = useT();
  const board = useBoard<CanvasNode>();
  useBoardTick(board);
  const entity = board.scene.get(editing.id);
  const item = entity?.data as unknown as Item | undefined;
  const initial =
    item?.kind === "text"
      ? item.text
      : item?.kind === "shape"
        ? (item.label ?? "")
        : "";
  const [draft, setDraft] = React.useState(initial);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const done = React.useRef(false);

  React.useEffect(() => {
    beginGesture("whiteboard.text");
    const element = area.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
    return () => endGesture();
  }, []);

  const commit = React.useCallback(() => {
    if (done.current) return;
    done.current = true;
    setEditing(null);
    if (!item) return;
    // 文字对象空着提交 = 不要这条对象；形状标签为空是常态，形状留着。
    if (editing.field === "text" && draft.trim() === "") {
      discardItem(item.id);
      return;
    }
    if (draft === initial) return;
    if (editing.field === "text") {
      commitItemText(item.id, { text: draft } as never);
    } else {
      updateItem(item.id, { label: draft } as never);
    }
  }, [draft, editing.field, initial, item]);

  const box = entity && board.scene.bounds(editing.id);
  if (!entity || !box || !item) return null;
  const { x, y, zoom } = board.camera.get();
  const size = fontSize(item.style.size);
  const label = editing.field === "label";
  const { lines } = layoutFor({}, draft || " ", box.w, size);
  const height = Math.max(
    MIN_TEXT_HEIGHT,
    Math.ceil(lines.length * size * TEXT_LINE) + TEXT_PAD * 2,
  );
  const top = label ? box.y + (box.h - height) / 2 : box.y;
  const align = label ? "middle" : (item.style.align ?? "start");

  return (
    // ui-exempt: 画布行内编辑——字号、颜色跟随画布对象的样式，不用 ui/textarea 的表单外观
    // eslint-disable-next-line no-restricted-syntax -- 同上：行内编辑的外观跟画布对象走，不是表单控件
    <textarea
      ref={area}
      aria-label={t("tool.text")}
      data-board-editable=""
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
        position: "absolute",
        left: box.x * zoom + x,
        top: top * zoom + y,
        width: box.w * zoom,
        height: height * zoom,
        boxSizing: "border-box",
        padding: TEXT_PAD * zoom,
        margin: 0,
        border: "none",
        outline: "none",
        resize: "none",
        overflow: "hidden",
        background: "transparent",
        pointerEvents: "auto",
        color: colorHex(item.style.color, canvasScheme()),
        fontSize: size * zoom,
        lineHeight: TEXT_LINE,
        fontFamily: fontFamily(),
        textAlign:
          align === "middle" ? "center" : align === "end" ? "right" : "left",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    />
  );
}

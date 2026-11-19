import {
  type CanvasNode,
  isPresetTitle,
  presetNodeName,
} from "@armadra/shared";
import {
  defaultNodeColor,
  defaultNodeData,
  defaultNodeTitle,
  newNodeSize,
} from "../defaults";
import {
  boundFrameFor,
  enclosingBoundFrame,
  frameBindingOf,
  inheritedNodeData,
} from "../../canvas/frame-binding";
import { normaliseLabels } from "../../meta/model";
import { absolutePosition, commit, now } from "./internal";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";
import { deferWriteBack, shouldDeferWriteBack } from "./writeback";

export function createNodesSlice(
  set: CanvasSet,
  get: CanvasGet,
): Pick<
  CanvasStore,
  | "addNode"
  | "duplicateNodes"
  | "removeNodes"
  | "setNodeLabels"
  | "setNodeNote"
  | "setParent"
  | "updateNode"
  | "updateNodeData"
> {
  return {
    addNode: (type, options = {}) => {
      const state = get();
      if (!state.document) return "";
      // 显式 id 撞上已有节点就什么都不做：静默覆盖会把另一个节点的内容顶掉。
      if (
        options.id &&
        state.document.nodes.some((node) => node.id === options.id)
      ) {
        return "";
      }
      const id = options.id ?? crypto.randomUUID();
      const stamp = now();
      const index = state.document.nodes.length;
      const base = defaultNodeData(type, {
        workspaceRoot: state.workspace?.rootPath,
      });
      /**
       * 在绑定了 worktree 的分组里新建的节点开在那个 checkout 里（G03）。
       *
       * 优先看 `parentId`；右键新建只给 `position`，那就看落点落在哪个绑定分组
       * 里。调用方显式给的 `data` 仍然压在最上面——「打开这个文件」不该被
       * 分组的目录顶掉。
       */
      const frame =
        boundFrameFor(state.document.nodes, options.parentId) ??
        enclosingBoundFrame(state.document.nodes, options.position);
      const inherited = inheritedNodeData(type, frameBindingOf(frame), {
        workspaceRoot: state.workspace?.rootPath,
      });
      // 终端 / Agent 没给标题：起一个预设名，同时当名字（Armadra#969）。
      // 类型由节点头的类型标记说，不再塞进标题。
      const preset =
        type === "terminal" &&
        options.title === undefined &&
        (options.data as { handle?: unknown } | undefined)?.handle === undefined
          ? presetNodeName(state.document.nodes)
          : undefined;
      const node = {
        id,
        boardId: state.document.board.id,
        type,
        title: options.title ?? preset?.title ?? defaultNodeTitle(type),
        color: options.color ?? defaultNodeColor(type),
        position: options.position ?? {
          x: 80 + index * 24,
          y: 80 + index * 24,
        },
        size: options.size ?? newNodeSize(type),
        ...(options.parentId ? { parentId: options.parentId } : {}),
        labels: [],
        note: "",
        data: {
          ...base,
          ...inherited,
          ...options.data,
          ...(preset === undefined ? {} : { handle: preset.handle }),
          kind: type,
        },
        createdAt: stamp,
        updatedAt: stamp,
      } as CanvasNode;

      const patch = commit(state, (document) => ({
        ...document,
        nodes: [...document.nodes, node],
      }));
      if (!patch) return "";
      const select = options.select ?? true;
      set({ ...patch, ...(select ? { selectedNodeIds: [id] } : {}) });
      return id;
    },

    updateNode: (id, patch) => {
      set((state) => {
        const next = commit(state, (document) => {
          let changed = false;
          const nodes = document.nodes.map((node) => {
            if (node.id !== id) return node;
            changed = true;
            return { ...node, ...patch, updatedAt: now() } as CanvasNode;
          });
          return changed ? { ...document, nodes } : null;
        });
        return next ?? state;
      });
    },

    updateNodeData: (id, patch, options) => {
      // 实时板放行写入之前，系统写回不丢：排着，放行后补写（`writeback.ts`）。
      // 用户编辑不走这条，仍然是只读时不落。
      const current = get();
      if (
        options?.history === "ignore" &&
        current.document &&
        shouldDeferWriteBack(current)
      ) {
        if (current.document.nodes.some((node) => node.id === id)) {
          deferWriteBack(current.boardId ?? "", id, patch);
        }
        return;
      }
      set((state) => {
        const next = commit(
          state,
          (document) => {
            let changed = false;
            const nodes = document.nodes.map((node) => {
              if (node.id !== id) return node;
              changed = true;
              return {
                ...node,
                data: { ...node.data, ...patch, kind: node.data.kind },
                updatedAt: now(),
              } as CanvasNode;
            });
            return changed ? { ...document, nodes } : null;
          },
          options,
        );
        return next ?? state;
      });
    },

    // 标签与批注不是画布的结构性改动，但要置 dirty，跟着画布文档一起保存。
    setNodeLabels: (id, labels) => {
      const next = normaliseLabels(labels);
      set((state) => {
        const patch = commit(state, (document) => {
          let changed = false;
          const nodes = document.nodes.map((node) => {
            if (node.id !== id) return node;
            const current = node.labels ?? [];
            if (
              current.length === next.length &&
              current.every((label, index) => label === next[index])
            ) {
              return node;
            }
            changed = true;
            return { ...node, labels: next, updatedAt: now() } as CanvasNode;
          });
          return changed ? { ...document, nodes } : null;
        });
        return patch ?? state;
      });
    },

    setNodeNote: (id, note) => {
      set((state) => {
        const patch = commit(state, (document) => {
          let changed = false;
          const nodes = document.nodes.map((node) => {
            if (node.id !== id) return node;
            if ((node.note ?? "") === note) return node;
            changed = true;
            return { ...node, note, updatedAt: now() } as CanvasNode;
          });
          return changed ? { ...document, nodes } : null;
        });
        return patch ?? state;
      });
    },
    setParent: (ids, parentId) => {
      set((state) => {
        const targets = new Set(ids);
        targets.delete(parentId ?? "");
        if (targets.size === 0) return state;
        const patch = commit(state, (document) => {
          const parent = parentId
            ? document.nodes.find((node) => node.id === parentId)
            : null;
          if (parentId && (!parent || parent.type !== "group")) return null;
          const parentOrigin = parent
            ? absolutePosition(document.nodes, parent)
            : { x: 0, y: 0 };
          let changed = false;
          const nodes = document.nodes.map((node) => {
            if (!targets.has(node.id)) return node;
            // 组不能进组：一层父子关系已经够用，嵌套组会让裁剪计算失控
            if (node.type === "group" && parentId) return node;
            if ((node.parentId ?? null) === parentId) return node;
            const absolute = absolutePosition(document.nodes, node);
            changed = true;
            return {
              ...node,
              parentId: parentId ?? undefined,
              position: parentId
                ? {
                    x: absolute.x - parentOrigin.x,
                    y: absolute.y - parentOrigin.y,
                  }
                : absolute,
              updatedAt: now(),
            };
          });
          return changed ? { ...document, nodes } : null;
        });
        return patch ?? state;
      });
    },

    removeNodes: (ids) => {
      set((state) => {
        const doomed = new Set(ids);
        if (doomed.size === 0) return state;
        const patch = commit(state, (document) => {
          if (!document.nodes.some((node) => doomed.has(node.id))) return null;
          // 删组不删组员：先把孩子解组并换回绝对坐标，再删组本身。
          const orphaned = document.nodes.map((node) => {
            if (doomed.has(node.id)) return node;
            if (!node.parentId || !doomed.has(node.parentId)) return node;
            return {
              ...node,
              parentId: undefined,
              position: absolutePosition(document.nodes, node),
              updatedAt: now(),
            };
          });
          return {
            ...document,
            nodes: orphaned.filter((node) => !doomed.has(node.id)),
            edges: document.edges.filter(
              (edge) => !doomed.has(edge.source) && !doomed.has(edge.target),
            ),
          };
        });
        if (!patch) return state;
        const maximized = Object.fromEntries(
          Object.entries(state.maximized).filter(([id]) => !doomed.has(id)),
        );
        return {
          ...patch,
          maximized,
          selectedNodeIds: state.selectedNodeIds.filter(
            (id) => !doomed.has(id),
          ),
          focusNodeId:
            state.focusNodeId && doomed.has(state.focusNodeId)
              ? null
              : state.focusNodeId,
        };
      });
    },

    duplicateNodes: (ids) => {
      const state = get();
      if (!state.document) return [];
      const sources = state.document.nodes.filter((node) =>
        ids.includes(node.id),
      );
      if (sources.length === 0) return [];
      const stamp = now();
      const placed: CanvasNode[] = [...state.document.nodes];
      const copies = sources.map((source) => {
        const copy = {
          ...source,
          id: crypto.randomUUID(),
          position: { x: source.position.x + 32, y: source.position.y + 32 },
          data: structuredClone(source.data),
          createdAt: stamp,
          updatedAt: stamp,
        } as CanvasNode;
        // 副本绝不继承活着的会话句柄，否则两个节点会抢同一个 PTY。
        if (copy.data.kind === "terminal") {
          const { sessionId: _session, agent, ...rest } = copy.data;
          copy.data = {
            ...rest,
            ...(agent ? { agent: { ...agent, sessionId: undefined } } : {}),
          };
        }
        // 名字在一块画布内唯一（agent-delivery §2）：副本不带走原件的名字。
        // 原件还顶着预设名时，副本另取一个预设名（Armadra#969）。
        const handle = (copy.data as { handle?: unknown }).handle;
        if (typeof handle === "string") {
          const { handle: _handle, ...data } = copy.data as typeof copy.data & {
            handle?: string;
          };
          copy.data = data as CanvasNode["data"];
          if (isPresetTitle(source.title, handle)) {
            const preset = presetNodeName(placed);
            copy.title = preset.title;
            copy.data = {
              ...copy.data,
              handle: preset.handle,
            } as CanvasNode["data"];
          }
        }
        placed.push(copy);
        return copy;
      });
      const patch = commit(state, (document) => ({
        ...document,
        nodes: [...document.nodes, ...copies],
      }));
      if (!patch) return [];
      set({ ...patch, selectedNodeIds: copies.map((copy) => copy.id) });
      return copies.map((copy) => copy.id);
    },
  };
}

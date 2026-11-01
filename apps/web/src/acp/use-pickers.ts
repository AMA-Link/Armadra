import * as React from "react";
import {
  permissionModeOfAcpMode,
  type AcpModeState,
  type AcpModelState,
  type TerminalAgent,
  type TimelineHead,
} from "@armadra/shared";

import { customAgentFor } from "@/agent/launch";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { toast } from "@/ui/toast";
import { acpApi } from "./api";
import {
  DEFAULT_MODEL_ID,
  candidateModels,
  candidateModes,
  pickModels,
  pickModes,
} from "./pickers";

/**
 * 提示框的模式与模型选择（#685）：新建会话后就有得选。
 *
 * 目录取 Agent 在头部报回的；还没报时用候选（`pickers.ts`）。会话起来之前、或起来了
 * 但目录还没到时的选择先记着，目录一到就 `setMode` / `setModel` 落上，Agent 的目录里
 * 没有它就放弃（以 Agent 为准）。选择落上后写回节点数据（`agent.permissionMode` /
 * `agent.model`），下次起会话沿用；与会话 id 一样不是画布编辑，不进撤销栈。
 */
export function useAcpPickers({
  nodeId,
  sessionId,
  agent,
  head,
}: {
  nodeId: string;
  sessionId: string | null;
  agent: TerminalAgent | undefined;
  head: TimelineHead;
}): {
  modes: AcpModeState | null;
  models: AcpModelState;
  selectMode: (modeId: string) => void;
  selectModel: (modelId: string) => void;
} {
  const t = useT();
  const baseAgent = agent
    ? (customAgentFor(agent.id)?.baseAgent ?? agent.id)
    : "";
  const nodeMode = agent?.permissionMode;
  const nodeModel = agent?.model;
  const candidateMode = React.useMemo(
    () =>
      candidateModes(baseAgent, nodeMode, (mode) => t(`agent.mode.${mode}`)),
    [baseAgent, nodeMode, t],
  );
  const candidateModel = React.useMemo(
    () => candidateModels(baseAgent, nodeModel, t("acp.prompt.modelDefault")),
    [baseAgent, nodeModel, t],
  );

  // 显示用的选择（回执到之前先改一下）与还没落上的选择（会话或目录没到）。
  const [modeChoice, setModeChoice] = React.useState<string | null>(null);
  const [modelChoice, setModelChoice] = React.useState<string | null>(null);
  const [pendingMode, setPendingMode] = React.useState<string | null>(null);
  const [pendingModel, setPendingModel] = React.useState<string | null>(null);
  const reportedModes = head.modes ?? null;
  const reportedModels = head.models ?? null;
  // 必须排在下面两个落上选择的 effect 之前：同一次提交里先清再落。
  React.useEffect(() => setModeChoice(null), [reportedModes?.currentModeId]);
  React.useEffect(() => setModelChoice(null), [reportedModels?.currentModelId]);

  const writeBack = React.useCallback(
    (patch: Partial<TerminalAgent>) => {
      const canvas = useCanvasStore.getState();
      const node = canvas.document?.nodes.find((n) => n.id === nodeId);
      if (node?.data.kind !== "terminal" || !node.data.agent) return;
      canvas.updateNodeData(
        nodeId,
        { agent: { ...node.data.agent, ...patch } },
        { history: "ignore" },
      );
    },
    [nodeId],
  );

  const applyMode = React.useCallback(
    (id: string, modeId: string) => {
      setModeChoice(modeId);
      acpApi
        .setMode(id, modeId)
        .then(() => {
          const permissionMode = permissionModeOfAcpMode(baseAgent, modeId);
          if (permissionMode !== undefined) writeBack({ permissionMode });
        })
        .catch(() => {
          setModeChoice(null);
          toast.error(t("acp.prompt.modeFailed"));
        });
    },
    [baseAgent, writeBack, t],
  );

  const applyModel = React.useCallback(
    (id: string, modelId: string) => {
      setModelChoice(modelId);
      acpApi
        .setModel(id, modelId)
        .then(() => writeBack({ model: modelId }))
        .catch(() => {
          setModelChoice(null);
          toast.error(t("acp.prompt.modelFailed"));
        });
    },
    [writeBack, t],
  );

  React.useEffect(() => {
    if (sessionId === null || reportedModes === null || pendingMode === null) {
      return;
    }
    setPendingMode(null);
    const known = reportedModes.availableModes.some(
      (m) => m.id === pendingMode,
    );
    if (known && pendingMode !== reportedModes.currentModeId) {
      applyMode(sessionId, pendingMode);
    } else {
      setModeChoice(null);
    }
  }, [sessionId, reportedModes, pendingMode, applyMode]);

  React.useEffect(() => {
    if (
      sessionId === null ||
      reportedModels === null ||
      pendingModel === null
    ) {
      return;
    }
    setPendingModel(null);
    const known = reportedModels.availableModels.some(
      (m) => m.modelId === pendingModel,
    );
    if (known && pendingModel !== reportedModels.currentModelId) {
      applyModel(sessionId, pendingModel);
    } else {
      setModelChoice(null);
    }
  }, [sessionId, reportedModels, pendingModel, applyModel]);

  const selectMode = React.useCallback(
    (modeId: string) => {
      if (sessionId !== null && reportedModes !== null) {
        applyMode(sessionId, modeId);
        return;
      }
      setModeChoice(modeId);
      setPendingMode(modeId);
    },
    [sessionId, reportedModes, applyMode],
  );

  const selectModel = React.useCallback(
    (modelId: string) => {
      if (sessionId !== null && reportedModels !== null) {
        applyModel(sessionId, modelId);
        return;
      }
      setModelChoice(modelId);
      // 「默认」是占位，不是 Agent 的模型：没有什么可落的。
      setPendingModel(modelId === DEFAULT_MODEL_ID ? null : modelId);
    },
    [sessionId, reportedModels, applyModel],
  );

  return {
    modes: pickModes(reportedModes, candidateMode, modeChoice),
    models: pickModels(reportedModels, candidateModel, modelChoice),
    selectMode,
    selectModel,
  };
}

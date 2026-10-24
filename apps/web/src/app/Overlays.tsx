import { Suspense } from "react";
import { OverlaySuspense, type OverlayShape } from "./OverlayFallback";
import { DeviceApprovalPrompt } from "../panels/settings/pages/security/E2eDevices";

import { useCanvasStore } from "../store/canvas-store";
import {
  AutomationDrawer,
  CommandPalette,
  ControlConfirmDialog,
  ExplorerDrawer,
  NodeObservationDrawer,
  GithubDrawer,
  HandoffDialog,
  HandoffHistoryDrawer,
  CodeActionMenu,
  DispatchDrawer,
  EditPreviewDialog,
  MergeDialog,
  ProblemsPanel,
  ReferencesPanel,
  ResourceDrawer,
  QuickOpen,
  SettingsDialog,
  ShareDialog,
  CloudTrustDialog,
  GitToolWindow,
  SshPromptDialog,
  UsageDashboard,
  WorkflowPanel,
} from "./lazy";
import { DraftLayer } from "@/workflow/DraftCard";
import { AgentSettingsDialog } from "@/nodes/AgentSettingsDialog";
import { NodeNameDialog } from "@/nodes/NodeNameDialog";
import { JoinedSourceOpener } from "./joined-source";
import { useMountedOnce, useOverlayRequested } from "./overlay-gates";
import { useLinkFragments } from "./use-link-fragments";
import { useSourcesBootstrap } from "./use-sources-bootstrap";
import { panelHidden } from "@/lib/features";
import { useShareStore } from "@/canvas/share/share-store";
import { useTrustDialog } from "@/sources/trust/trust-store";

/**
 * 所有浮层的挂载点。
 *
 * 以前这一段直接写在 `App.tsx` 里，十几个 `lazy()` 组件无条件渲染——于是
 * `React.lazy` 在启动那一刻就把每一个 chunk 都取了回来。闸门的理由写在
 * `overlay-gates.ts`；这里只负责「谁看哪一个开合状态」。
 *
 * 四个例外留在下面无条件挂着，因为它们的触发器是一条事件流而不是一个开合
 * 状态：控制确认、SSH 口令、交接对话框等工作空间事件，起名对话框等用户拉完
 * 一条线的那一刻。都得在事件到达**之前**就已经订阅上，所以它们连 `lazy` 都
 * 不是——一个还在取 chunk 的监听器等于没有监听器。加起来不到 8 kB，放进闸门
 * 只会把「谁先订阅」这条规则弄乱。
 */

function Gate({
  open,
  shape,
  children,
}: {
  open: boolean;
  /** 分块下载期间占位的外形；不给就不画（菜单类浮层本来无壳）。 */
  shape?: OverlayShape;
  children: React.ReactNode;
}) {
  const mounted = useMountedOnce(open);
  if (!mounted) return null;
  return shape ? (
    <OverlaySuspense shape={shape}>{children}</OverlaySuspense>
  ) : (
    <>{children}</>
  );
}

export function Overlays() {
  const panels = useCanvasStore((state) => state.panels);
  const codeAction = useOverlayRequested("codeAction");
  const editPreview = useOverlayRequested("editPreview");
  const merge = useOverlayRequested("merge");
  const share = useShareStore((state) => state.request !== null);
  const trust = useTrustDialog((state) => state.open);
  useLinkFragments();
  useSourcesBootstrap();

  return (
    <Suspense fallback={null}>
      <JoinedSourceOpener />
      <Gate open={panels.explorer !== "closed"} shape="drawer">
        <ExplorerDrawer />
      </Gate>
      <Gate open={panels.observation !== "closed"} shape="drawer">
        <NodeObservationDrawer />
      </Gate>
      <Gate open={panels.scm !== "closed"} shape="window">
        <GitToolWindow />
      </Gate>
      <Gate open={panels.problems !== "closed"} shape="drawer">
        <ProblemsPanel />
      </Gate>
      <Gate open={panels.references !== "closed"} shape="drawer">
        <ReferencesPanel />
      </Gate>
      <Gate open={editPreview} shape="dialog">
        <EditPreviewDialog />
      </Gate>
      <Gate open={codeAction}>
        <CodeActionMenu />
      </Gate>
      <Gate open={merge} shape="dialog">
        <MergeDialog />
      </Gate>
      <Gate open={panels.resources !== "closed"} shape="drawer">
        <ResourceDrawer />
      </Gate>
      <Gate
        open={panels.automation !== "closed" && !panelHidden("automation")}
        shape="drawer"
      >
        <AutomationDrawer />
      </Gate>
      <Gate
        open={panels.usage !== "closed" && !panelHidden("usage")}
        shape="drawer"
      >
        <UsageDashboard />
      </Gate>
      <Gate open={panels.github !== "closed"} shape="drawer">
        <GithubDrawer />
      </Gate>
      <Gate open={panels.settings} shape="dialog">
        <SettingsDialog />
      </Gate>
      <Gate open={share} shape="dialog">
        <ShareDialog />
      </Gate>
      <Gate open={trust} shape="dialog">
        <CloudTrustDialog />
      </Gate>
      <Gate open={panels.palette} shape="dialog">
        <CommandPalette />
      </Gate>
      <Gate open={panels.quickOpen} shape="dialog">
        <QuickOpen />
      </Gate>
      <Gate open={panels.handoff !== "closed"} shape="drawer">
        <HandoffHistoryDrawer />
      </Gate>
      <Gate
        open={panels.workflow !== "closed" && !panelHidden("workflow")}
        shape="drawer"
      >
        <WorkflowPanel />
      </Gate>
      <Gate open={panels.dispatch !== "closed"} shape="drawer">
        <DispatchDrawer />
      </Gate>
      {/* 事件流驱动的四个：必须先订阅，不能等状态。 */}
      <ControlConfirmDialog />
      <DeviceApprovalPrompt />
      <NodeNameDialog />
      <AgentSettingsDialog />
      <SshPromptDialog />
      <HandoffDialog />
      {/* 工作流草案卡：`workflow.draft` 到达前就要订阅（设计系统 §5.5）。 */}
      <DraftLayer />
    </Suspense>
  );
}

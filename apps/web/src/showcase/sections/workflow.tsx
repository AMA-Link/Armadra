import { useState, type ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { RunPanel } from "@/workflow/RunPanel";
import { TemplateEditor } from "@/workflow/TemplateEditor";
import { TemplateLibrary } from "@/workflow/TemplateLibrary";
import { useWorkflowView } from "@/workflow/store";
import { COMPARED, EXPANDED, NOW, RUNS, TEMPLATES } from "../fixtures/workflow";

const noop = () => undefined;

/** 样本的说明只在内容自己没有标题时才写：组件里已有同名标题的，别再重复一遍。 */
function Sample({
  caption,
  label,
  children,
}: {
  caption?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <figure aria-label={label} className="flex min-w-0 flex-col gap-2">
      {caption ? (
        <figcaption className="text-meta text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
      {children}
    </figure>
  );
}

/**
 * `workflow` 分区（设计展示页 §2.1，设计系统 §5.5）：真的模板库、编辑器与运行
 * 记录，喂假数据。模板库三张卡与空态；编辑器选中第二步；运行记录五行、展开
 * 一行（关卡在等人）、勾了两行对比。时钟钉住。
 */
export default function WorkflowSection() {
  const t = useT();
  // 视图状态是全局 store：渲染前摆好，第一帧就是展开的样子。
  useState(() => {
    useWorkflowView.setState({ expanded: EXPANDED, compare: COMPARED });
    return null;
  });
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Sample caption={t("workflow.tab.templates")}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <TemplateLibrary templates={TEMPLATES} runs={RUNS} now={NOW} />
          <div className="rounded-panel border border-dashed border-border">
            <TemplateLibrary templates={[]} runs={[]} now={NOW} />
          </div>
        </div>
      </Sample>
      <Sample label={t("workflow.editor.steps")}>
        <TemplateEditor
          inline
          template={TEMPLATES[0]!}
          initialStep={TEMPLATES[0]!.template.steps[1]!.id}
          onClose={noop}
        />
      </Sample>
      <Sample caption={t("workflow.tab.runs")}>
        <div className="max-w-[460px] rounded-panel border border-border p-3">
          <RunPanel runs={RUNS} templates={TEMPLATES} />
        </div>
      </Sample>
    </div>
  );
}

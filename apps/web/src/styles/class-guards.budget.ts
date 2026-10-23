/**
 * 样式守卫的存量登记：规则 id → 文件 → 现有个数（`class-guards.test.ts` 说明用法）。
 * 只减不增；各包迁完自己目录就删掉那一块，批次 3 归零。
 */
export const LEGACY_BUDGET: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  "rounded-bare": {},
  "rounded-scale": {
    "services/ServicePicker.tsx": 1,
  },
  "rounded-arbitrary": {
    "showcase/sections/components.tsx": 4,
    "showcase/sections/states.tsx": 11,
    "showcase/sections/tokens.tsx": 4,
  },
  shadow: {},
  "control-height": {
    "coordinator/DispatchDrawer.tsx": 1,
    "node-observation/NodeObservationDrawer.tsx": 1,
    "nodes/SubagentCard.tsx": 1,
    "notifications/NotificationPanel.tsx": 4,
    "services/ServicePicker.tsx": 1,
    "sessions/SessionsSection.tsx": 1,
    "showcase/sections/components.tsx": 1,
    "showcase/sections/coordinator.tsx": 1,
    "showcase/sections/tokens.tsx": 2,
    "sidebar/BoardRow.tsx": 1,
    "sidebar/InlineName.tsx": 1,
    "sidebar/SidebarHeader.tsx": 1,
    "sidebar/SourceGroups.tsx": 2,
    "sidebar/WorkspaceTree.tsx": 2,
  },
  "var-class": {
    "showcase/sections/coordinator.tsx": 1,
  },
  "transition-all": {},
  duration: {},
  ease: {},
  "cubic-bezier": {},
  "stroke-width": {},
  "sonner-import": {},
  "text-px": {
    "showcase/ShowcaseApp.tsx": 1,
  },
  "text-length-var": {
    "services/ServicePicker.tsx": 2,
    "showcase/sections/components.tsx": 3,
    "showcase/sections/tokens.tsx": 7,
    "showcase/ShowcaseApp.tsx": 1,
  },
  "text-scale": {
    "showcase/sections/components.tsx": 2,
    "showcase/sections/states.tsx": 3,
    "showcase/sections/tokens.tsx": 2,
  },
};

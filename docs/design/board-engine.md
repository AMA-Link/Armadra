# 自研画板引擎设计

> 状态：**目标设计，实施中**（2026-11-15 定稿，B0 骨架已落地）。§8 的 Q1–Q12 均已决定，按「决定」列执行；Issue：Armadra#952。
> 基线：`main` `c2281727d`；体积数据取自 `apps/web/dist`（2026-11-11 构建，已压缩）与 `apps/desktop/out`（2026-11-14 构建，未压缩）。
> 范围：`apps/web/src/canvas/`、`apps/web/src/store/canvas/`、`apps/web/src/realtime/` 中与画布引擎相关的部分；`boards.whiteboard_json` 的新格式；实施批次与验收。只读了代码，没有运行应用，凡未经运行验证的判断都标了「待核实」。
> 前置阅读：[React Flow 画布](canvas-react-flow.md)（现行画布设计，§1.2 能力清单、§2 架构、§3 数据、§6 验收口径本文沿用）。
> 约定：本文只在「要移除的现有依赖」语境下提到 `@xyflow/react`、`@dagrejs/dagre`、`perfect-freehand`；新模块一律用自己的名字。

## 0. 结论

| 问题       | 结论                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 能不能自研 | **能，而且比想象的近。** 现有画布里最难的几块——连线路由与分道、整理排布、撤销重做、手势预览、投影缓存、滚轮缩放、白板工具指针通道、触屏新建、栅格导出、视口数学——已经是自己写的；现有库实际只提供七件事：相机变换与平移/捏合手势、节点 DOM 包壳与拖拽、框选、resize 把手、连线起落点状态机、缩略图、背景点阵（§1.2）。                                                                   |
| 值不值     | **值在可控与复用，不在体积。** 包体积净减约 140 KB（压缩后约 45 KB gzip），相对整个渲染进程的体量很小；代码行数总量基本持平（§5）。真正的收益是：去掉一批为绕开库行为而写的补丁（§1.3 列了 9 处有代码证据的）、画板底层成为一个无 React 依赖、可单测、可在展示页/站点复用的独立包、白板存储体积降到现在的 1/6–1/10（墨迹为主的板）。                                                     |
| 架构       | 新包 `packages/board`（`@armadra/board`），三个子入口：`core`（纯 TS，无 DOM、无 React：场景、相机、几何、空间索引、事务与撤销、编解码、连线路由）、`dom`（无 React：输入路由、手势状态机、分层渲染、缩略图）、`react`（薄绑定，约 500 行）。应用侧只剩一个适配器把 `canvas-store` 接到引擎上。                                                                                          |
| 数据       | **引擎内统一成一种实体，存储不合并。** 节点/边继续是 SQLite 行（`agent_mailbox` 对 `nodes` 级联删除，保存必须是 diff，`apps/desktop/src/core/canvas/documents.ts:34-37`），白板对象继续在 `whiteboard_json`；新格式 v3 保持 core 认识的外壳（`items` / `references` 两个带 `id` 的数组，`apps/desktop/src/core/realtime/doc.ts:14-17`），所以 **core、数据库迁移、Y.Doc 结构都不用改**。 |
| 渲染       | 三层：Canvas2D 画布层（点阵、墨迹、形状、直线、图片、文字）+ DOM 世界层（终端等节点，永不卸载、永不重排）+ SVG/DOM 叠加层（连线、选框、把手、他人光标）。屏幕、缩略图、PNG 导出共用一套绘制函数。                                                                                                                                                                                        |
| 工期       | 7 批（B0–B6），B2 起有特性开关并行两套渲染，B6 才删旧依赖。渲染切换与存储切换互相独立，可分别回退。                                                                                                                                                                                                                                                                                      |
| 最大风险   | 输入手势在各平台的一致性（触控板捏合、iOS 触屏、终端焦点、输入法）；Canvas2D 文字与高分屏重绘；v3 切换让已发版用户的白板清空（按「不迁移」规则执行，但需用户再确认一次，§8 Q2）。                                                                                                                                                                                                        |

## 1. 现状与可行性

### 1.1 规模

| 项                                       | 数值                                                                                                                                                                                                                                                                                                        | 来源                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/web/src/canvas/` 非测试代码        | 123 个文件，23,342 行                                                                                                                                                                                                                                                                                       | `find … ! -name '*.test.*' \| xargs wc -l` |
| `apps/web/src/canvas/` 测试              | 103 个文件，21,018 行                                                                                                                                                                                                                                                                                       | 同上                                       |
| import `@xyflow/react` 的文件            | 64 个，其中非测试 42 个（画布内 32，画布外 10：`app/App.tsx:7`、`shell/Dock.tsx:2`、`nodes/browser/pool.ts:3`、`nodes/browser/WebviewSurface.tsx:16`、`realtime/CursorLayer.tsx:3`、`realtime/comments/CommentLayer.tsx:2`、`app/test-harness.tsx:3`、`showcase/sections/{canvas,coordinator,status}.tsx`） | `grep -rn "@xyflow/react"`                 |
| 源码里提到现有库或其内部类名的非测试文件 | 112 个文件、285 处；`react-flow__*` 类名硬编码 46 处；`nowheel` / `nodrag` / `nopan` 约定 32 处                                                                                                                                                                                                             | `grep -rc`                                 |
| 现有库打包块                             | 187,651 B（gzip 60,222 B）+ 样式 15,413 B（gzip 2,556 B）                                                                                                                                                                                                                                                   | `apps/web/dist/assets/xyflow-*.{js,css}`   |
| 块内成分                                 | `@xyflow/react`、`@xyflow/system`、`d3-zoom` / `d3-drag` / `d3-selection` 等 9 个手势与插值包、`classcat`、库自带的另一份状态库、`perfect-freehand`                                                                                                                                                         | `apps/web/vite.config.ts:126-130`          |

### 1.2 每项能力现在靠谁、自研要替代什么

「已自有」指现有实现不依赖库的内部，只需换输入来源；「需新写」指现在由库提供。

| 能力                                                   | 现在的实现（证据）                                                                                                                                                                                                                                                                                    | 归属           | 自研要做的                                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 相机 / 坐标变换                                        | 库的 `transform` 与 `screenToFlowPosition`（`canvas/flow/flow-context.ts:68-72`）；`zoomAroundPoint`、`clampZoom`、`initialViewportFor`、`phoneFitViewport` 等是自己的纯函数（`canvas/zoom.ts`、`canvas/viewport.ts`）                                                                                | 一半自有       | `Camera` 类：`{x,y,zoom}` 与现有 `Viewport` 同语义；`screenToWorld` / `worldToScreen`；带时长的过渡（现在是库的 `setViewport({duration})`，`canvas/flow/use-flow-viewport.ts:87-102`） |
| 滚轮平移 / 缩放                                        | 节点体内的 ⌘滚轮已经是自己算（`canvas/interaction/wheel-zoom.ts:50-76`，原因见 `nodes/NodeShell.tsx:160-164`）；空白处滚轮与捏合走库内的 `d3-zoom`                                                                                                                                                    | 一半自有       | 统一成一个滚轮处理器（现在两条路并存）；触控板捏合 = `ctrlKey` 的 wheel；Safari 的 `gesture*` 事件                                                                                     |
| 拖动平移（空格 / 中键 / 手形）、触屏单指平移与双指捏合 | 库（`canvas/flow/flow-options.ts:84-93`）                                                                                                                                                                                                                                                             | 需新写         | 指针手势状态机里的 `pan` 与 `pinch` 两个状态                                                                                                                                           |
| 惯性                                                   | **现在没有**（全目录搜不到 inertia / momentum）                                                                                                                                                                                                                                                       | —              | 不做（§8 Q8）                                                                                                                                                                          |
| 命中测试                                               | 节点靠 DOM 自身；连线靠库画的一条加粗透明路径（`canvas/flow/edges/LinkEdge.tsx:138-148` 的 `interactionWidth`）；白板对象作为库节点也靠 DOM，另有 `whiteboard/geometry.ts:202` 的 `hitTestItem` 给右键与引用用                                                                                        | 一半自有       | DOM 节点继续靠 DOM（`closest('[data-board-id]')`）；画在 Canvas 上的对象与连线走空间索引 + 精确几何                                                                                    |
| 空间索引                                               | 没有。连线路由每条边线性扫全部节点找障碍（`canvas/flow/edges/edge-scene.ts:81-89`），指纹每次全量哈希（`edge-router.ts:86-102`）                                                                                                                                                                      | 需新写         | 均匀网格索引（§2.5）                                                                                                                                                                   |
| 框选                                                   | 库（`selectionOnDrag`、`SelectionMode.Full/Partial`，`flow-options.ts:95-97`）；选区真相在 store（`store/canvas/selection.ts`），库的 `onNodesChange` 只是翻译（`canvas/flow/use-flow-nodes.ts:235-250`）                                                                                             | 需新写         | `marquee` 状态 + 索引查询，直接写 store                                                                                                                                                |
| 节点拖拽                                               | 库的 `d3-drag`，回调写预览、松手提交（`use-flow-nodes.ts:77-126`、`canvas/flow/drafts.ts`）                                                                                                                                                                                                           | 一半自有       | `drag` 状态；预览机制并进引擎的「预览事务」                                                                                                                                            |
| 吸附网格、边缘自动平移                                 | 库（`snapToGrid`、`autoPanOnNodeDrag`，`flow-options.ts:98-101`）；白板工具另有自己的 `tools/grid.ts`                                                                                                                                                                                                 | 一半自有       | 拖拽状态里取整；边缘自动平移是一个 rAF 循环                                                                                                                                            |
| 分组父子                                               | 库的 `parentId` 相对坐标与 `internals.positionAbsolute`；换父是自己的（`use-flow-nodes.ts:113-125`、`canvas/geometry.ts:248`）；绝对坐标换算也有自己的一份（`store/canvas/internal.ts:108-118`）                                                                                                      | 一半自有       | 场景索引维护绝对包围盒（父变了子跟着失效）                                                                                                                                             |
| resize                                                 | 库的 `NodeResizer`（`flow/nodes/ArmadraNode.tsx:100-109`、`GroupNode.tsx`、`whiteboard/nodes/ItemFrame.tsx`）                                                                                                                                                                                         | 需新写         | 叠加层上 8 个把手 + `resize` 状态；最小尺寸、锁比例、只调宽三个约束                                                                                                                    |
| 连线起笔 / 落点                                        | 库的 `Handle` + `useConnection`（`flow/nodes/ConnectionHandles.tsx:99-125`）；合法性、分类、拒绝提示是自己的（`flow/edges/connect.ts`、`use-flow-nodes.ts:286-351`）；预览线是自己的（`flow/edges/ConnectionLine.tsx`）                                                                               | 一半自有       | `connect` 状态：四边把手画在叠加层，落点按索引取指针下的实体                                                                                                                           |
| 边路由 / 分道 / 标签避让                               | **全部自有**：`flow/edges/{route,nudge,smooth,edge-label,link-visual,edge-router}.ts` 约 2,070 行；只在取节点矩形时读库的内部表（`edge-scene.ts:26-37`、`edge-router.ts:64-67`）                                                                                                                      | 已自有         | 把输入从库的 `nodeLookup` 换成场景索引，其余原样搬进 `core`                                                                                                                            |
| 边的绘制                                               | 库的 `BaseEdge` + `EdgeLabelRenderer`（`LinkEdge.tsx`、`ReferenceEdge.tsx`）                                                                                                                                                                                                                          | 需新写（很薄） | 叠加层里一张世界坐标 SVG，自己写 `<path>`                                                                                                                                              |
| 缩略图                                                 | 库的 `MiniMap` + `Panel`，配色、连线层是自己的（`flow/Minimap.tsx:234-251, 415`、`flow/minimap-links.ts`）                                                                                                                                                                                            | 一半自有       | 一张小 Canvas，复用画布层的绘制函数；点击 / 拖动定位                                                                                                                                   |
| 选择与键盘                                             | 选区在 store；键盘全应用只有一个监听器，库的按键全部置空（`FlowWorkspace.tsx:498-507`）                                                                                                                                                                                                               | 已自有         | 不变                                                                                                                                                                                   |
| DOM 节点层                                             | 库把每个节点包一层绝对定位的 `div`，全量渲染不裁剪（`FlowWorkspace.tsx:497`）                                                                                                                                                                                                                         | 需新写（很薄） | 一个带 `transform` 的世界容器 + 每实体一个定位包壳（§2.7）                                                                                                                             |
| 背景点阵                                               | 库的 `Background`（`FlowWorkspace.tsx:514-520`）                                                                                                                                                                                                                                                      | 需新写（很薄） | 画布层第一步绘制                                                                                                                                                                       |
| 墨迹 / 形状 / 文字 / 图片 / 直线                       | 数据模型、几何、栅格化自有（`whiteboard/{model,ink,geometry,raster}.ts`）；屏幕显示是 5 个库节点组件 + `ItemFrame`（合计约 625 行）；进行中笔迹靠库的 `ViewportPortal`（`whiteboard/tools/DraftPreview.tsx:1`）；工具指针通道自有，但受库事件相位牵制（`whiteboard/tools/use-tool-pointer.ts:27-38`） | 一半自有       | 屏幕显示改为画布层绘制，与 `raster.ts` 合并成一套                                                                                                                                      |
| 撤销重做                                               | **全部自有**（`store/canvas/history.ts`，458 行；实时板交给 `Y.UndoManager`，`realtime/undo.ts:9-20`）                                                                                                                                                                                                | 已自有         | 泛化后搬进 `core`，代理接口保留                                                                                                                                                        |
| 协作光标 / 评论钉                                      | 自有逻辑，靠库的 `ViewportPortal` 做相机变换、读 `transform` 做 `1/zoom` 反缩放（`realtime/CursorLayer.tsx:84-91, 116-122`、`realtime/comments/CommentLayer.tsx:233-266`）                                                                                                                            | 一半自有       | 改挂屏幕坐标的叠加层，不再反缩放                                                                                                                                                       |
| 可见性 / 性能                                          | 全量渲染；30 终端 + 300 墨迹实测平移 112 fps（`docs/design/canvas-react-flow.md` §6.5，第 714-720 行）；投影按身份缓存（`canvas/sync/project.ts:93-130`）                                                                                                                                             | 已自有         | DOM 节点仍全量挂载；画布层按视口裁剪绘制                                                                                                                                               |
| 内嵌网页节点的顺序约束                                 | 库按数组顺序渲染，两个宿主节点对调会触发 `insertBefore` → 页面重载，所以有一整套「池区」排序（`nodes/browser/pool.ts:14-47`），以及「不能用 `hidden`，只能零尺寸」的绕行（`pool.ts:156-157`）                                                                                                         | 补丁           | 引擎的 DOM 层只追加、不重排，层级用 `z-index`；约束由构造保证                                                                                                                          |

### 1.3 因库行为而存在的补丁（自研后可删）

| #   | 补丁                                                                                                  | 证据                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | 绘图工具必须通过关掉框选开关来避免框选，因为库的框选起点装在 React 捕获相位，比容器上的原生监听器更早 | `flow/flow-options.ts:64-72`、`whiteboard/tools/use-tool-pointer.ts:31-38`                    |
| 2   | 节点体内 ⌘滚轮自己算缩放，因为库用按键状态判断缩放 / 平移，焦点在终端时判错                           | `nodes/NodeShell.tsx:160-164`、`interaction/wheel-zoom.ts`                                    |
| 3   | 白板对象与分组必须带一个不可见的 source 锚点，否则引用边整条画不出来                                  | `whiteboard/nodes/ItemFrame.tsx:19-23`、`sync/project.ts:150-156`                             |
| 4   | resize 只认库报的增量、不认绝对尺寸；回调要包一层稳定引用                                             | `ItemFrame.tsx:59` 起、`flow/nodes/stable-resize.ts`                                          |
| 5   | 投影时手工填 `measured`，否则缩略图、适应视图、引用边要等库量一遍 DOM                                 | `sync/project.ts:196, 226`                                                                    |
| 6   | 内嵌网页节点的池区排序与零尺寸 ghost                                                                  | `nodes/browser/pool.ts:14-47, 156-157`                                                        |
| 7   | 触屏新建靠在库的空白层上派发合成 `contextmenu`，并硬编码库的类名                                      | `interaction/touch-create.ts:16-19, 254, 278`、`whiteboard/tools/use-double-click-text.ts:42` |
| 8   | 光标与评论钉按 `1/zoom` 反缩放                                                                        | `realtime/CursorLayer.tsx:84`                                                                 |
| 9   | 画布外模块要经模块级句柄拿库实例，`App` 整体包一层 Provider                                           | `flow/flow-context.ts:17-31`、`app/App.tsx:7`                                                 |

### 1.4 可行性结论与风险

- **可行**：需新写的部分（相机手势、拖拽、框选、resize、连线状态机、DOM 包壳、缩略图、画布层绘制、空间索引）估计 3,000–3,500 行，没有算法难点；难点在交互细节的一致性，见 §7。
- **不建议合并存储**：节点与边有服务端语义（会话、邮箱级联、控制面动词只改节点，`apps/desktop/src/core/collab/control/board.ts:106`），白板对象对 core 不透明。引擎层统一、存储层分开是成本最低的收敛方式。
- **诚实的预期**：包体积与代码行数的收益有限（§5）；如果目标只是「减体积」，这件事不值得做。值得做的理由是独立性、复用性、去补丁与存储压缩。

## 2. 新架构

### 2.1 放在哪：独立包 `packages/board`

| 方案                              | 优点                                                                                                                                                                                                         | 缺点                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `packages/board`（采用）**   | 依赖边界由包管理器强制（`package.json` 里没有 react、zustand、`@armadra/shared`，想越界也 import 不到）；`core` 在 Node 环境跑单测，不要 jsdom；展示页、官网演示、导出脚本可直接用；满足「画板基础功能独立」 | 多一个包的构建配置；web 与包之间改接口要跨目录                                                                                                             |
| B. `apps/web/src/board/` 独立目录 | 零构建成本                                                                                                                                                                                                   | 边界只能靠 lint 规则；现有 `whiteboard/` 就是这种做法，结果仍 import 了偏好与 store（`whiteboard/model.ts:4-7`、`whiteboard/tools/use-tool-pointer.ts:5`） |

采用 A。包内不出现任何产品概念（终端、Agent、worktree），实体的业务内容是不透明的 `data`。

```text
packages/board/
  src/core/      纯 TS：无 DOM、无 React、零运行时依赖
    math.ts        Vec / Box / 变换
    camera.ts      Camera、fit、zoomAround、过渡插值
    scene.ts       Entity、Scene、Patch、事务
    history.ts     撤销栈（按实体反向补丁）
    spatial.ts     网格索引
    hit.ts         精确命中（盒、折线、轮廓、几何形）
    shapes/        ink.ts line.ts geo.ts text-layout.ts（几何与包围盒）
    routing/       route.ts nudge.ts smooth.ts label.ts router.ts（现有连线路由搬入）
    codec/         v3.ts（白板编解码）、ink-pack.ts（点集压缩）
  src/dom/       依赖 DOM，无 React
    input.ts       指针 / 滚轮 / 手势事件归一
    gestures/      idle pan pinch marquee drag resize connect draw
    layers.ts      画布层 / 世界层 / 叠加层的创建与相机同步
    paint.ts       Canvas2D 绘制（屏幕、缩略图、导出共用）
    minimap.ts
    board.ts       Board 门面
  src/react/     薄绑定
    Board.tsx  EntityHost.tsx  hooks.ts
```

入口：`@armadra/board/core`、`@armadra/board/dom`、`@armadra/board/react`（实施时三个入口都是子路径，没有根入口）。

**消费方式：直接读 TypeScript 源码，不构建。** `exports` 指向 `src/*/index.ts`，`apps/web` 的 Vite、vitest 与 `tsc`（`moduleResolution: Bundler`）都能直接转译与检查工作区内的 `.ts` 源码，所以包不进 `pnpm libs:build`，也没有 `dist`；改了包源码，web 的开发服务器立即热更新。包不被发布，不需要产物。若以后要给仓库外使用（官网演示），再加 `tsconfig.build.json` 与构建步骤即可，不影响现有消费方。

**边界强制**（B0 已落地）：`tsconfig.core.json` 的 `lib` 只有 ES2022，写浏览器全局直接编译失败；根 `eslint.config.js` 对 core 禁止浏览器全局、React、dom / react 入口与任何第三方 import，对 dom 禁止 React；`pnpm board:budget` 按 §5.3 的数字检查各入口行数。

### 2.2 分层与数据流

```text
 canvas-store（节点 / 边 / 白板 / 选区，仍是内存真相）
        │  适配器（apps/web/src/canvas/board-adapter.ts，按对象身份 diff）
        ▼
 Scene（实体表 + 空间索引 + 预览事务）───────────► 连线路由器（按边缓存）
        │                                              │
        ▼                                              ▼
 ┌─ 画布层 Canvas2D ─┐  ┌─ 世界层 DOM ─┐  ┌─ 叠加层 SVG/DOM ─┐
 │ 点阵、白板对象     │  │ 节点、分组框   │  │ 连线、选框、把手、 │
 │（下带 / 上带两张）  │  │（React 节点）  │  │ 预览线、他人光标   │
 └──────────────────┘  └──────────────┘  └──────────────────┘
        ▲
 输入路由 → 手势状态机 → Intent（move / resize / connect / select / create）
        └────────────► 适配器 → canvas-store 动作（记历史、置脏、镜像到 Y.Doc）
```

规则沿用现行设计 §2.1 的四条，只改主语：

1. 画布修改一律经 `canvas-store` 动作；引擎只发意图，不直接改应用状态。
2. 手势中的临时几何是引擎的**预览事务**，不进文档；手势结束才发一条意图，一次手势一条历史。`realtime/binding.ts:57-58` 的「手势进行中先攒着远端改动」改读 `board.gestureActive()`。
3. 适配器按对象身份 diff（等价于现在的 `sync/project.ts`，但不再产出库的节点对象，只产出实体头）。
4. 远端灌入不进撤销栈。

引擎同时自带一个不依赖 store 的内存场景（`createScene()`，含撤销），展示页与独立演示直接用它——这是「基础功能独立」的验收点。

### 2.3 统一实体模型

节点、边、白板对象在引擎里是同一种东西：一个带几何头的实体，业务内容不透明。

```ts
export type EntityId = string;

/** 实体的种类决定它画在哪一层、怎么命中。 */
export type Layer = "canvas-under" | "world" | "canvas-over" | "overlay";

export interface Entity<D = unknown> {
  readonly id: EntityId;
  /** 应用自定义：`card` `group` `ink` `text` `shape` `image` `line` `link` `reference`。 */
  readonly kind: string;
  /** 父实体；坐标相对父（与现有 parentId 约定一致）。 */
  readonly parent?: EntityId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 同层内的绘制顺序。 */
  readonly z: number;
  /** 连接类实体（连线、引用）的两端；有它就没有自己的 x/y/w/h 语义。 */
  readonly ends?: readonly [EntityId, EntityId];
  /** 业务内容：CanvasNode、Item、CanvasEdge……引擎不看。 */
  readonly data: D;
}

/** 每种 kind 的行为表；应用注册。 */
export interface KindSpec<D = unknown> {
  layer: Layer;
  /** 精确命中；缺省按包围盒。 */
  hit?(entity: Entity<D>, point: Vec, tolerance: number): boolean;
  /** 画到 Canvas（canvas-* 层必填；world 层用于缩略图与导出，可选）。 */
  paint?(ctx: CanvasRenderingContext2D, entity: Entity<D>, env: PaintEnv): void;
  /** 是否当连线障碍（现在的 PASS_THROUGH 表，edge-scene.ts:17）。 */
  obstacle?: boolean;
  resize?: { min: Size; keepAspect?: boolean; widthOnly?: boolean } | false;
  /** 拖拽起手区选择器（world 层；现在的 dragHandle）。 */
  dragHandle?: string;
  connect?: { start: boolean; end: boolean };
}
```

实施时的两处小调整：几何矩形命名为 `Rect`（下文草图中的 `Box` 即 `Rect`，`{ x, y, w, h }`）；因为 core 的类型环境没有 DOM，`KindSpec` 与 `PaintEnv` 带类型参数（绘制上下文 `C`、位图 `I`），dom 入口把它们收窄成 `CanvasRenderingContext2D` 与 `CanvasImageSource`。

与三处存储的对应（**存储不变，只有内存里统一**）：

| 存储                                                                  | 现状                                                                          | 进引擎后的 `kind`                                 | 写回                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `nodes` 表（`packages/shared/src/domain/nodes.ts:24-52`）             | `CanvasNode`                                                                  | `card`（非分组）/ `group`                         | `moveNodes` / `resizeNode` / `setParent` 等现有动作 |
| `edges` 表（`nodes.ts:72-87`）                                        | `CanvasEdge`                                                                  | `link`                                            | `addEdge` / `removeEdges`                           |
| `boards.whiteboard_json`（`packages/shared/src/domain/boards.ts:82`） | `WhiteboardDoc.items` / `.references`（`canvas/whiteboard/model.ts:176-182`） | `ink` `text` `shape` `image` `line` / `reference` | `whiteboard/store.ts` 的现有动作                    |
| Y.Doc（`apps/web/src/realtime/doc.ts:26-30`）                         | `nodes` / `edges` / `whiteboard` / `whiteboardRefs` / `meta` 五个根           | 不感知引擎                                        | `realtime/binding.ts` 仍绑 store                    |

`wb:` 前缀（`whiteboard/model.ts:25`）在适配器里继续充当实体 id 的命名空间，引擎不关心。

### 2.4 场景、事务与撤销

```ts
export interface Patch<D = unknown> {
  /** id → 实体 | null（null = 不存在）。与现有 EntityPatch 同构（store/canvas/history.ts:30-35）。 */
  readonly before: ReadonlyMap<EntityId, Entity<D> | null>;
  readonly after: ReadonlyMap<EntityId, Entity<D> | null>;
}

export interface Scene {
  get(id: EntityId): Entity | undefined;
  /** 绝对包围盒（已叠加父级偏移与预览）。 */
  bounds(id: EntityId): Box | undefined;
  query(area: Box, filter?: (entity: Entity) => boolean): Entity[];
  hit(
    point: Vec,
    options?: { tolerance?: number; layers?: Layer[] },
  ): Entity | undefined;
  /** 应用外部真相的一次增量；不进撤销栈。 */
  sync(patch: Patch): void;
  /** 预览事务：手势中的临时几何。commit 之前文档不变。 */
  preview(
    changes: ReadonlyMap<
      EntityId,
      Partial<Pick<Entity, "x" | "y" | "w" | "h">>
    >,
  ): void;
  clearPreview(): void;
  subscribe(listener: (changed: ReadonlySet<EntityId>) => void): () => void;
}

/** 独立使用时的可写场景（展示页、测试）；Armadra 走适配器，不用它的撤销栈。 */
export interface MemoryScene extends Scene {
  transact(
    mutate: (draft: SceneDraft) => void,
    options?: { history?: "record" | "ignore"; label?: string },
  ): Patch;
  undo(): void;
  redo(): void;
}
```

撤销：`store/canvas/history.ts` 的栈、合并会话（文字编辑）、`HistoryDelegate`（实时板交给 `Y.UndoManager`）语义全部保留，实现泛化成 `History<Patch>` 搬进 `core/history.ts`；store 侧只留「四张表 ↔ Patch」的转换与代理装卸。

### 2.5 相机、几何与空间索引

```ts
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
} // 与 shared 的 Viewport 同义

export interface Camera {
  get(): CameraState;
  set(next: CameraState, options?: { duration?: number }): void;
  screenToWorld(point: Vec): Vec;
  worldToScreen(point: Vec): Vec;
  /** 当前可见的世界矩形。 */
  visible(): Box;
  zoomAround(screen: Vec, zoom: number, options?: { duration?: number }): void;
  fit(
    bounds: Box,
    options?: { padding?: number; maxZoom?: number; duration?: number },
  ): void;
  center(world: Vec, options?: { zoom?: number; duration?: number }): void;
  subscribe(listener: (state: CameraState) => void): () => void;
  /** 锁定视图（canvas-lock.ts）。 */
  locked: boolean;
  limits: { min: number; max: number };
}
```

**空间索引选型：均匀网格 + 大对象旁路表。**

| 方案                 | 更新成本                      | 查询                 | 代码量        | 适配度                                                             |
| -------------------- | ----------------------------- | -------------------- | ------------- | ------------------------------------------------------------------ |
| 线性扫描（现状）     | 0                             | O(n)                 | 0             | 30 节点够用，上千条墨迹时每帧命中与裁剪吃力                        |
| **均匀网格（采用）** | O(覆盖格数)，拖动时增量更新   | O(覆盖格数 + 命中数) | 约 120 行     | 对象尺寸相近、更新频繁（拖拽每帧）、总量几十到几千——正是这里的分布 |
| R 树                 | 插入/删除带再平衡，批量加载快 | O(log n + k)         | 约 500 行自写 | 尺寸差异极大、总量上万时才占优                                     |

格边长取 512 世界单位（约一个默认节点的宽度）；跨度超过 8×8 格的对象（大分组框、长连线）进旁路表线性比较。索引接口抽象成 `SpatialIndex { insert, remove, update, query }`，以后数据量变了可换实现而不动调用方。

受益方：画布层视口裁剪、框选、Canvas 对象与连线的命中、连线路由找障碍（替掉 `edge-scene.ts:81-89` 的全量扫描）、落点判定、换父判定。

### 2.6 输入与手势状态机

一个输入路由器，用**原生** Pointer Events 装在画布容器上（不经 React 合成事件，§1.3 补丁 1 的根因随之消失）。

```ts
export interface PointerInput {
  id: number;
  type: "mouse" | "touch" | "pen";
  button: number;
  screen: Vec;
  world: Vec;
  pressure: number;
  mods: {
    shift: boolean;
    alt: boolean;
    meta: boolean;
    ctrl: boolean;
    space: boolean;
  };
  /** 按下那一刻命中的东西（按 overlay → world DOM → canvas 对象 → 连线 → 空白 的顺序）。 */
  target: HitTarget;
}

export type HitTarget =
  | { type: "blank" }
  | { type: "entity"; id: EntityId; part: "body" | "drag-handle" }
  | { type: "handle"; id: EntityId; handle: ResizeHandle | ConnectSide }
  | { type: "editable" }; // 输入框、终端、可选中文本：引擎放手

export interface Gesture {
  readonly name: string;
  move(input: PointerInput): void;
  /** 第二根手指按下等情况；返回要切换到的手势。 */
  add?(input: PointerInput): Gesture | null;
  end(input: PointerInput): void;
  cancel(): void;
}

export interface Tool {
  readonly id: string; // select / hand / ink / shape / line / text ……
  cursor?: string;
  /** 按下时决定进入哪个手势；null = 不处理，交给浏览器。 */
  begin(input: PointerInput, board: Board): Gesture | null;
}
```

状态转移（`select` 工具）：

| 按下位置    | 条件                                     | 手势                                       | 结束时的意图                    |
| ----------- | ---------------------------------------- | ------------------------------------------ | ------------------------------- |
| 空白        | 左键                                     | `marquee`                                  | `select`                        |
| 空白        | 中键 / 空格 + 左键 / 手形工具            | `pan`                                      | —                               |
| 实体拖拽区  | 移动超过 4px（现 `NODE_DRAG_THRESHOLD`） | `drag`（含吸附、边缘自动平移、多选一起走） | `move` + 可能的 `reparent`      |
| 实体拖拽区  | 未超过阈值                               | —                                          | `select`（Shift 增减）          |
| resize 把手 | —                                        | `resize`                                   | `resize`                        |
| 连线把手    | —                                        | `connect`                                  | `connect` 或 `connect-rejected` |
| 任意        | 第二根手指                               | `pinch`（平移 + 缩放）                     | —                               |
| 可编辑区    | —                                        | 不接管                                     | —                               |

绘图工具各自是一个 `Tool`，手势是 `draw`；现有 `whiteboard/tools/draft.ts` 的纯函数（起笔 / 延长 / 落成）原样复用。触屏长按与双击（`interaction/touch-create.ts`）变成路由器上的两个识别器，直接发 `context-menu` 意图，不再合成 `contextmenu` 事件。

滚轮：`ctrl/meta + wheel` 与触控板捏合 → 以指针为中心缩放；其余 → 平移（输入设备偏好为鼠标时反过来）；目标在 `wheelBelongsToCanvas` 判定之外（终端、编辑器自己滚）时放手——规则沿用 `canvas/zoom.ts:90`。

键盘不进引擎：全应用单一监听器（`keybindings.ts`）继续调 `canvas.*` 命令，命令再调 `board` 的方法。空格 / Shift 的按下状态由应用经 `board.setModifiers()` 告知。

### 2.7 渲染层

| 层          | 技术                                                                             | 内容                                     | 相机同步方式                                                                               |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| 画布层·下带 | Canvas2D                                                                         | 点阵；`canvas-under` 的白板对象          | 每次相机或场景变化在 rAF 里重绘可见区域（`setTransform` 套相机矩阵）                       |
| 世界层      | DOM                                                                              | 分组框、节点（React 子树）               | 容器 `transform: translate(x,y) scale(zoom)`，与现在完全相同的做法，终端在缩放下的表现不变 |
| 画布层·上带 | Canvas2D，`pointer-events: none`                                                 | 被「置顶」的白板对象（盖在节点上的标注） | 同下带                                                                                     |
| 叠加层      | SVG（世界坐标的连线）+ DOM（屏幕坐标的选框、把手、预览线、光标、评论钉、缩略图） | —                                        | 连线 SVG 跟世界层同一个变换；屏幕坐标部分由相机订阅直接算位置                              |

为什么这样分：

- **节点必须是 DOM**：终端（xterm）、编辑器、内嵌网页都是 DOM/原生视图，且终端不能卸载。世界层的子元素**只追加、不重排**，层级用 `z-index`，内嵌网页的「相对顺序永不变化」约束（`nodes/browser/pool.ts:27-29`）由构造保证，池区排序逻辑可以删，只留切工作区时的 ghost 保活。
- **白板对象用 Canvas2D 而不是逐个 DOM/SVG**：现在每条墨迹是一个库节点（包壳 `div` + SVG + resize 组件 + 两个把手），300 条墨迹就是上千个 DOM 元素；Canvas 上是 300 个缓存的 `Path2D`，可裁剪、无布局成本。更重要的是屏幕、缩略图、PNG 导出（现在 `whiteboard/raster.ts` 355 行是另一套绘制）合并成一套 `paint`，导出与所见一致。
- **连线留在 SVG**：数量少（几十条），需要 CSS 变量取色、`<title>` 提示、投递流动动画（`LinkEdge.tsx:137, 154-165`），这些在 Canvas 上要重造。命中改用几何（折线距离），不再画加粗透明路径。
- **点阵在 Canvas 上顺手画**，缩放到很小时自动稀疏化（现在库的点阵在 0.1 缩放下密到发灰，待核实）。

重绘策略：相机变化 → 标脏 → rAF 重绘；`Path2D` 与文字排版按实体身份缓存；只画 `scene.query(camera.visible())` 命中的对象。若 4K 高分屏上连续平移掉帧，备选是手势期间给 Canvas 套 CSS 变换、停手后重绘（留作 §7 R2 的缓解，不预先实现）。

文字对象：显示用 `fillText` + 共享的 `layoutText(text, width, font)`（折行与高度同一函数算，显示、导出、自适应高度一致）；编辑时在叠加层放一个 `Textarea` 对齐到对象上（现有 `InlineText` 的做法）。这是本设计里显示质量最需要验证的一点（§7 R2、§8 Q6）。

```ts
export interface PaintEnv {
  zoom: number;
  dpr: number;
  theme: "light" | "dark";
  /** 颜色名 → 十六进制（现 whiteboard/palette.ts 的明暗两张表）。 */
  color(name: string): string;
  /** 资源位图；没到位返回 undefined 并在到位后请求重绘。 */
  image(key: string): CanvasImageSource | undefined;
  selected: boolean;
}

export interface Board {
  readonly camera: Camera;
  readonly scene: Scene;
  mount(container: HTMLElement): void;
  destroy(): void;
  registerKind(kind: string, spec: KindSpec): void;
  setTool(tool: Tool): void;
  setOptions(options: Partial<BoardOptions>): void; // 网格、吸附、整框才选中、输入设备、只读、锁定
  setSelection(ids: ReadonlySet<EntityId>): void;
  gestureActive(): boolean;
  /** 世界层里这个实体的宿主元素；React 绑定往里 createPortal。 */
  hostOf(id: EntityId): HTMLElement | undefined;
  /** 把一组实体画到离屏 Canvas（PNG 导出、缩略图）。 */
  rasterize(ids: readonly EntityId[], options: RasterOptions): Promise<Blob>;
  on<E extends keyof BoardEvents>(
    event: E,
    listener: (payload: BoardEvents[E]) => void,
  ): () => void;
}

export interface BoardEvents {
  move: {
    ids: EntityId[];
    positions: Map<EntityId, Vec>;
    reparent: Map<EntityId, EntityId | null>;
  };
  resize: { id: EntityId; box: Box };
  connect: { from: EntityId; side: ConnectSide; to: EntityId | null; at: Vec };
  select: { ids: EntityId[]; additive: boolean };
  create: { tool: string; draft: unknown };
  "context-menu": { target: HitTarget; screen: Vec; world: Vec };
  "double-click": { target: HitTarget; world: Vec };
  camera: CameraState;
  gesture: { active: boolean };
}
```

### 2.8 React 绑定薄层

```tsx
// @armadra/board/react（约 500 行）
<BoardView board={board} className="canvas-stage">
  {/* 世界层：每个 world 实体一个宿主，子树是应用的节点组件 */}
  <EntityHosts kinds={["card", "group"]} render={(entity) => <ArmadraNode node={entity.data} />} />
  {/* 叠加层插槽：屏幕坐标 */}
  <Overlay><CursorLayer /><CommentLayer /><StylePanel /></Overlay>
  {/* 世界坐标插槽（连线、派生边、子代理卡片） */}
  <WorldOverlay><Edges /><CanvasOverlays /></WorldOverlay>
</BoardView>

useBoard(): Board
useCamera<T>(select: (state: CameraState) => T): T        // 替 useViewport / useStore(transform)
useEntity(id): Entity | undefined
useSelected(id): boolean
useGestureActive(): boolean
```

`EntityHosts` 只在实体**出现 / 消失**时增删宿主；位置与尺寸由引擎直接写宿主的 `style`（不经 React 渲染），所以拖动一个节点时其它 29 个终端的 React 子树完全不动——比现在按身份缓存投影对象（`sync/project.ts:110-130`）更直接。

画布外的十处依赖（§1.1）全部换成 `useBoard()` / `useCamera()` 或模块级 `getBoard()`；`App` 外层的 Provider 删掉。

## 3. 存储与数据结构

### 3.1 原则

1. core 把白板当不透明字节，只认外壳（`apps/desktop/src/core/realtime/doc.ts:14-20, 273-288`），只校验是字符串且不超过 8 MiB（`apps/desktop/src/core/canvas/routes.ts:734-740`、`validation.ts:111-115`）。**v3 保持外壳不变，于是 core、迁移、Y.Doc 根结构零改动。**
2. 压缩发生在序列化那一刻；内存模型（`Item` 联合类型）不变。因此**存储切换与渲染切换互相独立**，旧渲染也能读写 v3。
3. 不迁移：只认 `engine: "armadra-board"` + `version: 3`，其余一律按空白板处理（沿用 `whiteboard/serialize.ts:33-46` 的写法，改两个常量）。不写 v2 读取器。

### 3.2 `whiteboard_json` v3

```jsonc
{
  "engine": "armadra-board",
  "version": 3,
  "items": [
    // 公共头：id、k（种类）、b（[x,y,w,h] 整数）、z；可选 p（父）、s（样式，只写非缺省值）、m（meta）
    {
      "id": "h3Kq9vZ2xLmA",
      "k": "ink",
      "b": [120, 80, 310, 142],
      "z": 4,
      "s": { "c": "blue" },
      "o": [310, 142],
      "pt": "AQwC…",
    },
    { "id": "…", "k": "text", "b": [40, 300, 260, 0], "z": 5, "t": "备注" },
    {
      "id": "…",
      "k": "shape",
      "b": [400, 80, 160, 96],
      "z": 6,
      "g": "diamond",
      "l": "判断",
      "s": { "f": "semi" },
    },
    {
      "id": "…",
      "k": "image",
      "b": [600, 80, 320, 200],
      "z": 7,
      "a": ".armadra/assets/ab12….png",
    },
    {
      "id": "…",
      "k": "line",
      "b": [0, 0, 200, 120],
      "z": 8,
      "ln": [0, 0, 200, 120],
      "ae": 1,
    },
  ],
  "references": [
    { "id": "<uuid>", "itemId": "wb:h3Kq9vZ2xLmA", "nodeId": "<uuid>" },
  ],
}
```

| 手段                    | 做法                                                                                                                                                                                                                                                                  | 理由 / 取舍                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 墨迹点集压缩            | 坐标量化到 0.1 单位的整数（落成时本来就按 0.35 容差简化，`whiteboard/ink.ts:16-17`），压力量化到 0–63；首点绝对值，其后逐点 Δx、Δy、Δ压力，zigzag + varint，整段 base64url 存进 `pt`；所有点压力相同时（鼠标恒 0.5，`use-tool-pointer.ts:235-238`）置标志位不存压力列 | 现在是 `[[x,y,p],…]` 的原始浮点 JSON，坐标来自屏幕坐标除以缩放，不取整（`whiteboard/tools/draft.ts:107, 130`），每点 28–44 字节；压缩后每点 2–5 字节二进制，即 3–7 个字符 |
| 墨迹缩放不改点集        | 记落成时的原始盒 `o: [w0, h0]`，绘制时按 `w/w0`、`h/h0` 缩放                                                                                                                                                                                                          | 现在 resize 一条墨迹要重写整个点集（`ink.ts:157-166`），实时板上就是把整条 JSON 再写一遍                                                                                  |
| 坐标取整                | `b`、`ln` 一律整数                                                                                                                                                                                                                                                    | 节点侧早就取整了（`flow/nodes/ArmadraNode.tsx:55-61`）；白板对象没有                                                                                                      |
| 缺省值不写              | `s` 只写与缺省不同的键（颜色 `black`、粗细 `m`、实线、无填充）；`p`、`m` 没有就不出现                                                                                                                                                                                 | 多数对象样式是缺省                                                                                                                                                        |
| 字段短名                | 公共头与样式用 1–2 字母键，值保持可读的枚举字符串                                                                                                                                                                                                                     | 折中：键名每对象省约 60 字节；值不缩写，日志里仍看得懂。类型定义里有完整注释，调试时经 `decode` 看到的是长名对象                                                          |
| 对象 id 缩短            | 白板对象 id 用 12 位 base62 随机串（约 71 bit），不再是 36 位 uuid                                                                                                                                                                                                    | 每对象省 24 字节，Y.Map 的键同样变短；`references.id` 仍是 uuid（它是 `ContextLink.id` 和导出文件名，`model.ts:150-151`）                                                 |
| 整体二进制 / 整体再压缩 | **不做**                                                                                                                                                                                                                                                              | 列是 TEXT、接口要求字符串、core 要拆 `items` 数组进 Y.Map；整体压缩会把这些全打断。传输层是否已有压缩待核实                                                               |

体积估算（墨迹为主的板）：

| 样本                                                                                                  | v2       | v3          | 比例        |
| ----------------------------------------------------------------------------------------------------- | -------- | ----------- | ----------- |
| 一条 1,000 点的手写长线                                                                               | 30–44 KB | 3–7 KB      | 约 1/6–1/10 |
| 一个几何形（无标签、缺省样式）                                                                        | 约 190 B | 约 75 B     | 约 2/5      |
| 现行设计压测样本：300 条墨迹 = 186,358 B（`canvas-react-flow.md` 第 720 行；合成短笔画，约 620 B/条） | 186 KB   | 估 30–40 KB | 约 1/5      |

以上除第三行的 v2 值外都是按格式推算，未实测；B1 的编解码测试里要落一组固定样本作为体积基准。

### 3.3 Y.Doc

结构不变：`whiteboard: Y.Map<itemId, string>` 每项一条 JSON 串，按对象粒度 LWW（`apps/web/src/realtime/doc.ts:314-339`）。v3 让每条串变小，移动一条墨迹从「重写 30–40 KB」变成「重写 3–7 KB」，且 resize 不再重写点集。

评估过但**不建议**的调整：把墨迹点集拆到单独的根（写一次、之后只改几何头）。它需要 core 的外壳合成逻辑（`core/realtime/doc.ts:273-288`）与契约 §16.1 一起改，而 v3 已经拿到了大部分收益（§8 Q7）。

要改的只有页面这一侧：`realtime/doc.ts` 写入时调 `encodeItem`、读回时调 `decodeItem`（现在是 `JSON.stringify` / `itemSchema.parse`）。

### 3.4 core、契约与文档

| 位置                                                  | 改动                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/desktop/src/core/**`                            | 无（不透明字节 + 外壳不变）                                              |
| 数据库迁移                                            | 无                                                                       |
| `packages/shared/src/domain/boards.ts:62-82`          | 只改注释里的文档出处                                                     |
| `docs/contracts/core-json-api.md` §16.1               | 若正文写了 `engine` / `version` 的具体取值则同步（待核实）；结构描述不变 |
| `docs/design/canvas-react-flow.md`                    | 实施完成后移入 `docs/history/`，新设计文档取代                           |
| `apps/web/src/canvas/whiteboard/{model,serialize}.ts` | 常量改 v3；`model.ts:163-181` 的 `legacy` 记账位删除（从未有代码写它）   |

### 3.5 旧数据

- 存量 v2 白板：打开即空，下一次保存覆盖。节点与连线在表里，不受影响。
- 实时板的持久化 Y 状态里残留的 v2 对象串：读回时解码失败即忽略，并在同一次事务里删掉（否则它们会一直占着文档；待核实现有 `readRemote` 对校验失败的条目是否已经是忽略）。
- 新旧客户端同连一块实时板：旧客户端认不出 v3 对象、新客户端认不出 v2 对象，外壳的 `version` 会互相覆盖。靠统一版本号约束（桌面、服务器、手机同号）；是否已有按版本拒绝连接的闸待核实，没有的话在 B4 补一个最小版本检查。

## 4. 现有代码的去向

| 去向                                             | 文件（行数）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **删除**（库胶水，约 4,400 行）                  | `flow/use-flow-nodes.ts`(366)、`flow/use-flow-viewport.ts`(368)、`flow/flow-options.ts`(107)、`flow/flow-context.ts`(81)、`flow/drafts.ts`(126)、`sync/project.ts`(391)、`flow/Minimap.tsx`(435)、`flow/minimap-links.ts`(166)、`flow/nodes/ConnectionHandles.tsx`(147)、`flow/use-connect-end.tsx`(145)、`flow/nodes/stable-resize.ts`(46)、`whiteboard/nodes/ItemFrame.tsx`(169)、`whiteboard/nodes/{Ink,Shape,Line,Image,Text}Node.tsx`(456)、`whiteboard/tools/DraftPreview.tsx`(107)、`whiteboard/tools/use-item-drag.ts`(76)、`whiteboard/tools/use-tool-pointer.ts`(254)、`interaction/touch-create.ts`(346)、`escape-to-select.ts`(51)、`interaction/wheel-zoom.ts`(76)、`flow/edges/edge-scene.ts`(108)、`whiteboard/raster.ts`(355)；另有 `styles/canvas.css` 里针对库类名的规则、`vite.config.ts:126-130` 的分块组、`nodes/browser/pool.ts` 的排序部分 |
| **搬进 `core`**（纯函数，基本原样，约 3,800 行） | `geometry.ts`(329)、`whiteboard/geometry.ts`(289)、`zoom.ts`(94)、`viewport.ts` 的通用部分、`whiteboard/ink.ts`(232)、`flow/edges/{route,nudge,smooth,edge-label,edge-router}.ts`(1,890)、`whiteboard/tools/draft.ts`(232)、`store/canvas/history.ts`(458，泛化)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **留在应用**（产品逻辑，不动或只换调用）         | 菜单、分享、拖放与外部内容、内容引用、Frame 绑定、派生边、整理排布（`tidy.ts` 960 行是自有算法，不依赖库）、Mermaid 导入、样式面板、放置规则、`whiteboard/store.ts`、`sync/merge.ts`、保存队列                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **新写·应用侧**（约 1,200 行）                   | `board-adapter.ts`（store ↔ 引擎）、种类注册表（card / group / 五种白板对象 / link / reference）、节点与分组的宿主组件、连线 SVG 组件、意图处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 5. 体积与代码量

### 5.1 包体积

| 项               | 现在（min / gzip） | 之后                         | 说明                                                                                                 |
| ---------------- | ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| 现有库分块       | 187.7 KB / 60.2 KB | 0                            | 含 `@xyflow/react`、`@xyflow/system`、9 个手势与插值包、`classcat`、库自带状态库                     |
| 现有库样式       | 15.4 KB / 2.6 KB   | 0                            |                                                                                                      |
| `@armadra/board` | 0                  | 估 40–50 KB / 13–16 KB       | core 约 4,500 行 + dom 约 2,650 行 + react 约 500 行；其中约一半是从应用包搬过来的，应用主包相应变小 |
| **净变化**       | —                  | **约 −140 KB / −45 KB gzip** | 未压缩的桌面包约 −280 KB                                                                             |

对比口径：同一次构建里 `index` 主块 644.9 KB / 203.8 KB gzip，另有数个 MB 级的懒加载块。**体积收益是真实的，但不是做这件事的主要理由。**

### 5.2 另外两个依赖

| 依赖               | 现状                                                                                                                                                    | 建议                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dagrejs/dagre`   | 只有 Mermaid 导入用（`whiteboard/mermaid/layout.ts:1`），整条链懒加载（`layout.ts:17`、`tools/ToolLayer.tsx:47`），不影响首屏；画布自己的整理排布不用它 | **不在本次范围**。它不是画板底层能力。若要去掉，可评估用 `tidy.ts` 的分层能力替代（待核实其是否覆盖有向分层），另开 Issue                                   |
| `perfect-freehand` | `whiteboard/ink.ts:183` 一处调用；ESM 源文件 8 KB                                                                                                       | 先保留，收在 `core/shapes/ink.ts` 的 `outline()` 之后，引擎其余部分零依赖。最后一批再决定是否自写一个约 150 行的变宽轮廓替换（需要并排对比笔迹观感，§8 Q4） |

### 5.3 代码行数

| 区域                                   | 现在      | 目标                                                                                                                           |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/canvas/`（非测试）       | 23,342    | ≤ 17,000                                                                                                                       |
| `apps/web/src/store/canvas/history.ts` | 458       | ≤ 150（只剩转换与代理）                                                                                                        |
| `packages/board/src/`（非测试）        | 0         | ≤ 7,600（core ≤ 4,500、dom ≤ 2,650、react ≤ 500；B2 实测输入与手势约 1,200 行，dom 由 2,000 上调，门面与缺省反馈后再到 2,650） |
| 合计                                   | 约 23,800 | ≤ 24,150                                                                                                                       |

**总行数基本持平。** 变化在结构：约三成画布代码落进一个不认识产品概念、可在 Node 里单测的包；应用侧的画布目录缩小约 27%；112 个提到库内部细节的文件降到 0。

行数预算写进 `node scripts/check.mjs` 之类的检查里做护栏（超预算要在 PR 里说明），避免引擎膨胀。

## 6. 实施拆解

每批一个 PR、每个模块一个提交、先建 Issue（中英双语）、CI 绿后 merge commit 合并。

### 6.1 批次

| 批                        | 范围                                                                                                                                                                                                                                         | 依赖               | 可并行                                                                 | 验收                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0 骨架与基线**         | 建 Issue；`packages/board` 包骨架与三个入口；行数 / 体积预算检查；录一份现状基线（30 节点 + 300 墨迹的 fps、堆、白板字节数、分块大小）；把本文定稿进 `docs/design/`（已完成）                                                                | —                  | —                                                                      | `pnpm -r typecheck`、`pnpm -r test` 绿；基线数据入文档                                                                                                              |
| **B1 core**               | 四个模块各一个提交：①`math` + `camera` + `spatial` + `hit`；②`scene` + 预览事务 + `history`；③`codec/v3` + `ink-pack`（含固定样本体积测试）；④连线路由搬入（输入改为 `Scene`）                                                               | B0                 | 四个模块可由四个执行者并行（互不 import，只共用 `math`，先合 ①的类型） | 纯 Node 单测，不用 jsdom；现有 `route` / `nudge` / `smooth` / `edge-label` / `history` 的测试原样搬过来全绿；编解码往返与体积基准                                   |
| **B2 dom + 独立演示**     | 输入路由、手势（pan / pinch / marquee / drag / resize / connect）、三层渲染、`paint`、缩略图、`Board` 门面；`showcase/sections/canvas.tsx` 改成用 `createScene()` 的独立演示（不碰 `canvas-store`）                                          | B1                 | 手势与渲染可两人并行                                                   | 展示页在真实浏览器里：平移 / 缩放 / 框选 / 拖动 / resize / 连线 / 画笔全可用；这一页不 import 任何应用状态（独立性验收）                                            |
| **B3 接入应用（开关后）** | `react` 绑定；`board-adapter`；节点与分组宿主；偏好 `canvas.engine: "current" \| "next"`（缺省 `current`，设置页不露出，经调试开关或本地存储切换）；`next` 下：节点 / 分组显示、选择、拖动、换父、resize、最大化、视口命令、居中、锁定、只读 | B2                 | —                                                                      | 现行设计 §6.3 的浏览器清单里与节点、视口相关的条目在 `next` 下逐条过；终端清单（点击、滚轮、⌘滚轮、输入法、复制粘贴）全过；内嵌网页节点拖动 / 增删 / 层级变化零重载 |
| **B4 连线、叠加层与协作** | 连线 SVG、引用边、派生边与子代理卡片、Frame 绑定徽章、他人光标与跟随、评论钉、缩略图接状态配色；画布外十处依赖换成新 hook；实时板最小版本检查（若缺）                                                                                        | B3                 | 连线与协作叠加层可并行                                                 | 连线路由与现状逐像素一致（同一组节点位置下折线点相同，用现有测试夹具）；双窗口实时板：光标、选区、跟随、撤销                                                        |
| **B5 白板对象与 v3**      | 五种对象的种类注册与绘制；绘图工具改为引擎 `Tool`；文字编辑覆盖层；样式面板、剪贴板、PNG 导出改走 `board.rasterize`；触屏长按 / 双击识别器；**序列化切到 v3**（独立提交，可单独回退）                                                        | B3（与 B4 可并行） | 绘制与工具可并行                                                       | 白板清单全过；导出 PNG 与屏幕并排比对；v3 样本体积达到 §3.2 的估算；300 墨迹板字节数入文档                                                                          |
| **B6 切换与清理**         | 手机 390×844 与 iOS 真机；打包桌面；30 节点压力；缺省改为 `next`；删除 `@xyflow/react`、`flow/` 旧胶水、库样式与分块组、`pool.ts` 排序部分、三个展示页的旧用法、`test-support` 里的库包装；更新第三方声明；旧设计文档移入 history            | B4、B5             | —                                                                      | 见 §6.2；全树 `grep "@xyflow"` 为 0；分块与行数达到 §5 目标                                                                                                         |
| （可选）B7                | 自写墨迹轮廓替换 `perfect-freehand`                                                                                                                                                                                                          | B6                 | —                                                                      | 并排观感对比通过才合                                                                                                                                                |

依赖图：`B0 → B1 → B2 → B3 → (B4 ∥ B5) → B6`。

### 6.2 验收口径

| 类别        | 标准                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元测试    | `packages/board` 的 core 行覆盖 ≥ 90%，Node 环境运行；应用侧现有画布测试中与库无关的全部保留，与库相关的（用 `test-support` 起库实例的）改用内存场景重写                                                                      |
| 真实浏览器  | 现行设计 §6.3 清单全量重跑（Chrome）；本机验证，不依赖 CI 跑端到端                                                                                                                                                            |
| 打包桌面    | 不签名构建，`ARMADRA_DATA_DIR=/tmp/…` 隔离数据目录；标题栏按钮与拖拽区用真实 HID 点击验证（脚本化点击会绕过原生拖拽区）；画布顶部工具簇不被拖拽区吞点击                                                                       |
| 30 节点压力 | 与现行设计 §6.5 同一场景同一机器：空闲、平移 10 秒、拖一个节点 6 秒。平均 fps 不低于基线的 95%（基线 120 / 112 / 108），大于 33.4 ms 的帧不多于基线，JS 堆不高于基线（124–175 MB）；另加 30 个**活的**终端会话的空闲 CPU 对比 |
| 手机        | Chrome 设备模式 390×844 + iOS 真机：单指平移、双指捏合、长按出菜单、双击新建、竖屏 Dock 工具全开、无横向滚动；手写笔压力（有设备则测）                                                                                        |
| 体积        | §5.1 与 §3.2 的数字实测后回填本文                                                                                                                                                                                             |

### 6.3 回退策略

| 层面        | 回退办法                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 渲染 / 交互 | B3–B5 期间两套并存，`canvas.engine` 一键切回；两套读写同一个 `canvas-store`，切换不丢数据。B6 合并前至少带开关发一个版本给自己日用（§8 Q10）                  |
| 存储 v3     | 独立提交，可单独 revert；但**已经以 v3 保存过的板在回退后的构建里是空白**（不迁移规则的对称后果）。因此建议 v3 提交排在 B5 的最后，且与缺省切换同一个版本发出 |
| 整体        | B6 删旧依赖是不可逆点；在它之前，放弃整个方案的成本是删掉 `packages/board` 与适配器，应用主路径未被改动                                                       |

## 7. 风险

| #   | 风险                                                                                                                                                                                                                                    | 影响                                         | 缓解                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | **输入手势在各平台不一致**：触控板捏合（`ctrlKey` wheel）与真 Ctrl+滚轮的区分、Safari 的 `gesture*` 事件、iOS 触屏的系统手势与长按、手写笔、指针捕获丢失、终端 / 输入法 / 内嵌网页拿着焦点时的滚轮与按键、Electron 窗口失焦后的悬空手势 | 平移缩放手感回归；最坏是终端里点不动、滚不动 | 所有手势是纯状态机，事件序列可录制回放做单测；B3 先只接节点与视口，把终端清单跑完再往下；开关并行期自己日用；`pointercancel` / `lostpointercapture` / `blur` 一律走 `cancel()` |
| R2  | **Canvas2D 的显示质量与重绘成本**：文字折行（中日韩、emoji、字体晚到）、高分屏大画布连续平移的填充成本、主题切换重绘                                                                                                                    | 文字对象观感下降；4K 屏平移掉帧              | 文字用同一 `layoutText` 并在 `document.fonts.ready` 后重排；`Path2D` 缓存 + 视口裁剪；掉帧时启用「手势期间 CSS 变换、停手重绘」；文字若不过关退为世界层 DOM（§8 Q6）           |
| R3  | **层级语义变化**：白板对象从「与节点共用一个 zIndex 空间」变成「下带 / 上带两档」，不能任意夹在两个节点之间                                                                                                                             | 个别板的遮挡关系与现在不同                   | §8 Q1 已决定采用两档；「置顶 / 置底」动作映射为换带                                                                                                                            |
| R4  | **v3 切换清空已发版用户的白板内容**；新旧客户端同连实时板互相覆盖外壳                                                                                                                                                                   | 用户感知为数据丢失                           | 按规则不迁移，但发版说明里写明；统一版本号 + 最小版本检查；§8 Q2 已确认按规则清空                                                                                              |
| R5  | **投入产出**：体积与行数收益小，主要收益是结构性的                                                                                                                                                                                      | 做完后「看起来没变」                         | 以 §1.3 的 9 处补丁删除、独立演示页、存储体积三项作为可见成果；B2 结束时做一次是否继续的检查点                                                                                 |
| R6  | 撤销语义在泛化过程中走样（远端删除后本地撤销、文字合并会话、刚建即弃的文字对象）                                                                                                                                                        | 撤销出现意外复活或丢步                       | 现有 `history` 与 `realtime/undo` 的测试全量搬迁，行为不许改                                                                                                                   |
| R7  | 无障碍：自绘对象没有 DOM，读屏不可见；现状已关闭库的键盘无障碍（`FlowWorkspace.tsx:507`），节点仍是 DOM                                                                                                                                 | 白板对象对读屏不可见（现状是可见的空壳）     | 画布容器保留 `aria-label`；白板对象的文字内容是否需要镜像一份隐藏 DOM 待核实                                                                                                   |
| R8  | 并行批次在适配器与种类注册表上冲突                                                                                                                                                                                                      | 合并冲突                                     | B4 / B5 各自只加注册项，不改公共文件的既有行；公共接口在 B3 冻结                                                                                                               |

## 8. 已定决策

> 2026-11-15 已决定：Q1–Q12 全部按「决定」列执行（Armadra#952）。

| #   | 问题                                                           | 选项                                                                                                                    | 决定                                                                           |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Q1  | 白板对象与节点的遮挡关系                                       | A. 两档：缺省画在节点下面，「置顶」后画在所有节点上面；B. 保持现在的任意穿插（则白板对象必须留在 DOM，Canvas 方案作废） | **A**。与「背景画板」的定位一致，也是 Canvas 方案成立的前提                    |
| Q2  | v3 上线时存量白板内容直接清空                                  | A. 按既定规则清空，不写任何兼容；B. 例外写一个一次性读取器                                                              | **A**，这次影响的是已发版（0.17.x）用户的真实白板，与 2026-09 那次未发版时不同 |
| Q3  | 引擎放在哪                                                     | A. `packages/board`；B. `apps/web/src/board/`                                                                           | **A**（§2.1）                                                                  |
| Q4  | `perfect-freehand`                                             | A. 保留；B. 最后一批自写替换；C. 一开始就自写                                                                           | **A，B7 再评估 B**。它只有 8 KB、纯函数，先不为它冒笔迹观感的险                |
| Q5  | `@dagrejs/dagre`（仅 Mermaid 导入）                            | A. 不在本次范围；B. 一并自研                                                                                            | **A**                                                                          |
| Q6  | 文字对象怎么显示                                               | A. Canvas 绘制 + 编辑时覆盖 `Textarea`；B. 文字留在 DOM 世界层                                                          | **A**，B5 里做并排对比，不过关就退 B（代价是文字不能被形状遮挡）               |
| Q7  | Y.Doc 结构                                                     | A. 不变；B. 墨迹点集拆到独立根                                                                                          | **A**（core 与契约零改动）                                                     |
| Q8  | 触屏平移惯性                                                   | A. 不做（现状也没有）；B. 做                                                                                            | **A**                                                                          |
| Q9  | 连线画在哪                                                     | A. SVG；B. Canvas                                                                                                       | **A**（保留 CSS 取色、提示与流动动画）                                         |
| Q10 | 开关并行期多长                                                 | A. 带开关发一个版本、下个版本切缺省并删旧；B. 同一个版本内切完                                                          | **A**                                                                          |
| Q11 | 节点与边是否也并进一个场景文件                                 | A. 不并，继续走表；B. 并                                                                                                | **A**（邮箱级联删除与保存即 diff 的约束，`core/canvas/documents.ts:34-37`）    |
| Q12 | 借这次机会加新能力（分组裁剪子级、旋转、富文本、对象绑定箭头） | A. 不加，功能对齐现状；B. 加                                                                                            | **A**。先等价替换，新能力另开 Issue                                            |

## 9. 待核实清单

1. 传输层（HTTP / WebSocket）是否已启用压缩——影响 §3.2「整体再压缩不做」的收益判断。
2. `realtime/doc.ts` 的 `readRemote` 对校验失败的白板条目当前是忽略还是报错（§3.5）。
3. 契约 §16.1 正文是否写死了白板 `engine` / `version` 的取值（§3.4）。
4. 实时同步握手是否已有按客户端版本拒绝的闸（§3.5、R4）。
5. 现有库的点阵背景在 0.1 缩放下的观感，以及是否值得做稀疏化（§2.7）。
6. `tidy.ts` 是否具备有向分层排布能力，能否顶替 Mermaid 导入的布局（§5.2）。
7. 桌面 core 能否依赖 `packages/*`（`realtime/doc.ts:22-24` 的注释说两边各写一份结构）——决定编解码是否有朝一日能被 core 复用；本方案不依赖这一点。
8. 白板文字现在的屏幕折行与导出折行是否已经不一致（§2.7 认为合并后会一致，现状差异未实测）。
9. §5.1 的引擎体积、§3.2 的 v3 体积、§5.3 的行数均为估算，B1 / B2 结束时用实测回填。

# 会话时间线：统一模型、渐进式状态与 CLI 汇流

> 状态：已实施（B0–B8 已合并；ACP 终端内容 B9 与本批 B10 收尾进行中）。总 Issue：[AMA-Link/Armadra#422](https://github.com/AMA-Link/Armadra/issues/422)。契约见 [core-json-api §82](../contracts/core-json-api.md)（迁移 `0052_timelines`，协议 1.48 起）。
> 范围：`apps/desktop/src/core/{acp,hook,history,events,push}`、`apps/desktop/src/core/timeline/`、`apps/web/src/{acp,agent,notifications,sessions,node-observation,nodes,shared-session,timeline}`、`packages/shared/src`。
> 前置阅读：[ACP 接入与会话视图](acp-session-view.md)、[CLI 接入、通信与共享上下文](cli-collaboration.md)、[终端宿主](terminal-host-design.md)，契约 §14、§39.9、§49、§51、§81、§82。

## 结论

1. **慢主要不在起适配器，而在打开和流式输出时的全量操作。** 起会话这一段（契约 §51）已经优化过：干净 HOME 下 Claude 适配器 `initialize` 约 0.23 s，`session/new` 0.3–1.1 s。瓶颈有三处：
   - 打开会话时，页面每次都从字节 0 读完整个镜像，再整体重建列表；重连时又全读一遍。
   - 每来一个分块，core 同步写一次文件、写一次 outbox；页面整体 `setState` 一次，再把所有助手消息的 Markdown 全部重解析。300 条助手消息时每个分块约 340 ms。
   - 列表没有虚拟化，也没有 memo。
2. **统一成一份「会话时间线」，由 core 维护。** 时间线由条目（item）组成，每个条目有确定的 id，每次变更有一个递增序号（`seq`），落在 SQLite。ACP 流、终端 CLI 的 hook 和转录都归一成同一种条目、写进同一张表。各端拿到的都是「快照 + 序号之后的增量」，所以丢帧可补、重复可去（幂等 upsert）、乱序可纠正。画布节点、会话页、通知面板、状态面板、手机、分享只读页都读这一份。
3. **渐进式状态单独作为一层「活动」（activity），粗状态不改。** `agent_status` 的四态与通知分类（契约 §81）保持原样。细粒度活动由 core 在内存里算：启动各阶段、恢复历史、提交中、思考、调用工具、等审批、等输入、输出中、休眠、已退出。所有视图用共享层的同一个函数 `sessionDisplay()` 推导显示，取代原先 14 处各自的推导。
4. **内容转换在共享层只写一份 reducer，core 和页面共用。** 分块合并成消息；工具调用按 `toolCallId` 合并；diff、终端输出、计划、思考、图片、资源链接、音频转成结构化条目；连续的工具调用和思考在渲染层折成「活动组」。
5. **加载性能分四步**：打开时先读 IndexedDB 缓存，同时向 core 要最近 3 个回合和全部回合索引；页面按动画帧合并增量，行组件按条目版本 memo，Markdown 只重解析流式的最后一块；列表按回合虚拟化；历史不再依赖适配器，打开节点时直接显示时间线，适配器在后台接回。
6. **终端驱动的 CLI 汇进同一模型。** 活动来自 hook（低延迟，作「门铃」），内容来自转录尾读（按游标增量读）。粒度是整条消息，不是逐 token；界面如实体现，不伪造流式。
7. **已决定的事项**（原待定项）：时间线落 SQLite 新表；终端驱动节点的会话体由节点菜单切换；终端驱动的转录复制进库；思考正文落库、默认折叠；旧接口 `acp.update`、`acp.log` 在 B10 下线、不做兼容；节点没有人工命名时用头部 `title` 作节点名，人工改名后不再覆盖；ACP `terminal/*` 由 core 实现（B9）。详见「已决定事项」。

## §1 问题背景（实测与归因）

### §1.1 实测

| 测量                                  | 条件                                            | 结果                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 适配器冷启动                          | 临时 HOME（无账号、无插件、无 hook），每家 3 次 | `claude-agent-acp`：`initialize` 227–293 ms，`session/new` 298–1126 ms。`opencode acp`：`initialize` 1029–1358 ms，`session/new` 488–515 ms。`codex-acp` 在空 `CODEX_HOME` 下 `initialize` 后退出（要先有配置）。真实环境下 Claude 首启约 5.1 s，SessionStart hook 每多 1 s 就多 1 s |
| 本机转录体量                          | Claude 2590 个、Codex 41 个                     | Claude p50 0.47 MB，p90 2.1 MB，p99 9.1 MB，最大 55 MB；Codex p50 0.55 MB，p90 5.2 MB，最大 19.7 MB                                                                                                                                                                                  |
| 全量解析与尾读                        | 55 MB / 6973 行                                 | 全量读取并逐行 `JSON.parse` 153 ms；尾读 256 KB 只要 1 ms                                                                                                                                                                                                                            |
| Markdown 全量重渲染（每个分块付一次） | GFM，每条约 1.6 KB                              | 20 条 57 ms，100 条 154 ms，300 条 341 ms                                                                                                                                                                                                                                            |

- 打开大会话时，读镜像、`JSON.stringify` 整个应答、页面重建三步都是 O(全量)，在主线程上阻塞几百毫秒。
- 流式输出时，单个分块的渲染开销随会话长度线性增长，超过 100 条后每个分块都超过 100 ms。
- 只读分享页原先每 2 s 轮询一次 `acp.log` 并全量重建。
- 可复现的基准在 `tools/probes/acp-view-bench.mjs`（合成镜像 + 脚本化假 Agent），作为验收基线。

### §1.2 加载慢在哪

| #   | 问题                                                  | 处理                                                                                 |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| L1  | 页面读日志永远从 `after=0` 开始，重连又全量重读       | 改为 `timeline.open` + `timeline.sync(after)`                                        |
| L2  | `acp.log` 同步 `readSync` 最多 32 MiB，不分页         | 时间线分页（`open` 取尾部回合，`page` 取更早）                                       |
| L3  | 每个 `agent_message_chunk` 都 `appendFileSync` 一次   | 镜像里相邻助手分块攒成一行，条目边界、回合结束、满 32 KiB 或 300 ms 才写             |
| L4  | 每个 `acp.update` 写一行 outbox，挤占 5000 条保留额度 | `acp.update`、`timeline.delta`、`timeline.activity` 进 `EPHEMERAL_EVENTS`            |
| L5  | `tool_call` / `tool_call_update` 每次都走一遍 `apply` | 只在 reducer 眼里状态会变（或 `execute` 标题变了）才 `apply`，工具粒度变化只更新活动 |
| L6  | `session/load` 回放没有截止时间，回放期间看不到进度   | 优先 `session/resume`；回放不写条目，活动显示 `restoring` 与计数，静默 120 s 放弃    |
| L7  | 打开已有节点要等适配器接回才显示历史                  | 时间线与适配器脱钩；`acp.prestart` 支持接回已有节点                                  |
| L8  | 页面每个分块 `setState`，`items` 整体复制，行无 memo  | 帧缓冲 + `Map` 加有序 id + 按 `rev` memo                                             |
| L9  | 列表无虚拟化，Markdown 全量重解析                     | 按回合虚拟化，Markdown 分块 memo                                                     |
| L10 | 懒加载会话视图期间空白                                | `Suspense` 骨架                                                                      |
| L11 | 图片 base64 原样推给每个订阅者                        | 落成 blob，条目与事件只带引用                                                        |

### §1.3 状态缺失与不一致

缺失的阶段：恢复历史（原被并进 `session` 阶段）、思考、调用工具（哪个）、输出中、提交中；启动阶段只存在页面局部 state，别的视图、别的设备、刷新后的页面都看不到。

不一致（共 14 处推导，已统一到 `sessionDisplay()`）：

| #   | 现象                                                                              | 现在的口径                                                             |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| S1  | 侧栏把出错或被打断的 `done` 画成绿色，节点胶囊显示失败                            | 都按 `tone` 画                                                         |
| S2  | 抽屉有走不到的分支，不看 `unread`、`alive`                                        | 同上                                                                   |
| S3  | 「出错」有三种口径                                                                | `tone = failed` = 最近回合以错误结束；`need = error` = 出错且未读      |
| S4  | 节点头不看 `alive`；elicitation 在节点头没有按钮                                  | `alive === false` 时 `need` 恒空；elicitation 有按钮                   |
| S5  | 程序自报状态（OSC）只在部分视图合并                                               | 在 `sessionDisplay()` 内部合并                                         |
| S6  | 同一条件在不同处用不同色调                                                        | 统一取 `tone`                                                          |
| S7  | 铃铛轮询全部工作空间，节点和侧栏只更新当前的                                      | 统一入口                                                               |
| S8  | 推送调用 `agentHumanNeed` 不带 `alive`                                            | 推送带 `alive`，进程已死不推                                           |
| S9  | 挂起的审批有两份真相（节点头 `pendingId` 带 5 分钟 TTL，会话视图读 store 无 TTL） | 取消页面 TTL，审批过期由 core 清 `pendingId`；卡片看条目状态与 `alive` |
| S10 | 「回合在跑」有四种推导，`DONE_HOLDOFF` 在 core 与页面各算一次                     | `sessionDisplay().busy`；页面侧 `DONE_HOLDOFF` 已删                    |
| S11 | `AGENT_STATES` 在两处各有一份且值不同                                             | 只留共享层一份                                                         |

### §1.4 内容缺失与丢失（原状）

思考不进镜像、重载后丢失；计划、用量、命令、标题只在活进程内存里；工具调用的中间状态与中途 diff 只记终态；`terminal` 内容只显示一行「终端输出不可用」；工具 `content` 里的图片、资源不渲染；音频与 `resource.blob` 被静默丢弃；`rawInput` 原样贴 JSON；子代理、压缩、重试没有表示；终端驱动的 CLI 页面上没有结构化内容。这些现在都由时间线条目承载，见 §2、§3。

## §2 统一会话模型

### §2.1 时间线的键与归属

- 时间线以**会话行 id**（`terminal_sessions.id`）为键。驱动切换不换行 id，所以切换前后共用一条时间线，代次（`gen`）只记在条目上。
- **core 是唯一写者**（`TimelineWriter`）。页面、手机、远端设备只读，经快照 + 增量同步；没有并发写，不需要 CRDT。
- 来源（条目的 `source`）：`acp`（`session/update`）、`transcript`（CLI 转录尾读）、`hook`、`core`（我方提示、驱动切换、休眠、错误）、`replay`（第一次接管旧会话时 `session/load` 回放写入）。
- 时间线在会话行登记时建立，不对 `nodes` 建外键（ACP 会话先于节点落盘就会开始写）；节点不在库里且 24 小时没更新的时间线在 core 启动时清掉，连同只被它引用的 blob。

### §2.2 条目

形状定义在 `packages/shared/src/domain/timeline.ts`（zod）。公共字段 `{ id, turn, ord, kind, rev, source, at, gen }`，`rev` 等于最后一次修改它的 `seq`。

| kind          | 关键字段                                                                                                                                                                                                                                                                                                                       | id 规则（确定性，保证幂等）                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `user`        | `text`、`attachments[]`、`author`、`clientTurnId`                                                                                                                                                                                                                                                                              | ACP：`u:<turnId>`；转录：CLI 自己的消息 id                                 |
| `assistant`   | `parts[]`（`text` / `image` / `resource_link` / `resource` / `audio`）、`streaming`                                                                                                                                                                                                                                            | ACP：`a:<turn>:<n>`，被其他条目打断后 `n` 加 1；转录：`a:<记录 id>:<块号>` |
| `thought`     | `text`、`streaming`、`durationMs`                                                                                                                                                                                                                                                                                              | `th:<turn>:<n>`；转录：`th:<记录 id>:<块号>`                               |
| `tool`        | `toolCallId`、`toolKind`（ACP 十种 + `subagent`）、`title`、`status`（pending / in_progress / completed / failed / cancelled）、`locations[]`、`input`（结构化摘要）、`content[]`（`text` / `diff` / `terminal` / `image` / `resource`）、`permission`（`pendingId` 与 `outcome`）、`parentToolCallId`、`startedAt`、`endedAt` | `tool:<toolCallId>`。ACP 与转录用同一个 CLI 侧 id，自然合并                |
| `plan`        | `entries[]`（`content`、`status`、`priority`）                                                                                                                                                                                                                                                                                 | `plan:<turn>`；会话只取最近一个给顶部计划条                                |
| `approval`    | `pendingId`、`protocol`、`toolCallId`、`options[]`、`state`（pending / answered / cancelled）、`answer`、`answeredBy`                                                                                                                                                                                                          | `ap:<pendingId>`                                                           |
| `elicitation` | `pendingId`、`message`、`mode`（form / url）、`requestedSchema`、`url`、`state`、`answer`、`answeredBy`                                                                                                                                                                                                                        | `el:<pendingId>`                                                           |
| `notice`      | `code`（mode_changed / model_changed / compacted / retry / driver_switched / resumed / not_resumed / hibernated / woke / exited / error）、`params`                                                                                                                                                                            | `n:<turn>:<code>:<seq>`                                                    |
| `turn`        | `turnId`、`startedAt`、`endedAt`、`stopReason`、`error`、`permissionWaitMs`、`usage`                                                                                                                                                                                                                                           | `turn:<turnId>`                                                            |

会话级的值放在时间线**头部**（不是条目）：`usage`、`commands`、`modes`、`models`、`title`。它们与条目共用 `seq`，随增量下发、随快照恢复，core 重启后不丢。

### §2.3 操作、序号与去重

- 每次变更是一个操作：`put`（完整新值，落库的就是它）、`append`（流式文本增量）、`remove`（留墓碑 `{ id, rev, deleted: true }`）、`head`（合并头部值，字段为 `null` 即清掉）。`seq` 在同一时间线内严格递增并持久化。
- **写入合并**：`TimelineWriter` 先在内存里应用每一帧（下一帧看到的是前一帧的结果，序号连续），再攒进刷写窗口。
  - 一个回合的第一次刷写最多等 30 ms（`FIRST_FLUSH_MS`），之后每 80 ms（`FLUSH_INTERVAL_MS`）；审批 / 提问出现、回合开始与结束立刻刷写；条目切换（文本之后来了工具）在 25 ms 内刷写，两次切换刷写至少隔 25 ms（`SWITCH_GAP_MS`）。
  - 每次刷写是一个 SQLite 事务，窗口里的操作先过 `compactTimelineOps`，**写库与发 `timeline.delta` 用同一份压实结果**，所以库里条目的 `rev` 与帧里一致。
  - 内存里只留最近几个回合，更早的只在库里。
- **页面应用规则**（共享层 `applyTimelineFrame`、`applyTimelineSync`，core 与页面同一份代码）：`from === 本地 seq` 顺序应用；`to <= 本地 seq` 重复帧，丢弃；`from > 本地 seq` 有缺口，丢弃并 `timeline.sync(after = 本地 seq)`。每个操作只在 `seq` 大于目标条目的 `rev` 时生效，所以与同步应答交叠、部分重放都无害。
- **增量同步**：`timeline.sync(after)` 返回 `rev > after` 的全部条目（完整值与墓碑）加头部值（变了才带）和 `headSeq`。库里存的是最新值，任何游标一次补齐，不需要保留操作日志。`after` 超过 `headSeq` 答 `409 cursor_ahead`，页面改为重新 `open`（core 重建后序号回退时同理）。
- **流式文本合并**（`mergeStreamChunk`）：长度不足 16 个字符（`STREAM_DEDUP_MIN_CHARS`）的分块一律追加（真实流里的 `\n`、`ha` 这类短 token 会重复，去重规则会吞掉它们）；不短时，新块与已有文本相同或已有文本以它结尾，当作重复跳过；新块更长且以已有文本开头，当作快照直接替换；否则追加。
- 工具更新按 `toolCallId` 合并（`mergeToolCall`）：`content` 整体替换，`status` 只前进不后退。

### §2.4 活动（渐进式状态）

`SessionActivity`（共享层 `domain/timeline.ts`）：

```ts
type ActivityPhase =
  | "starting" // detail.step: spawn | initialize | session | configure
  | "restoring" // session/load 回放中，detail.count: 已回放条数
  | "idle"
  | "submitting" // 提示已发出，还没有第一帧
  | "thinking"
  | "tool" // detail: label（标题）、toolKind、count（并发数）
  | "awaiting_approval"
  | "awaiting_input" // elicitation / 提问
  | "responding"
  | "switching" // 驱动切换中
  | "sleeping"
  | "exited";
interface SessionActivity {
  phase: ActivityPhase;
  detail?: { label?: string; toolKind?: string; count?: number; step?: string };
  since: number;
  turnId?: string;
  turnStartedAt?: number;
  lastOutcome?: {
    kind: "done" | "cancelled" | "failed" | "refused" | "limit";
    at: number;
    error?: string;
  };
  lastOutputAt?: number; // 用于「已 N 秒无输出」
  rev: string; // `${bootId}:${n}`；compareActivityRev：bootId 不同则不可比，取后到的
}
```

- **在哪算**：`core/timeline/activity.ts` 的 `ActivityTracker`，只在内存里。输入有三类：时间线写入（文本、思考、工具状态、审批）、会话生命周期（启动、恢复、休眠、退出、切换）、hook（终端驱动时）。只在阶段或细节真的变了才发 `timeline.activity`（文本流里的分块不发）。`GET /api/workspaces/{id}/sessions` 每行带可省的 `activity` 与 `timelineSeq`，冷启动与重连从这里补；core 重启后没有记录的，按会话行补：进程活着 `idle`，休眠 `sleeping`，其余 `exited`。
- **转移规则**：提示 → `submitting`；思考 / 文本 / 工具在流 → `thinking` / `responding` / `tool`；工具全部结束回到最近的文本或思考阶段；审批答复后回到先前阶段；回合结束 → `idle` 并写 `lastOutcome`；启动、恢复、切换、休眠、退出由生命周期覆盖内容推导。优先级：`awaiting_approval` > `awaiting_input` > `tool` > `responding` > `thinking` > `submitting`。
- **与四态的关系**：`agent_status.state` 仍由 `hook/reduce.ts` 计算，语义不变，通知、推送、投递门照旧用它；活动是更细的一层投影，两者在 `sessionDisplay()` 里汇合。

### §2.5 统一显示：`sessionDisplay()`

`packages/shared/src/session-display.ts`：

```ts
sessionDisplay(input: {
  status?: DisplayStatus; activity?: SessionActivity;
  alive?: boolean; sleeping?: boolean; program?: ProgramStatus; unread?: boolean;
}): {
  tone: StatusTone;   // working | attention | failed | queued | paused | unread | idle | done
  phase: ActivityPhase | "unknown";
  labelKey: string;   // i18n 键，如 status.tool、status.awaitingApproval
  detail?: string;    // 工具标题等，截到 60 字
  need: HumanNeed | null; // 即 agentHumanNeed 的结果；通知、铃铛、推送都用它
  busy: boolean;      // 回合进行中
  since?: number;
  progress?: number;  // 程序自报的进度（0–100）
}
```

- `alive === false` 时 `need` 恒空、`busy` 为假；生命周期阶段（启动、恢复、切换、休眠、退出）进程死了也照实显示。
- 程序自报状态只在没有活的上报（也没有活动）时才画。
- 页面侧入口是 `apps/web/src/agent/display.ts`：把会话行、时间线活动、节点头三份输入喂给它，再映射成胶囊、光晕、通知色调。节点头、侧栏、小地图、抽屉、铃铛、系统通知、推送都走这一条。`apps/web/src/agent/display-consistency.test.ts` 用 175 格矩阵断言各视图一致。

### §2.6 恢复语义

| 场景             | 行为                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面首次打开     | 先订阅工作空间事件并缓存 `timeline.*` 帧，再 `timeline.open`（尾部 3 个回合 + 回合索引 + 头部值 + `headSeq` + 活动）。缓存帧里 `to <= headSeq` 的丢掉，其余按 §2.3 应用                                                                                                                                                                                                      |
| 有本地缓存       | 先用 IndexedDB（库 `armadra-timeline`）渲染，命中时只发 `timeline.sync(after = cache.seq)`，不发 `open`。按 `(sourceId, timelineId)` 分键，LRU 保留 64 条或 128 MiB，先到为准；缓存读写失败一律静默                                                                                                                                                                          |
| 断线重连         | 工作空间事件流按 `lastEventId` 续订；时间线不依赖续订，重连后各活跃时间线发一次 `sync(after = local.seq)`                                                                                                                                                                                                                                                                    |
| core 重启        | 时间线在 SQLite 里不丢；活动重建。上一个进程留下的没有收尾的 ACP 回合记 `cancelled`：挂起的审批与提问变 `cancelled`，流式条目收尾，跑着的工具记 `cancelled`，回合条目写 `endedAt` 与 `stopReason = cancelled`，并发 `timeline.delta`                                                                                                                                         |
| 适配器回放       | 时间线非空时优先 `session/resume`（不回放）；只能 `session/load` 的，回放不写条目，活动显示 `restoring` 与已回放条数（每 25 帧报一次），静默 120 s（每帧重新计时）放弃接回、新开会话并记 `notice(not_resumed)`（`resumeError.code = acp_resume_failed`）。时间线为空（第一次接管旧会话）时回放经 reducer 写成 `source = replay` 的回合（每个 `user_message_chunk` 开一回合） |
| 驱动切换         | 同一条时间线，写 `notice(driver_switched)`（切换期间活动 `switching`）。终端驱动期间由转录来源写，ACP 驱动期间由 ACP 写；两边用同一套 id 规则，CLI 侧 id 一致时不重复                                                                                                                                                                                                        |
| 多端同时看       | 所有端吃同一个 `seq`；审批条目与 `agent_status.pendingId` 在同一次刷写里改                                                                                                                                                                                                                                                                                                   |
| 没有时间线的会话 | `timeline.*` 答 `404 not_found`，会话列表没有 `activity`。页面按**会话**判断，退回旧适配层（见 §7「旧路径」）；不按协议 minor 判断                                                                                                                                                                                                                                           |

## §3 内容类型与渲染映射

渲染组件在 `apps/web/src/timeline/view/`（`TimelineView`、`VirtualTurnList`、`ActivityLine`、`PlanBar`、`ActivityGroup`、`rows/*`、`parts/*`），只用 `apps/web/src/ui/` 里的 shadcn 组件。

### §3.1 映射表

| 来源                                          | 条目 / 部件                                  | 渲染                                                                                                             |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 我方提示、`user_message_chunk`                | `user`                                       | 右侧气泡，纯文本加附件缩略图                                                                                     |
| `agent_message_chunk` 文本                    | `assistant.parts.text`                       | Markdown（GFM）。已完成的块逐块 memo，只重解析最后一块；代码块带复制按钮                                         |
| `agent_message_chunk` 图片                    | `parts.image`                                | 缩略图，点开大图；数据存成 blob，事件里只带 `blobId`                                                             |
| `resource_link`                               | `parts.resource_link`                        | 一行：按 MIME 选图标、名称、打开                                                                                 |
| 内嵌 `resource`                               | `parts.resource`                             | 有文本：可折叠代码块，标题是文件名；只有 blob：同 `resource_link`，可下载                                        |
| `audio`                                       | `parts.audio`                                | 一行附件，展开后是原生 `<audio controls>`                                                                        |
| `agent_thought_chunk`                         | `thought`                                    | 默认折叠：「思考 · 12 s」，展开是 Markdown；流式时标题带 `Spinner`；正文被服务端隐去的显示「已隐藏」             |
| `tool_call` / `tool_call_update`              | `tool`                                       | 一行：kind 图标、标题、文件胶囊（最多 2 个 + N）、状态胶囊、耗时；展开看输入与输出                               |
| 工具 `content.diff`                           | `tool.content.diff`                          | 复用 `acp/DiffBlock`（超过 200 行折叠）                                                                          |
| 工具 `content.terminal`                       | `tool.content.terminal`                      | 命令行、退出码、输出尾部；ANSI 颜色用自写小解析器（`view/ansi.ts`），只认 SGR 16 / 256 色，不加依赖              |
| 工具 `content.content`                        | `tool.content.*`                             | 文本按语言识别做代码块；图片、资源同上；不再退回原始 JSON                                                        |
| `rawInput`                                    | `tool.input`                                 | 按 kind 结构化：execute 显示命令，read / edit 显示路径和行号，search 显示查询，fetch 显示 URL，其余折成键:值列表 |
| 连续的工具、思考                              | 活动组（渲染派生，不存储，`activityGroups`） | 折成一行摘要「读了 5 个文件 · 改了 2 个 · 运行 1 条命令」，展开看明细；回合进行中保持展开                        |
| `plan`                                        | `plan`                                       | 会话顶部计划条显示当前项和进度，点开是清单                                                                       |
| `request_permission`                          | `approval`                                   | 卡片内联在对应工具行下面，答复后收成一行「已允许（一次）· 谁」                                                   |
| `elicitation/create`                          | `elicitation`                                | `ElicitationCard`                                                                                                |
| `current_mode_update`、`config_option_update` | `notice`                                     | 居中一行小字                                                                                                     |
| `usage_update`、`available_commands_update`   | 头部值                                       | 输入框旁用量环；`/` 命令选择                                                                                     |
| `session_info_update`                         | 头部 `title`                                 | 见「已决定事项」Q5                                                                                               |
| stopReason、错误                              | `turn`                                       | refusal 用 Alert，cancelled / max\_\* 居中一行；出错显示 Alert 加重试                                            |
| 子代理                                        | `tool(kind=subagent)`                        | 嵌套的活动组，默认折叠                                                                                           |
| 压缩、重试、驱动切换、休眠                    | `notice`                                     | 居中一行                                                                                                         |

### §3.2 体量上限（core 写入时执行）

- 文本条目不截断。
- 工具输出：单个 `text` 或 `terminal` 部件只留尾部 64 KiB，带 `truncated` 与原长度。
- diff 每份最多 1 MiB，超过只记路径与增删行数。
- 图片、音频与内嵌资源按内容寻址存 `<数据目录>/timeline/blobs/<sha256>`（0600），条目与事件只带 `{ blobId, mimeType, bytes }`；单个超过 8 MiB 的不存，部件记 `dropped`。读以 `timeline_blobs` 为准，只有这条时间线登记过的 blob 读得到，别的 blobId 一律 `404`。
- 镜像（`.acp.jsonl`）在 B10 之前照旧写，但按 §1.2 的 L3 批量写。

## §4 加载性能

| 层         | 措施                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首屏       | 节点或会话页一挂载就读 IndexedDB 缓存渲染（无缓存显示骨架）；同时 `timeline.open` 只取尾部 3 个回合（`TAIL_TURNS`）加回合索引。目标：有缓存 ≤ 100 ms，无缓存本机打开 300 回合会话 ≤ 300 ms                                                                                                              |
| 不等适配器 | 时间线显示与适配器接回脱钩；打开已结束的 ACP 会话时内容立刻可见，输入框可用，第一条提示在接回后发出（沿用契约 §51 的排队）。节点进入视口或获得焦点时 `POST /api/acp/prestart` 带 `nodeId` 预启动，之后该节点接回会话时领走预启动的适配器                                                                |
| 分页       | 回合索引每项 `{ turnId, turn, startedAt, endedAt, headText(80 字), counts }`；滚到距顶部 800 px（`NEAR_TOP_PX`）时取上一页 5 个回合（`PAGE_TURNS`），锚点补偿不跳屏                                                                                                                                     |
| 虚拟化     | `@tanstack/react-virtual` 按回合虚拟化，ResizeObserver 量高；距底 ≤ 24 px（`FOLLOW_DISTANCE_PX`）时贴底跟随，否则保持阅读位置并显示「回到底部」                                                                                                                                                         |
| 增量渲染   | 帧缓冲：一个动画帧内的 `timeline.delta` 合并成一次 store 提交（兜底 250 ms，待处理帧上限 1000）；条目以 `Map<id, item>` 加有序 id 数组存储，没有新增 / 删除 / 挪位的帧复用上一次的 `order`；行组件以 `item.rev` 做 memo；Markdown 只重解析流式的那一块。目标：每个分块主线程开销 ≤ 4 ms，与会话长度无关 |
| core 写入  | 合并刷写（§2.3），每个回合的 SQLite 写入从「分块数 × 2」降到「刷写次数」；`timeline.*` 与 `acp.update` 不进 outbox                                                                                                                                                                                      |
| 回放       | 优先 `session/resume`；只能 `load` 的显示 `restoring` 并计数，静默 120 s 截止                                                                                                                                                                                                                           |
| 缓存       | 页面：IndexedDB 存快照与 `seq`，LRU；core：回合索引按 `head_seq` 缓存                                                                                                                                                                                                                                   |
| 预热       | 保留契约 §51 的预热；对最近 24 h 内用过的 Agent 在空闲时预热（`AcpWarmer`）                                                                                                                                                                                                                             |
| 手机       | 同一份页面代码；事件里不带 base64，blob 按需取，首屏只取 3 个回合                                                                                                                                                                                                                                       |

## §5 CLI 驱动的数据来源与映射

### §5.1 机制

实现在 `core/timeline/sources/`。

- **hook 作门铃**：`POST /hook/{agentId}` 算完四态之后，管理器把事件映射到活动（`hook-activity.ts`）：提示 → `submitting`；工具开始 → `tool`（`label` 为「工具: 输入摘要」，最长 60 字；提问类工具 → `awaiting_input`）；工具结束 → `thinking`；审批 / 通知 → `awaiting_approval`；`Stop` 系 → `idle` 加结局。同时让尾读器 20 ms 后读一次转录、300 ms 后补读一次。四态与通知分类不变；子代理事件不进活动。
- **尾读器**（`tailer.ts`）：每个活着的终端会话最多一个来源，转录路径来自 hook 上报（没有时用历史适配器的 `locate`）。
  - 游标存在 `timelines.source_cursor`（路径、偏移、inode、开头 256 字节指纹），core 重启后从游标续读。
  - 第一次只读转录尾部 2 MiB（`TAIL_BYTES`），这一段回填不推进活动层；文件被换掉或被截短时回到尾部窗口重读；单行超过 16 MiB 的整行跳过。
  - 目录 `fs.watch` 加 100 ms 去抖；监听失败退回 2 s 的 stat 轮询（只比较大小与 mtime）；监听正常时仍有 15 s 兜底轮询（网络盘等不发事件的地方）。
  - 会话行不再 `running` 的来源在 60 s 巡检里停掉。
- **转换器**：每家一个适配器（`TranscriptAdapter`），条目 id 用 CLI 自己的 id，重复读到同一条只是 upsert。未知记录类型跳过并计数。
- **非文件来源**：OpenCode 的数据在 SQLite 里，适配器自带读取器（`opencode-db.ts`），调度用 `PollRunner`（`poll-runner.ts`，与尾读器同一套节奏：监听、2 s 轮询、hook 触发）。每次只读打开、读完即关；游标 `{ s: 会话 id, t: time_updated 毫秒 }`，取 `message` 与 `part` 里 `time_updated >= t` 的行（同一毫秒重读无害，条目按 id 幂等）；第一次只读最近 60 条消息；库文件与 WAL 的大小和 mtime 一变就读。
- **粒度**：CLI 通常一条消息写完才落盘，所以助手文本按整条出现；中间过程由活动层表示。界面不伪造流式效果。
- 节点同时有 OSC 自报状态时（契约 §53），由 `sessionDisplay` 合并作兜底。

### §5.2 每家一行

| CLI                                   | 活动来源                                                                                                                                                       | 内容来源                                                               | 能拿到                                                                                                                                                                                                                                                                                                                                                        | 拿不到 / 限制                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                           | `UserPromptSubmit`、`PreToolUse`（`tool_name`、`tool_use_id`）、`PostToolUse`、`PermissionRequest`、`AskUserQuestion` / `ExitPlanMode`、`Stop` / `StopFailure` | `<configHome>/projects/<cwd 编码>/<会话 id>.jsonl`                     | 用户文本与附图；助手 `text` / `thinking` / `tool_use`；`tool_result` 与 `toolUseResult`：Bash 的 stdout / stderr / 被打断，Edit / Write 的 `structuredPatch` 转 diff；`TodoWrite` → `plan`；`usage`；`custom-title` / `agent-name` → 标题；压缩边界                                                                                                           | 逐 token 流；`isSidechain` 子代理内部调用（时间线上只有一个 `subagent` 工具）；思考被隐去时只剩空条目（显示「已隐藏」）                                                                                       |
| Codex                                 | `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`                                                                                                     | `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`                     | `response_item:message`；`reasoning` 摘要 → thought；`function_call` / `custom_tool_call` / `local_shell_call` 及输出 → tool，`apply_patch` 补丁解析成 diff；`update_plan` → plan；`task_started` / `task_complete` / `turn_aborted` → 回合边界；`token_count` → usage                                                                                        | 加密的推理正文（不建条目）；审批只能在终端里答（hook 没有审批请求事件）                                                                                                                                       |
| OpenCode                              | 插件总线事件                                                                                                                                                   | `opencode.db`（只读 SQLite，见上）                                     | `text`、`reasoning`、`tool`（pending → running → completed / error，中间状态可见）；`bash` 的输出与退出码；`edit` / `write` / `apply_patch` 的 diff（`edit` 用入参 `oldString` / `newString`，没有就解析 `metadata.filediff.patch`）；`todowrite` → plan；`step-finish` 的 `tokens` → usage；`session.title` → 标题；助手消息的 `finish` / `error` → 回合收尾 | 逐 token 流；加密推理；用户消息附件；子会话内部调用；上下文窗口大小（按 200k）                                                                                                                                |
| Pi / OMP                              | 扩展事件                                                                                                                                                       | `<agentDir>/sessions/<编码 cwd>/<时间>_<uuid>.jsonl`（路径由扩展报来） | `message`（user / assistant / toolResult）；`thinking` 块；`bash` 输出与退出码；`edit` / `write` 的 diff（从调用参数 `edits[].oldText / newText` 或 `content` 推出，没有时退到 `details.diff`）；`usage`；`stopReason` → 回合收尾；`session_info.name`（Pi）、`title` / `title_change`（OMP）→ 标题；`compaction` → 压缩提示                                  | 逐 token 流；子代理内部调用；OMP 的 `todo` 不转计划；窗口大小（按 200k）。两家共用 `PI_CODING_AGENT_DIR` 时兜底定位只在自己写的文件里挑（OMP 文件开头有 `title` 记录）                                        |
| Copilot CLI                           | `userPromptSubmitted`、`postToolUse(Failure)`、`notification`、`agentStop`、`errorOccurred`                                                                    | `${COPILOT_HOME:-~/.copilot}/session-state/<会话 id>/events.jsonl`     | `user.message`、`assistant.message`（`reasoningText` → 思考、`toolRequests` → tool）、`tool.execution_start` / `complete`；`bash` 输出与退出码；`edit` / `create` 转 diff；`session.usage_record` → usage 与窗口；`abort` → 已取消；`session.compaction_complete` → 压缩提示                                                                                  | 逐 token 流；标题（在 `workspace.yaml`）；子代理内部消息；没有「回合完成」事件，回合靠 `agentStop` hook 或下一条用户消息合上；没有 PreToolUse，但工具请求在 `assistant.message` 里出现，开始时刻反而早于 hook |
| ama（终端模式）                       | 与 Pi 同族扩展事件                                                                                                                                             | 暂无转录适配器                                                         | 只有终端画面与粗状态                                                                                                                                                                                                                                                                                                                                          | 推荐 ama 走 ACP（原生 `--mode acp`）                                                                                                                                                                          |
| Gemini CLI                            | 无（迁移 0014 已退役）                                                                                                                                         | 不接                                                                   | —                                                                                                                                                                                                                                                                                                                                                             | 若重新支持，只走 ACP                                                                                                                                                                                          |
| Antigravity / Grok / 自定义无 hook 的 | 只有 `observed` 与 OSC 自报                                                                                                                                    | 无                                                                     | 只有终端画面和粗状态                                                                                                                                                                                                                                                                                                                                          | 时间线显示「这个 Agent 不提供结构化内容」，节点体保持终端                                                                                                                                                     |

适配器按 `baseAgent` 之后的代理 id 登记（`ADAPTERS`：`claude`、`codex`、`opencode`、`pi`、`omp`、`copilot`）。

### §5.3 在哪看

- 终端驱动的 Agent 节点，节点菜单多一项「会话 / 终端」，切换节点体（`apps/web/src/nodes/node-body-mode.ts`），**不切换驱动**。会话体是只读的时间线加活动行，输入框隐藏（输入仍走终端或 `send`）；缺省是终端体。该选择只记在本机页面里，不进画布数据，每个设备自己的看法互不影响。没有转录适配器的代理，切换项不可用。
- 会话页、手机焦点页（`shell/MobileFocusPage.tsx`）、分享只读页（`shared-session/ReadOnlyTranscript.tsx`）、状态抽屉对终端驱动和 ACP 驱动一视同仁，都显示时间线。
- 投递门、`send`、上下文读取（`history/registry.ts`）都不改；时间线只是多了一个读者。转录复制进库后：权限同 `terminal:read`，不进推送正文，不进上下文读取（那条路仍读 CLI 原文件）。

## §6 契约与协议

- **契约**：[core-json-api §82](../contracts/core-json-api.md)。§82.1 四个 procedure：`timeline.open { timelineId, tailTurns? }`、`timeline.sync { timelineId, after }`、`timeline.page { timelineId, beforeTurn, turns? }`、`timeline.blob { timelineId, blobId }`（JSON 里是 base64，只放得下原始字节不超过约 786 KB 的 blob，更大的走 HTTP 路径 `GET /api/timelines/{timelineId}/blobs/{blobId}`）。§82.2 core 存储、事件、活动、blob、会话列表与恢复；§82.3 终端驱动的转录来源；§82.4 ACP 生产者与提速。
- **事件**：`timeline.delta { timelineId, nodeId, from, to, ops[] }` 与 `timeline.activity { timelineId, nodeId, activity }`，登记在 `EPHEMERAL_EVENTS`（连同 `acp.update`），不进 outbox、不占 5000 条保留额度、不做续订补发：缺口靠 `timeline.sync` 补，活动靠会话列表补。
- **存储**（迁移 `0052_timelines`）：`timelines`（`id` = 会话行 id、`workspace_id`、`node_id`、`head_seq`、`head_rev`、`source`、`source_cursor`、`head_json`）、`timeline_items`（`(timeline_id, item_id)` 一行存最新完整值与 `rev`，`deleted = 1` 是墓碑；索引 `(timeline_id, rev)`、`(timeline_id, turn, ord)`）、`timeline_blobs`（这条时间线引用了哪些 blob）。
- **会话列表**：`sessions` 每行多可省的 `activity` 与 `timelineSeq`，另有 `interrupted`（契约 §81）。
- **授权**：时间线以会话行 id 为键，路由门按会话行查出画布再判 `terminal:read`；只被授予某一条会话的人只读得到那一条；不存在的会话对成员也答 `403`。blob 的 HTTP 响应对内容类型做白名单（图片、`audio/*` 原样，其余一律 `application/octet-stream` 且 `attachment`，带 `nosniff` 与 `sandbox` CSP）。
- **ACP 客户端能力**：`terminal/*`（`terminal/create`、`output`、`wait_for_exit`、`kill`、`release`）由 core 实现，见 B9（[#444](https://github.com/AMA-Link/Armadra/issues/444)）；合并前 host 不声明 `terminal` 能力，工具行只显示「终端输出不可用」。能力声明、输出尾部上限等细节待 B9 合并后补进本节与契约。
- **旧接口**：`acp.update`（事件）与 `acp.log`（镜像读）在 B10 下线、不做兼容；在此之前它们原样保留，图片仍带原样 base64。
- **协议 minor**：本设计引入 1.48（随 `timeline.*`）；procedure 的 `since` 与 minor 同步。

## §7 UI 要点

- 极简：不加说明性文字，不中英混排，只用 `apps/web/src/ui/` 的 shadcn 组件（`no-raw-*` 测试守门）；文案进 `apps/web/src/i18n/`。
- **活动行**（`ActivityLine`）：会话体底部、输入框上方一行，`Spinner` + 阶段文案 + 细节 + 计时（「运行 · pnpm test · 12 s」）。超过 60 s 无输出追加「已 1 分钟无输出」。审批和出错不转圈，换成对应色调。
- **平滑**（`useSmoothedActivity`，`use-activity.ts`）：阶段至少持续 300 ms（`SHOW_AFTER_MS`）才显示，审批、出错、退出立即显示；一旦显示至少保持 500 ms（`HOLD_MS`）；计时每秒刷新一次。只影响显示，不影响 core 的真实状态。
- **启动阶段**：骨架屏上方是同一条活动行（连接中 → 初始化 → 开会话 → 应用设置 → 恢复历史 · 120 条）；冷启动提示沿用契约 §51 的 3 s 规则。
- 节点头胶囊、侧栏圆点、小地图描边、抽屉、铃铛全部用 `sessionDisplay()` 的 `tone` 与 `labelKey`；节点头只显示阶段词，细节在悬停 `Tooltip`。节点头的审批按钮读 `sessionDisplay().need`，elicitation 也有按钮。
- 减少动效：`prefers-reduced-motion` 时活动行不做闪烁动画。可访问性：活动行 `aria-live="polite"`，只在阶段变化时播报，计时不播报。
- **页面数据层**（`apps/web/src/timeline/`）：`store.ts`（zustand，按 `(sourceId, timelineId)` 分键）、`sync.ts`（先订阅后 open，缺口即 sync，重连即 sync，帧缓冲按 rAF 提交；缺口连续同步有次数上限）、`cache.ts`、`use-timeline.ts`、`use-activity.ts`、`api.ts`、`blobs.ts`。
- **会话视图的接线**：`acp/SessionView.tsx` 用 `acp/use-session-feed.ts` 取内容，渲染交给 `TimelineView`；`acp/store.ts` 只管投递状态（`clientTurnId`、未送达、对账）。
- **旧路径（B10 前的退路）**：`use-session-feed.ts` 在 `timeline.open` 答 `not_found`（主机没有 `timeline.*` 或这条会话还没写过时间线）时，按会话退回 `timeline/legacy-acp.ts` + `use-legacy-acp.ts`：读 `acp.log`、接 `acp.update` / `acp.turn` / `agent.approval`，喂进共享层同一套 reducer，得到与 `timeline.*` 同形的条目，所以渲染只有一条路。旧路径里一旦收到这条会话的 `timeline.delta`，就切回新路径。分享只读页在没有时间线时仍按 `acp.log` 每 2 s 读一次。终端驱动节点的只读会话内容不走旧路径（没有 ACP 镜像）。B10 下线旧接口时这些文件一并删除。

## §8 测试策略

- 共享层 reducer 做性质测试：同一组操作以任意顺序或重复投递，经「缺口即 sync」规则后结果相同；`mergeStreamChunk` 覆盖快照、重复、续写；`sessionDisplay` 表驱动测试覆盖 S1–S8。
- core：用假 ACP Agent（`acp/fixture.ts`）按剧本吐分块、工具、diff、审批、取消、崩溃，断言时间线内容、`seq` 连续、刷写次数有上限、outbox 写入不随分块数增长；`sync(after)` 对任意游标的结果与从 0 全量应用一致；core 重启后时间线完整。
- CLI 来源：每家一套手写脱敏夹具（`core/timeline/sources/fixtures/`，不拷用户数据），断言转换结果与增量续读；尾读器覆盖游标续读、文件被换或截短、监听失败退回轮询、hook 触发延迟。
- 跨视图一致性：`apps/web/src/agent/display-consistency.test.ts` 同一组输入分别经节点头、侧栏、抽屉、小地图、铃铛、推送入口，断言 `tone` 与 `need` 一致。
- 页面：乱序、重复、缺口、断线、`cursor_ahead` 重开；一个 rAF 内的 100 帧只提交一次；行 memo（rev 不变不重渲染）；1000 回合虚拟列表的 DOM 行数不超过可视行数加 overscan。
- 性能：`tools/probes/acp-view-bench.mjs` 的基准作为门槛，夜间跑，不进 PR CI。
- 端到端：`tools/probes/agent-e2e/` 的「时间线一致」场景（B10）：真 Claude 与 Codex 各跑终端、ACP 两种驱动，两台设备同时看，断线重连，比对条目。

## 已决定事项

| 编号 | 事项                 | 决定                                                                                                                                                                                                                                            |
| ---- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1   | 存储                 | SQLite 新表（迁移 `0052`）：存最新值加 `rev`，任何游标一次补齐                                                                                                                                                                                  |
| Q2   | 终端驱动节点的会话体 | 节点菜单切换节点体，不切驱动；选择只记在本机页面                                                                                                                                                                                                |
| Q3   | 旧接口退役           | `acp.update`、`acp.log` 在 B10 下线，不做兼容                                                                                                                                                                                                   |
| Q4   | CLI 内容复制         | 转录复制进库，多端一致，手机也能看；只为画布上的节点建时间线                                                                                                                                                                                    |
| Q5   | 自动命名             | 节点没有人工命名时用头部 `title`（`session_info_update.title`、Claude 的 `custom-title` 等）作节点名，人工改名后不再覆盖。core 已把标题写进头部；页面侧现有的自动命名仍走 `autoNameNode`（`suggest-title`），改读头部 `title` 的接线在 B10 补齐 |
| Q6   | 跨仓                 | `terminal/*` 由 core 实现，见 B9；是否需要先在 armadra-agent 仓给 `AcpClient` 加回调，待 B9 合并后补                                                                                                                                            |
| Q7   | 思考内容             | 思考正文落库，默认折叠                                                                                                                                                                                                                          |

## 风险与缓解

| 风险                                                               | 缓解                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 双写期（镜像 + 时间线、`acp.update` + `timeline.delta`）出现不一致 | 页面只读一条路（时间线，或按会话退回的旧路径）；镜像只给上下文读取用；B10 收尾                 |
| 数据库体积：CLI 转录内容复制进库                                   | 只为画布上的节点建时间线；第一次接管只读尾部 2 MiB；工具输出截尾；孤儿时间线与 blob 启动时清理 |
| 隐私：思考和转录的副本存进数据库                                   | 权限同 `terminal:read`；不进推送正文；分享只读页沿用会话分享范围（契约 §79）；不进上下文读取   |
| CLI 转录格式经常变（尤其 Claude）                                  | 转换器宽进，未知记录类型跳过；夹具随 `compatibility.json` 的验证版本更新；夜间 e2e 报警        |
| hook 在沙箱里连不上 core（#407 Codex）                             | 尾读器靠 `fs.watch` 与轮询兜底，不依赖 hook；活动退回 OSC 与 `observed`                        |
| `fs.watch` 在 macOS 和网络盘上不可靠                               | 监听失败退回 stat 轮询，正常时仍有 15 s 兜底                                                   |
| 远端主机版本不一致                                                 | 按会话判断：`timeline.open` 答 `not_found` 就走旧路径，直到旧接口随 B10 下线                   |
| 合并刷写增加最多 80 ms 的显示延迟                                  | 首次刷写 30 ms；条目切换与审批立即刷写；页面按 rAF 渲染                                        |
| `session/resume` 在某些适配器上行为不同                            | 按 `initialize` 声明的能力协商；e2e 每家都覆盖                                                 |

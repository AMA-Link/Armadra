# 更新记录

每个版本一节，按发布倒序。括号里是合入的 PR 编号（github.com/AMA-Link/Armadra，2026-10-11 前为 Owlbay/Armadra，旧编号照常跳转）。兼容范围以 `tools/release/compatibility.json` 为准，发布说明里的 `armadra-compatibility` 围栏由它渲染。桌面、服务器与手机 / 平板 App 共用一条版本线和一个标签 `vX.Y.Z`（规则见 `docs/guides/ci-release.md`「版本规则」）；有手机端改动的版本，在「手机与平板」小节里写，其余写在「桌面 / 服务器」下。2026-10-10 之前手机端曾单独编号（1.0.0、1.1.0），内容并入对应的 0.2.5、0.2.6。

## 未发布 / Unreleased

手机上用手指拉伸节点（会话、便签、分组、白板对象）走完整个手势并在松手时提交，电脑与 core 收到同一尺寸；以前只拉到第一帧就停住、不提交，残留的手势草稿还让这台手机此后收不到任何远端改动，直到刷新（Closes #819）。

Finger-resizing a node on the phone (sessions, stickies, frames, whiteboard items) now follows the whole gesture and commits on release, so the desktop and core get the same size. Previously it froze after the first frame and never committed, and the leftover gesture draft stopped the phone from applying any remote change until a reload (Closes #819).

Windows 会话宿主的 `welcome` 增加服务端证明（用 `session-host.key` 做 HMAC，绑定端点、协议 major 与客户端 `hello` 的 nonce），core 核对通过之前不发 `create`，抢占管道名的进程拿不到环境变量与凭据（契约 §102.6，Refs #751）。会话宿主协议 `PROTOCOL_MAJOR` 由 1 升到 2：升级当次，Windows 上仍在运行的终端会话会丢失一次，之后照常跨重启保留。

The Windows session host's `welcome` now carries a server proof (an HMAC with `session-host.key`, bound to the endpoint, the protocol major and the client's `hello` nonce), and the core sends no `create` until it verifies, so a process squatting the pipe name no longer receives environment variables or credentials (contract §102.6, Refs #751). The session-host protocol `PROTOCOL_MAJOR` goes from 1 to 2: live Windows terminal sessions are lost once at this upgrade and are preserved across restarts as before afterwards.

侧栏「这台电脑」改为列出服务端的全部工作空间（未归档的），与手机、别的设备看到的同一组；本设备的打开记录只管顺序，没打开过的先收起。此前它只列本设备打开过的，别的客户端建的、拖入的、旧版「关闭」掉的工作空间在桌面看不到，手机却能进去建画布（#817）。

The "This computer" sidebar section now lists every non-archived workspace from the server, the same set the phone and other devices see; this device's open history only orders the rows, and never-opened ones start collapsed. It used to list only workspaces opened on this device, so workspaces created, dropped in, or closed in older versions elsewhere were invisible on the desktop while the phone could still open them and create canvases (#817).

macOS 上只有默认数据目录的 core 用钥匙串：指了 `ARMADRA_DATA_DIR` / `--data-dir` 的实例（开发、探针、隔离运行）改用数据目录里的加密文件（`file-encrypted`），不再读到或覆盖真实应用的钥匙串条目；没有默认钥匙串时（如临时 HOME）密钥按不可用处理，不再弹出「找不到钥匙串」窗口（契约 §102.1，Closes #818）。hook 实例密钥的条目名定为 `armadra-hook-key`，从旧 `hook-secret` 文件迁移时以文件为准，已发出的节点令牌不受钥匙串里残留条目影响。此前在 macOS 上用非默认数据目录存过的令牌需要重新登录一次。

On macOS only the core of the default data directory uses the Keychain: instances pointed at another `ARMADRA_DATA_DIR` / `--data-dir` (development, probes, isolated runs) use an encrypted file in that data directory (`file-encrypted`) and no longer read or overwrite the real app's Keychain items; with no default keychain (e.g. a temporary HOME) secrets are treated as unavailable instead of raising the "Keychain Not Found" dialog (contract §102.1, Closes #818). The hook instance secret is stored as `armadra-hook-key`, and the migration from the old `hook-secret` file lets the file win, so issued node tokens are unaffected by leftover Keychain items. Tokens stored under a non-default data directory on macOS need one more sign-in.

手机端浮层、面板与表格不再比桌面端大得多（Closes #822）：手机竖屏与手机横屏里，Popover、菜单、Select、对话框与 Sheet、工作面板、整页焦点页和表格容器内的间距刻度统一乘 `--phone-scale`（0.8），宽、高、内边距、间隙同比缩小，版式与桌面一致；字号不变、输入框仍 16px，控件命中区不低于 28px，设置页不受影响。

Phone overlays, panels and tables are no longer oversized next to desktop (Closes #822): in phone portrait and phone landscape, the spacing scale inside popovers, menus, selects, dialogs and sheets, work panels, the full-page focus view and table containers is multiplied by `--phone-scale` (0.8), so widths, heights, paddings and gaps shrink together and the layout matches desktop; font sizes and 16px inputs are unchanged, controls keep at least a 28px hit area, and the settings dialog is untouched.

## 0.14.0（2026-11-05）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.14.0。随包 `@armadra/agent` 0.14.0（新增 Pi 的 ACP 桥 `ama --mode acp --bridge pi`）与平台协议包 0.14.0（协议仍是 1.4，没有形状变化）；配套镜像 `armadra-cloud` / `armadra-relay` 0.14.0。本版主题：连接手机只剩一张二维码（局域网与互联网装在同一张码里），ACP 提示框接管与交还的顺序修复，macOS 首次打开说明。

Version aligned with armadra-cloud and armadra-agent (all three ship 0.14.0), with `@armadra/agent` 0.14.0 (adds a Pi ACP bridge, `ama --mode acp --bridge pi`) and platform protocol 0.14.0 (still protocol 1.4, no shape changes); matching images `armadra-cloud` / `armadra-relay` 0.14.0. Themes: connecting a phone is now a single QR code carrying both the LAN and the internet route, an ordering fix for lease takeover and release in the ACP prompt box, and macOS first-launch notes.

### 桌面 / 服务器

- 连接手机只剩一张二维码（#784–#787，Closes #749）：设置里只有一个「连接手机」，对话框点开才铸码，局域网直连与互联网中转装在同一张码里，没有来源下拉；有路可连时入口才出现，手机把码用掉就收起并提示已连接；「账号与设备」里的「配对新设备」删除。core 新增 `connect.offer`（只有 owner，经中继来的浏览器答 403）与事件 `connect.used`（契约 §99）；配对票绑定 Gateway 的来源集合（迁移 0060），集合内任一来源可兑，会话绑实际来源。旧接口 `gateway.pair`、`e2e.pairingSecret` 与 `armadra://pair` 深链删除（契约 §17.3、§80.1 标已取代）。
- 二维码是网页链接（载荷 v2，`#c=…`）：手机相机扫到可直接在浏览器打开；手机并行探各直连来源取最先通的配对，直连不通转中转，账号下没有这台电脑报 `wrongAccount`；过期、新旧版本不符与走不通都带原因回连接页（#785）。
- ACP 提示框的接管与交还按发出顺序串行，交还不再先于在途的接管落地；空闲租约上的 `terminals.drive` release 作空操作，不再答 500（#789）。
- 文档：新增 macOS 首次打开说明（README 中英同步）（#781、#782）；发布指南更正未签名包的更新安装路径（#783）。
- 测试与依赖：提示用例收尾先等全部提示移出再卸载，消除 `window is not defined`（#780，Closes #779）；会话显示全组合用例给足超时（Refs #630）；`@hono/node-server` 2.1.6（#777）、`systeminformation` 5.33.19（#778）。

### 手机与平板

- 扫一张二维码连接电脑：App 内扫码器与相机解析同一种网页链接，深链只剩分享、OAuth、通知与设备码回跳，配对深链删除；扫到旧版二维码提示把电脑升级到与 App 相同的版本（#787）。

### 部署说明

- 新的数据库迁移 0060（`identity_bootstrap_tickets.origins`），core 启动时自动执行；空串表示只认原来源，旧票照旧可兑。
- 手机与电脑要一起升到 0.14.0 才能扫码连接：0.14.0 的电脑不再签发旧二维码、不再认 `armadra://pair`，0.14.0 的 App 不再解析旧二维码。已经连上的设备不受影响。
- 契约：新增 §99（`connect.offer`、`connect.used`）；§17.3、§80.1 已由 §99 取代，§24、§73 去掉 `deepLink`。
- 配套镜像 `ghcr.io/ama-link/armadra-cloud:0.14.0`、`ghcr.io/ama-link/armadra-relay:0.14.0` 与协议包 0.14.0 同号（cloud 只对齐版本，没有代码改动）；推送中继镜像 `ghcr.io/ama-link/armadra-push-relay:0.14.0` 与服务器壳镜像同号。发版顺序沿用 0.13.0：先打 Armadra `v0.14.0`，再打 armadra-cloud `v0.14.0`。

## 0.13.0（2026-11-04）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.13.0。随包 `@armadra/agent` 0.13.0（维护版，没有用户可见的变化）与平台协议包 0.13.0（协议仍是 1.4，没有形状变化）；配套镜像 `armadra-cloud` / `armadra-relay` 0.13.0。本版主题：设置整理（「账号与设备」合并页、每家 Agent 的启用开关、快捷键页与全选）、登录会话去重与清扫、ACP 会话视图改版与补齐（两行输入区、计划条、内联审批、自家画布工具免审批）、侧栏搜索与 ⌘K 共用内容索引、画布多选拖动与一键整理、手机布局（横屏铺满、竖屏一行 Dock、视口与触屏手势）、缺陷审计的修复批次与夜间 CI。

Version aligned with armadra-cloud and armadra-agent (all three ship 0.13.0), with `@armadra/agent` 0.13.0 (a maintenance release with no user-visible changes) and platform protocol 0.13.0 (still protocol 1.4, no shape changes). Themes: settings consolidation (a merged Account & devices page, per-agent enable switches, a compact shortcuts page and select-all), sign-in session dedupe and sweep, the ACP session view redesign and gap filling (two-row composer, plan bar, inline approvals, Armadra's own canvas tools auto-approved), one content index shared by sidebar search and ⌘K, canvas multi-drag and tidy, phone layout (full-screen landscape, one-row portrait Dock, viewport and touch gestures), and the bug-audit fix batches plus the nightly CI fix.

### 桌面 / 服务器

- 设置整理：「设备与会话」与「账号与安全」合并为「账号与设备」，「远程访问」只管主机，服务器壳的「账号与共享」改名「成员与共享」，每个概念只留一处；旧分区 `devices`、`#pair=` 与各抽屉的跳转都落到合并页，搜索命中会滚到对应分块（#725）。设置页按钮按下只降不透明度、不缩放，加载与检查连接时宽高不变（#728）。「默认」页在 Agent 列表到达前不改写权限模式，默认 Agent 下拉只列启用的 Agent；窄屏下设置行可换行（#756）。
- Agent 启用开关：设置 → Agent 里每家（含自定义 Agent）一个开关，关掉后不出现在画布右键、派生子菜单、Dock、命令面板、空画布与拖线菜单，配置保留（#709）。关掉的 Agent 对 Agent 也不可见、不可派发：core 设置新增 `agents.disabled`（契约 §97，只加字段），`canvas help`、`armadra-hook mcp` 的说明与 `open-agent` / `team` 的可用名单只列没关的；「接管会话」从新建菜单移到该 Agent 的设置子页；画布技能修订号 23（#775）。
- 快捷键：快捷键页改为按区域分组的紧凑列表；新增画布全选 `Mod+A`（`canvas.selectAll`，可改键）（#722）。弹层开着时挂起画布快捷键，Delete 与全选不再作用到弹层背后的画布（#752）。
- 登录会话：修复桌面页面每个访问期新建一条会话（core 回环 CORS 放行 `x-armadra-csrf`，刷新只允许一次在途），会话列表按设备归并并分页（#719）；整页重载后撤掉上一条会话，登出后在途刷新的结果作废（#762）；为本机设备配新会话时撤掉同种客户端闲置超过一个访问期的旧会话，core 启动时按同一规则清掉已有堆积，每种客户端留最近用过的一条（#774）。
- ACP 会话视图改版：两行输入区，模型与思考强度合成一个控件，去掉「⋯」菜单，工具行、思考、活动组与正文排版整理（#721）；计划条移到输入框上方，只有连续的只读读搜才归组，审批内联到工具行，位置标签与代码块复制按钮（#763）。
- ACP 补齐：Pi 会话起不来的修复（核对 CLI 最低版本 0.81.0，安装改用现行包，会话映射读对）（#720）；「接管会话」的列表限定在工作空间根目录内（此前服务器壳上的成员可列出主机上所有项目的会话），终端登录取消与超时必落定，装 Pi 前先卸旧包（#758）；Armadra 自己的 `armadra` MCP 画布工具在 ACP 会话里按来源免审批（契约 §98），工具行与审批卡本地化，输入框操作行的配置项不再连读（#773）。
- 搜索：侧栏搜索与 ⌘K 共用一份内容索引，别的工作空间、画布、节点、白板文字、文件与设置都搜得到（多词、拼音首字母与模糊匹配），回车跳过去并聚焦，每行带类型图标与右对齐标签（#771）。
- 画布：多选拖动整组跟着走，一键整理按视口横竖排成方正网格（#724）；双击空白不再留下空文字对象，空文字提交即丢弃，撤销栈里的「新建」一并抹掉（#723，实时板 #761）；资源面板的会话组用节点标题命名，进程树标出 Armadra 自己的进程（#718）。
- 协调者：跟进不再虚报「已转给」、不再转给已结束的成员，转不过去时给协调者补一行失败说明，点名多个工作项时每个成员只收点名它的句子（#755）。
- 界面细节：不自动消失的提示加关闭按钮，可用键盘关闭（#754）；窄屏布局（配对码、节点头标签、数据列表、两步验证密钥）与日期格式统一（#759）；浏览器节点启动失败按原因提示（#765）。
- 测试与 CI：夜间 Android 插桩加上限与现场抓取，被取消或超时的夜间也开 issue（#753）；高负载下偶发失败的用例改成等确定状态，镜像校验不再取外部地址（#764）；eslint 警告清零，未用变量与丢精度字面量升为错误（#765）；设计展示页拆分分区并补探针断言（#760）；发布流程的本地 tap 先 `brew trust`（#703）。

### 手机与平板

- 横屏铺满整屏、工具栏一个不缺：手机横屏走电脑布局（#726），根容器不再让出两侧安全区，侧栏改用覆盖式抽屉、默认收起（#769）。
- 竖屏 Dock 一行、从左到右横向滚动，与桌面工具一个不少（#769，取代 #726 的两行 Dock）。
- 打开画布时缩放可读（屏幕字号不低于 12px），触屏长按与双击新建（#726）；「适应」在内容放不下时对准选中的节点并保持可读缩放，打开时的视口适配不再写回文档；第二根手指、取消与长按菜单后的点击不再误建或误触（#757）。

### 部署说明

- 没有新的数据库迁移（最新仍是 0.12.0 的 0059）。core 启动时会按新规则撤掉一次本机设备上闲置的登录会话（每种客户端留最近用过的一条），日志只记数目。
- 契约只加不改：§94 资源采样的 `ProcessSample.origin`，§95 ACP 健壮性补丁，§96 桌面壳闲置会话的自动清理，§97 core 设置 `agents.disabled`，§98 自家 MCP 工具免审批与工具条目的 `mcp` 字段；§93 补跟进的措辞与失败行。
- 配套镜像 `ghcr.io/ama-link/armadra-cloud:0.13.0`、`ghcr.io/ama-link/armadra-relay:0.13.0` 与协议包 0.13.0 同号；推送中继镜像 `ghcr.io/ama-link/armadra-push-relay:0.13.0` 与服务器壳镜像同号。发版顺序沿用 0.12.0：先打 Armadra `v0.13.0`，再打 armadra-cloud `v0.13.0`。

## 0.12.0（2026-11-02）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.12.0。随包 `@armadra/agent` 0.12.0 与平台协议包 0.12.0（协议仍是 1.4，只加了 OAuth 能力位与字段）；配套镜像 `armadra-cloud` / `armadra-relay` 0.12.0，新增 `armadra-push-relay` 镜像。本版主题：手机端补齐（云主机挂载走端到端通道、横屏手机布局）、画布节点按黄金比例与点阵创建、ACP 补齐（模型与权限模式选择、登录流程、`elicitation/complete`、会话列表与接管）、协调者的工作项账本、统一事件队列与进展看门狗、远程访问以 Armadra 云为缺省、工作空间归档、推送中继镜像。

Version aligned with armadra-cloud and armadra-agent (all three ship 0.12.0), with `@armadra/agent` 0.12.0 and platform protocol 0.12.0 (still protocol 1.4, additive OAuth capability bits and fields). Themes: phone fixes (cloud host mount over the end-to-end channel, landscape phone layout), golden-ratio node sizes on the dot grid, ACP gap filling (mode and model pickers, sign-in flow, `elicitation/complete`, session list and attach), the coordinator's work-item ledger, unified event queue and progress watchdog, cloud-first remote access, workspace archive, and the push-relay image.

### 桌面 / 服务器

- 画布节点尺寸：默认与最小尺寸取黄金比例（横向 φ:1，文件列表 1:φ），宽高都是 13px 点阵的整数倍（格数取相邻斐波那契数）；点阵间距按 13 / 21 / 34 三档；会话默认从 960×600 缩到 715×442，已保存节点不动。新建节点后相机居中并缩放到占视口主方向的 1/φ（夹在 100% 到 125%，字号不低于 12px），手机上装不下就按黄金比例缩小；侧栏 : 画布 = 1 : φ³，工作面板 : 画布 = 1 : φ²（#693）。整理与派发的间距改为 13px 的斐波那契倍数并对齐点阵，整理的吸附网格改为 13px，主从树居中改为向下取整，不再蹭进相邻兄弟的间距（#699）。
- ACP 会话：新建后提示框立即给模式与模型选择，Agent 报回的优先，没报时用节点与 CLI 的候选，选择先记着，目录到达后再下发；各家权限模式兼容表收进 `packages/shared/src/acp-modes.ts`，页面与 core 共用；上下文余量等首条消息发出后才显示（#689）。
- ACP 补齐（契约 §91，只加字段、路由与一个 procedure）：起不来时按失败码给具体文案；审批按钮显示 Agent 给的选项名，条目自带工具调用摘要，答复失败会撤销已答标记；推理强度等 select 与 boolean 配置项可改；`notice` 与压缩更新进时间线；内层工具调用分层；命令 `input.hint`、`messageId`、音频与非文本块；读 `audio`、`mcpCapabilities`、`logout` 能力，认证方法保留完整对象。随包 `@armadra/agent` 0.12.0 起以下四项生效：Agent 登录与登出（`acp_auth_required` 带登录方式，terminal 型方法由 core 执行适配器命令）、`elicitation/complete` 收掉 URL 型卡片（多选与带标题枚举的表单）、列出 Agent 自己的会话并「接管会话」、关闭时先 `session/close`（#694）。
- 协调者只分派：画布上的 ama 协调者以 `coordinator` 工具预设启动（`read`、只读 `grep` / `glob`、`task` 与画布工具，没有 bash / edit / write），Agent 设置里可开关；分派改由 ama 的 runner 完成事件触发，定时扫描降为 60 秒兜底；协调者的等待封顶 5 秒，不再自己阻塞（#665 #646）。
- 协调者的工作项账本（迁移 0058，契约 §90）：成员用 `canvas report` / `canvas handback` 结构化汇报，协调者用 `canvas items` 读账本，阶段由事实推出，节点头与分派抽屉显示，`person/*` 排前；阶段没变的进度不再推帧，页面容忍未知阶段，`open-agent` 与 `team` 新增 `--origin` 原样带上人的原话（#691 #695）。
- 协调者的统一事件队列（迁移 0059 `router_events`，契约 §93）：成员的报告与交回、看门狗判定、任务结束、人对某个工作项的追问、别的节点的留言都只往事件表写一行（id 确定，重复写入幂等），协调者空闲时 core 把未确认的事件合并成一张卡片投进去（最多 20 行，末尾附 `canvas items` 读取指针；忙时留在表里，投不进去按 5 秒到 300 秒退避重试，没确认前一直出现在之后的卡片里，正文不带终端原文）；新动词 `canvas events` 与 `canvas ack --event <id>`；人在对协调者说的话里点名工作项（`#<工作项 id>`）或在画布上评论成员节点，原话直接转给成员，协调者的卡片里只多一行「已转给 X」（#700）。
- Agent 进展看门狗（规则版，只提示不处置）：`stalled`（运行中却久无上报与输出）、`idleWaiting`（分派出去的任务久无结论）、`needsHuman`（等待权限或输入过久）；`agent.status` 帧、分派抽屉、节点头带标记，推送新增 `stalled`（只发给有 `canvas:read` 的人，不带终端原文），判定进协调者的事件队列（见下一条）；阈值在设置 → 通知（`watchdog.stalledMinutes` / `watchdog.needsHumanMinutes`，`0` 为关），无迁移（#690）。
- 跨连线读取先给一段并附续读位置：文件 `--offset`、转录 `--before`，单次读取不再超出连线的剩余额度（#674）。
- 远程访问以 Armadra 云为缺省：「这台电脑」精简为三行（允许访问、互联网访问、手机扫码连接），已登记即开，未登录走设备码登录，可更换空间；配对二维码缺省选内网地址；「我的其他电脑」与画布分享弹层的旧中转账号入口改为云优先，只有个人中转账号时保持一键开（#676 #686）。
- 工作空间归档（迁移 0057，契约 §89）：新增 `workspaces.archive` / `restore` / `archived`（仅 owner），归档与删除都不弹确认框，归档后可撤销；设置新增「归档」页可恢复或删除；归档时结束其终端与 Agent 会话、停掉语言服务，正看着它的订阅以 `not_found` 结束，授予与分享链接保留（#679）。
- Armadra 云登录：控制台与 `/h/` 支持 GitHub / Google 登录（按服务端能力位显示，口令入口随之隐藏）（#662）。
- 修复：壳等自己起的 core 时按输出判断进展，静默 10 秒才算卡死，总上限 60 秒（#657）。
- 依赖与 CI：`follow-redirects` 覆盖到 1.16.2，清掉 `pnpm audit --prod` 的 high（#655）；macOS 作业迁到 macos-15（#653 #654）；dev-stack 的 GHCR 镜像升到 0.11.0（#640）；探针：夜间 B 档 Windows 验收与 iOS 配对票过期（#637）、server-perf 越线复测一次（#642）、link-join 按共享解析拆链接片段（#644）；协议包 0.11.0 的兼容收尾（#645）；README 补下载、官网与英文入口（#649）。
- 协议包 0.12.0 与 `@armadra/agent` 0.12.0：协议仍是 1.4，包里多了 OAuth 能力位与字段；`@armadra/agent` 0.12.0 新增 ACP 登录与登出、`elicitation/complete`、会话列表与关闭的 `signal`，`coordinator` 预设下 `task` 默认后台、`task_ctl wait` 封顶 5 秒；`AcpClientOptions` 自带 `onElicitation` / `onElicitationComplete` / `onTerminal` / `authTerminal`，core 去掉了本地补的那几个交叉类型，能力开关（`acpClientFeatures`）保留给假客户端与测试。
- Armadra 云默认地址与直接登录：共享常量 `ARMADRA_CLOUD_ISSUER`（`https://app.armadra.com`），开发与测试可用环境变量覆盖（桌面 core / 服务器壳读进程环境，网页读构建时 `VITE_ARMADRA_CLOUD_ISSUER`，只收 https，回环另收 http）；桌面「远程访问 → 添加 Armadra 云」去掉地址输入，只留「登录」；`armadra-server cloud login` 的 `--issuer` 缺省取这个地址，自建或测试部署仍可显式给；个人中转的连接方式不变（#661）。
- 云端控制台第三方登录：登录与注册页按能力位 `auth.oauth.github` / `auth.oauth.google` 显示「使用 GitHub / Google 继续」，新路由 `/login/oauth/:provider` 回跳完成登录（`next` 含设备码批准页，两步验证复用第二步）；服务端不报 `auth.password` 时隐藏口令表单、找回与注册入口，不报 `auth.password-change` 时账号页收起「更改口令」；运营登录不变；`/h/<主机>` 未登录跳 `/login?next=/h/<主机>`（#661，配合 armadra-cloud#184）。
- 推送中继镜像：新增 `apps/push-relay/docker/Dockerfile`（node 运行时、非 root uid 10001、根文件系统可只读、`/health` 健康检查），标签发布时 `push-relay-image.yml` 推 `ghcr.io/ama-link/armadra-push-relay:<版本>`（amd64 + arm64，与服务器壳镜像同号）；APNs 与 FCM 凭据改为可选，只配 `ARMADRA_RELAY_SECRET_FILE` 也能启动，没配的平台登记与推送答 `platformUnavailable`（#658）。
- 修复：浏览器节点的 guest session 默认拒绝站点权限请求与权限检查（摄像头、麦克风、定位、通知等），只放行往剪贴板写入；此前 Electron 默认批准且 guest 里无提示（#647）。
- 修复：Windows 上同时关闭多个终端（或关一个终端的同时操作另一个）可能让其它所有终端会话一起断开。原因是 node-pty 1.1.0 的 ConPTY 句柄表没有加锁，会话宿主会在原生代码里崩溃；现在补上上游的锁（node-pty#922）。会话宿主的日志写进数据目录的 `session-host.log`，控制台管道断开时宿主也不会再跟着退出（#659）。
- 修复：Windows 上每关一个终端，会话宿主日志 `session-host.log` 里都会多一段 `AttachConsole failed` 堆栈，node-pty 还会在 5 秒后按已退出 shell 的进程号结束进程，号码若已被别的进程复用就会误杀。现在补丁让 node-pty 查不到控制台进程时只回空列表，不再按裸进程号结束进程；shell 仍由关闭伪控制台结束（#670）。
- 修复：macOS 发布包每开关一个终端泄漏一个 pty 设备（`/dev/ptmx` 与父进程那份 slave），累计到系统上限（默认 511）后整机都开不出新终端。node-pty 的这段补丁原先只在 `pnpm dev` 前打上，打包不经过它；现在和 Windows 那段一起由 pnpm 在安装时打上，开发与打包编的是同一份源码，编译前校验版本与补丁后文件的哈希（#671）。

### 手机与平板

- 手机挂载云主机走端到端通道：「选择主机」点「添加」时 core 登录改走端到端通道，与网页、分享链接一致，不再向源地址发明文 HTTP（云中转对它答 404）；失败带原始原因（远程服务错误码与 HTTP 状态、通道码、网络报错）；选择主机页加「返回」（#681）。
- 设备码批准后回到 App 并立即确认，在途时不丢结果（#667）。
- 横屏仍用手机布局：判据 `COMPACT_QUERY` 是唯一一处（宽度上限挡住键盘弹起后变矮的横屏平板），样式同一判据；矮屏（高 ≤ 500px）收紧底部导航、焦点页页头与按键条；手机 Dock 放不下时行内横向滚动（#688）。收起的小地图按钮让开底部导航与安全区（#699）。
- 连接 Armadra 云改用设备码登录：「添加连接 → Armadra 云」只有「登录」，没有地址与口令输入，用系统浏览器打开批准页（在那里用 GitHub / Google 登录），按服务端间隔轮询，限流退避，回到前台立即补一次；批准后选主机挂载；登录失效的云连接点「登录」直达；个人中转的账号口令登录不变（#661）。

### 部署说明

- 数据库迁移 0057（`workspaces.archived_at`）、0058（`workflow_task_runs` 加列）与 0059（新表 `router_events`）：只加列与新表，首次启动自动应用；回滚到 0.11.x 前请先备份数据库，旧版会拒绝带更高迁移号的库。
- 推送中继镜像 `ghcr.io/ama-link/armadra-push-relay:0.12.0`（amd64 + arm64，与服务器壳镜像同号）：非 root（uid 10001），根文件系统可只读，`/health` 健康检查；APNs 与 FCM 凭据可选，只配 `ARMADRA_RELAY_SECRET_FILE` 也能启动，没配的平台答 `platformUnavailable`。
- 配套镜像 `ghcr.io/ama-link/armadra-cloud:0.12.0`、`ghcr.io/ama-link/armadra-relay:0.12.0` 与协议包 0.12.0 同号；发版顺序沿用 0.11.0：先打 Armadra `v0.12.0`，再打 armadra-cloud `v0.12.0`。

## 0.11.0（2026-10-30）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.11.0。随包 `@armadra/agent` 0.11.0 与平台协议包 0.11.0。部署 SaaS 时先上 web 0.11，再打开 armadra-cloud 的 CSP；控制面只给 0.11.0 及以上的 core 签只带 role 的断言。

### 桌面 / 服务器

- 界面统一：设计系统改写为令牌与组件变体（圆角、投影、字号、行高、动效时长与曲线），设置改为工作台（导航、面包屑与设置搜索、KPI 与分组卡）；Agent 状态收口为 `StatusDot / StatusPill / StatusLine`，通知、分派抽屉与节点头状态弹层带缩略 Agent 树；画布节点、ACP 时间线与审批卡、面板套新令牌，样式守卫存量归零（#495 #498 #499 #503 #517）。
- 新视觉规范：CSS 守卫拦截写死的字号、颜色、圆角与时长，选中态改为强调淡底；本地打包 Inter 与 Geist Mono（中文与系统回退不变，终端仍用系统等宽），字重与标题字距进令牌；五级中性面、四阶墨、逐级投影与 8 / 12 / 16 圆角，对比度按新面重算（#589 #591 #594）。
- 开屏动画跟随屏幕刷新率逐帧播放，卡顿时暂停而不跳段（#497）。
- 终端跟随深浅色主题，新增「始终深色」配色偏好（#504）；多个视图同看一个终端时查询应答只收一份，只看的一端不再抢租约与窗口尺寸（#522）；第二端加入时不再把未量过的 80×24 报给 core，已有的端不再整屏重绘（#628）；session-host 代答条件与回放半截序列修复（#568）。
- SaaS 准入：在按团队准入之上，分享来的来源记下所属团队，团队只从接收方自己的云得出，侧栏按团队分组（#540 #554，迁移 0054）；个人空间访客按只带 role 的断言免邀请准入（#502）；新设备待信任时上报云端（#511 #558）；SaaS 来源的会话限寿一小时，授予收窄及时生效（#559 #566，迁移 0055）；识别云端版本门的错误码 `source_core_outdated`，提示主机版本太旧（#622）。
- 云端控制台：设备码批准与 `/j/` 的 SaaS 分支、个人空间、团队、授予、设备信任与团队链接、用量与计划（只读）、审计各页，运营后台第一版；core 支持 Armadra 云设备码登录与登记到空间，分享弹层可直接授予与邀请（#513 #524 #525 #526 #529 #530 #531 #532 #533 #534 #539 #543 #544 #545 #548 #549 #550 #615 #629）。
- SaaS 主机页：桌面 / 服务器壳打开 Armadra 云远程服务，控制台 `/h/<主机>` 直接进主机，访客落到 `/h/`；主机侧分享链接、CLI 设备码登录与只绑定；控制台来源的 Trusted Types 与内容预览加固，HTTPS 控制台来源修复（#590 #593 #595 #597 #598 #599 #600 #602 #604 #608 #609 #612 #616）。
- 设备背书：控制台可背书新设备，浏览器不能批主人的设备、不能取配对秘密；每次背书进「需要人处理」并推送给主人（#553 #557 #605 #610 #611，迁移 0056）。
- 中继：core 隧道写端改为与 Go 中继一致的公平调度（#567 #575）；托管页在主机隧道恢复后换新端到端通道重连（#574）；多标签页刷新令牌串行化（#523）。
- 修复：设置弹窗四周各留 48px，上限 1280 × 860（#514）；设置导航滚动条与面包屑对齐（#503）；小地图在浅色主题下不再偏深（#503 #578）；「从中转账号添加」不再列出本机（#618）；略超前的时刻显示「刚刚」（#617）；云对话框步骤与两处偶发时序竞争（#624）。
- 依赖与测试：清掉 `pnpm audit --prod` 的 high 与 critical，nodemailer 10.1.4，探针 electron 42.11.16；终端、配对与 Windows 用例去掉计时依赖（#480 #560 #561 #570 #576 #613 #619 #625 #627 #631）。

### 手机与平板

- 连接页「他人分享」按团队分小组（#540）。
- 设备背书进通知与推送，iOS 与 Android 认新的推送种类（#610）。
- 按钮与输入走触控档，粗指针下隐藏快捷键提示（#498 #589）。

## 0.10.0（2026-10-23）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.10.0。随包 `@armadra/agent` 0.10.0 与平台协议包 0.10.0（协议 1.4）；配套的个人中转镜像 `armadra-relay` 0.10.0 换成 Go 实现，数据格式不变，可回滚到 0.9.3（见 armadra-cloud 0.10.0 更新记录）。

### 桌面 / 服务器

- 外观：新增窗口背景色板（素、花瓣、雾、草地、黄昏），只铺在侧栏与设置弹窗左栏，画布换同色调淡底；默认「素」与之前一致。macOS 新增「半透明窗口」开关；侧栏底下的系统材质改为跟随应用主题而不是系统主题（#477）。
- 界面间距层级：设计系统新增间距语义 token 与规则，设置、抽屉、对话框、登录与连接、工作流等页面按层级调整（#476）。
- SaaS 准入改为按团队与角色（协议 1.4）：团队成员可在已信任设备上背书新设备；每台 core 新增成员终端数与每工作空间 Agent 数上限，超出答 `limit_reached`，不影响主机 owner（#479，迁移 0053）。
- 云端控制台第一批：外壳、路由、通用页面状态与数据层（尚未对外开放）（#478 #481）。
- 探针与个人中转集成测试改用 Go 中继，每次增量构建，不再用陈旧二进制（#487）。

## 0.9.3（2026-10-23）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.9.3。

### 桌面 / 服务器

- 新建 Agent 节点的视图跟随「Agent 默认视图」偏好：派发、team、open-agent、工作流与手动新建一致；偏好为会话时，走不了 ACP 但有转录的 Agent 也默认会话体，进程由 core 起，终端表面只附着；手动切换优先（#471）。
- 修复成员兑换后偶发 403：换票在途时先等它落地再交出 CSRF 令牌（#469）。
- 依赖：vite 8.2.4（#435），探针 electron 42.11.3（#455）；随包 `@armadra/agent` 与平台协议包 0.9.3。

## 0.9.2（2026-10-23）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.9.2。

### 桌面 / 服务器

- 权限确认提醒重做：「本次允许」为唯一主按钮并获焦点，「始终允许」降为次要，拒绝与允许分隔；命令等宽、可展开；数字键直答，读屏播报；审批卡、提问卡、只读分享页、节点头部共用一个外壳（#459）。
- 派发的 Agent 节点与手动新建一致，默认会话视图（#457）。
- 全站骨架屏与加载态统一：短于 200 ms 不出骨架，有缓存先显示，错误 / 空状态统一，遵守减少动效；修复浅色主题首帧闪深色（#461 #463 #464 #465）。
- 画布终端：程序开启键盘协议后 Ctrl+Enter 发送 CSI-u，配合 ama 的「打断并立即发送」（#467）。
- 随包 `@armadra/agent` 0.9.2（Ctrl+Enter 打断并立即发送），平台协议包 0.9.2。

## 0.9.1（2026-10-22）

版本统一：Armadra、armadra-cloud、armadra-agent 同为 0.9.1。需要中转 armadra-cloud ≥ 0.5.0。

### 桌面 / 服务器

- 会话时间线：ACP 与终端驱动的 Agent 统一为同一份时间线（快照 + 增量同步，序号去重），重连、恢复、多端同看不丢不重不乱序（#425 #434 #439 #445 #450 #453）。
- 渐进式状态：启动各阶段、恢复历史、思考、调用工具（带工具名）、等待审批 / 回答、输出中、完成 / 出错，所有视图共用同一显示规则（#433）。
- 内容转换：计划、差异、工具终端输出、思考（默认折叠）、图片、资源链接、音频的结构化展示；工具输入不再贴原始 JSON（#432）。
- 终端驱动的 Claude Code、Codex、OpenCode、Pi / OMP、Copilot、ama 从转录生成结构化内容；节点可在「会话 / 终端」之间切换；未人工命名的节点用 Agent 报的标题（#440 #443 #442 #448 #450）。
- 加载性能：打开 300 回合会话 2.1 s → 0.43 s；流式输出不再积压，期间无长任务（#426 #431 #432 #442 #451）。
- 下线旧接口 `acp.update` / `acp.log`，协议 minor 49（#453）。
- 随包 `@armadra/agent` 0.9.1，平台协议包 0.9.1。

### 手机与平板

- 焦点页与只读分享页读同一份时间线，分享页不再轮询（#442）。

## 0.9.0（2026-10-20）

版本统一：Armadra、armadra-cloud、armadra-agent 自本版起共用一个版本号。需要中转 armadra-cloud ≥ 0.5.0（`https://relay.armadra.com` 已升级）。

### 桌面 / 服务器

- 画布右上新增「节点与进度」：列出当前画布节点（按分组，Agent 带状态），点行看详情并定位（#417）。
- 随包的 `@armadra/agent` 升到 0.9.0，平台协议包升到 0.9.0（协议 1.3 不变）（#419）。
- 打包后启动时钥匙串子进程提前退出不再导致 core 崩溃（#415）。
- 夜间配对探针补全失败现场（#420）。

## 0.6.2（2026-10-17）

修复版。

### 桌面 / 服务器

- Codex 在默认沙箱里也能使用画布工具：画布启动 Codex 时挂上 armadra 工具服务，沙箱与全局配置不变（#412）。
- Copilot 1.0.9x 的成本按逐请求 token 统计，非高级模型不再为空（#411）。

## 0.6.1（2026-10-17）

修复版。

### 桌面 / 服务器

- 新建 Agent 节点不再误显示「已退出」：工作空间晚到时补建会话，创建失败显示「启动失败」与原因，后台失败时回收已起的进程（#398）。
- 退出应用时一并结束 tmux 与全部会话进程；启动时清理旧版本留下的孤儿 tmux。应用内更新与崩溃仍保留会话（#401）。
- 连线更柔和：拐角改为平滑曲线，同组派发只显示一个标签，主干与标题栏保持间距（#399）。
- 界面清理：节点标题栏只留名称、状态点、关闭与更多；资源面板折叠空闲项；设置页去掉复述性说明；连线关系统一为「共享上下文 / 派发」；浏览器页侧栏不再预留窗口按钮位置（#405）。
- 通知只提醒需要人处理的事（等待审批、等待回答、出错、交接待确认），按工作空间 → 画布 → 节点分组，点击定位；移除「后台完成通知」（#404）。
- 各家 CLI 的 hook 与 skill 试运行修复：OpenCode 节点停在运行中、Pi 在 ACP 下找不到 armadra-hook、OMP 会话索引与成本归属（#409）。

### 手机与平板

- 通知新增「等待回答」「出错」推送，不再推送「已完成」（#404）。

## 0.6.0（2026-10-17）

功能版本。经中转的连接改为端到端加密，需要中转 armadra-cloud ≥ 0.4.0（`https://relay.armadra.com` 已升级）。0.5.x 需手动安装一次本版本，之后可在应用内更新。

### 桌面 / 服务器

- 应用内更新：关于页显示版本历史，下载校验（sha256 + minisign）后重启替换，只升不降（#289–#292）。
- 端到端加密：经中转只走加密通道，中转读不到内容；每台设备一把设备钥，新设备经扫码、已信任设备背书或本机核对 6 位码接入；访客链接带电脑身份指纹（#368、#373、#384）。
- 远程访问重设计：侧栏「这台电脑 / 我的其他电脑 / 他人分享」；一个开关「允许其他设备访问这台电脑」（仅局域网 / 局域网 + 互联网）；删除「切换服务」；画布与工作空间可直接分享，默认只读 7 天（#311、#314、#322、#348、#365、#370）。
- 会话分享：访客只读查看页，读写由 core 判断；修复整机分享后对方看不到内容；只读成员不能经导出写文件（#310、#320、#349）。
- 流量统计：按设备、账号、访客链接与类别统计经中转的请求与字节，远程访问页显示实时速率与趋势（#363、#371、#376、#382、#383）。
- 界面精简：远程机器只留 SSH；代码托管只留仓库、issue 与 PR；新建工作区三种来源；暂时隐藏凭据、用量、活动卡片、定时任务与工作流；快捷键可整体关闭（#300、#304、#305、#306、#307、#321）。
- 画布：工具用后保持选中；Agent 面板按画布分组；整理保证不重叠；连线绕开节点并标注关系（#302、#303、#323、#324）。
- 其他：Cookie 会话透明续期与到期前续期、下载改流式、协调者分派改为事件推送、内存越线提醒与逐台推送偏好、评论 Markdown 预览、托管配置可按工作空间、经中转的源断线后自动恢复（#343、#345、#344、#341、#346、#350、#392、#393）。
- 协议 minor 47，平台协议 1.3。

### 手机与平板

- 连接页两组与浏览器 `/j/` 访客直达；扫码加入端到端通道；流量统计存原生存储；修复深链冷启动空白（#312、#358、#373、#385）。

## 0.5.1（2026-10-11）

修复版。仓库迁到 GitHub 组织 AMA-Link（旧地址自动跳转）。

### 桌面 / 服务器

- 通行密钥：注册时只提供 EdDSA / ES256 / RS256，修复运行在 Node 24 上时浏览器登记后量子密钥、注册返回 409（#277）。
- 服务器镜像改用 Node 24（`node:24.21.0-bookworm-slim`），发布到 `ghcr.io/ama-link/armadra-server`（#277、#278）。
- 启动动画：兜底定时器在页面环境拆除后到达时不再抛错（#277）。
- 协议包与开发环境的中转、控制面镜像对齐 armadra-cloud 0.3.10（#283）。

### 手机与平板

- GitHub Release 开始附带签名的 Android 安装包 `armadra-mobile_<版本>_android.apk`（#280）。

## 0.5.0（2026-10-10）

功能版本。中转 `https://relay.armadra.com`（armadra-cloud 0.3.10）缺省不再要求人机验证。

### 桌面 / 服务器

- 设置 → 远程访问 → 中转账号可「修改口令」：成功后该账号其他设备下线，本设备保持登录（契约 §63，#265）。
- 人机验证弹窗：修复桌面端空白与闪烁（页面来源 `http://127.0.0.1:<端口>` 未被允许嵌入）；加载失败只提示一次并可重试；中转不要求验证时不弹窗（#267）。
- Windows：运行产物读取用精确文件号比对，修复祖先目录被 junction 替换时未拒绝（#270）。
- 协议 minor 36。

### 手机与平板

- 同上：修改中转口令入口。

## 0.4.0（2026-10-10）

功能版本。中转改为部署在 Cloudflare：`https://relay.armadra.com`（armadra-cloud 0.3.9 起）。

### 桌面 / 服务器

- 远程服务登录支持 Turnstile 人机验证：中转要求时先弹出验证再提交口令，令牌带 `action=armadra-login`；`challenge_required` / `challenge_invalid` 有明确提示（契约 §62，#258、#260）。
- 服务重命名与服务端默认名：选择服务页与远程访问每行可改名（只存本设备），主机名称可在本机服务设置，中转经 `/.well-known` 提供 `name`（迁移 0046，契约 §61，#257）。
- 协议包 0.3.5（平台协议 1.2），协议 minor 35。

### 手机与平板

- 同上：添加连接时的人机验证与服务改名。

### 工程

- ESLint 堆上限调高，CI 不再在 lint 时内存溢出（#262）。

## 0.3.0（2026-10-10）

三端统一版本线的第一个版本：桌面、服务器壳与手机 / iPad App 同为 0.3.0（App 此前为独立的 1.1.0）。中转需 armadra-cloud 0.3.0（镜像 `ghcr.io/owlbay/armadra-relay:0.3.0`）。

### 桌面 / 服务器

- 分享范围：整台主机 / 工作区 / 会话，可设只读；只读在 core 侧强制，终端输入、画布修改与文件写入一律拒绝（迁移 0045，契约 §60，#252）。
- 账号与共享、设备与会话显示签发来源并按来源分组（#246）。
- Claude Code mod：输入框上方横条（上下文 / 派发对象与待收消息）、消息到达提示、状态栏画布名、设置页显示挂载状态（契约 §58，#249）；`/armadra-post`、`-inbox`、`-ack`、`-send`、`-team`、`-open`、`-list` 斜杠命令，ACP 会话同样挂载（契约 §59，#248）。
- 协议包 0.3.0 / 平台协议 1.1；协议 minor 33。

### 手机与平板

- 版本并回统一版本线，构建号继续递增（#247）。
- 分享对话框支持选择范围与只读（随桌面）。

### 工程

- 版本规则：修订号为缺陷修复、次版本为功能、主版本为特大更新，任一端升级时其他端下次对齐（#247）。
- design-showcase 减少动效检查等画面稳定后再比对（#251）。

## 0.2.6（2026-10-10）

多端切换、多中转与附件。中转仍用 armadra-cloud 0.2.1。

### 桌面 / 服务器

- 服务选择页：手机与 iPad 启动先选服务；三端设置与命令面板可「切换服务」，桌面可在新窗口打开另一服务（#240，#229）。
- 一个主机多条到达方式：经多个中转挂同一主机时凭据互不覆盖、切换不再新增设备（迁移 0044，契约 §55，#237）。
- 画布 Agent 粘贴 / 拖入图片与文件：终端上传到会话主机并插入路径；ACP 按能力发送图片与资源附件（契约 §56，#241，Closes #226）。
- 终端在节点外松开鼠标时选区正确结束（#235，Closes #227）。
- Claude Code ≥ 2.1.293 额外挂 armadra-mod：进程内上报状态、状态栏显示节点；低版本与安全模式自动降级（契约 §57，#238，#230）。
- 协议 minor 29；中继心跳用例稳定（#243）。

### 手机与平板

- 启动先进入「选择服务」，设置里可切换服务。
- 同一主机经多个中转的到达方式分开保存，连接表升级 v2。
- ACP 会话可附图片与文件。

## 0.2.5（2026-10-10）

性能、终端与 CLI 兼容。中转仍用 armadra-cloud 0.2.1。

### 性能

- Runtime 资源采样改为异步加超时、每轮一张进程表，事件循环最长卡顿由 90–237 ms 降到 6–14 ms；新增 `GET /api/diagnostics/runtime`（契约 §54，#221）。
- 离屏内存采样降频生效；系统内存压力通知页面回收；WebGL 隐藏终端 30 秒后归还名额（#219）。
- 终端分阶段生命周期：平移离屏 60 秒断开显示连接，10 分钟释放前端实例，会话保留；离屏共享调度器与背压（#222）。
- 渲染方式 DOM / WebGL / 自动与缩小时限帧（实验）进「终端外观」（#224）；终端内存探针与基线进夜间检查（#220）。

### 终端与画布

- 支持 OSC 7501 程序状态与 OSC 9;4 进度（契约 §53，#217）。
- 连线随两端相对位置选边（#213）；小地图收起钮悬停显示、连线按画布样式绘制（#218）。

### Agent CLI

- Codex 启动不再出现 hook 信任与内嵌模式两条警告，不写用户配置（#214）。

### 手机与平板

- 版本号由 App 的版本与构建号生成（iOS `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`，Android `versionName` / `versionCode`），修正 iPad 上一直显示 0.2.0；设置 → 关于显示 App 与主机版本、协议兼容提示（#225）。

### 工程

- nightly 修复：打包后 core 关停顺序与超长 socket 路径、iOS 用例、Windows 保活探针（#208、#215）；issue / PR 中英模板与需求流程（#212、#228）。

## 0.2.4（2026-10-09）

设置重组、Agent 连线与启动体验。中转仍用 armadra-cloud 0.2.1。

### 改进与修复

- 设置：弹窗按窗口比例放大不再封顶；导航重组为 8 组，每页标明作用范围（本设备 / 主机 / 账号）；新增「默认」「终端外观」（字体从本机等宽字体选择）；集成并入「Agent CLI」，SSH 与执行主机合为「远程机器」，远程服务与对外服务整合为「远程访问」「设备与会话」；旧入口与深链自动跳转（#202、#205）。
- Agent 连线：上下文线与派发线按类型分色（上下文为专用色，派发取簇色）；所有节点四边各一个连接点；修复界面改主从方向后投递授权不跟随（#200、#204）。
- 布局方向：纵向 / 横向两种（缺省纵向），整理时主 Agent 居中于其子 Agent；小地图按类型与派发簇着色，缩放加 −/+（#200、#204）。
- 删除「新建 Agent」向导；「派生」改为直接建从，从连接点拖到空白处弹出创建菜单（#204）。
- ACP 创建提速：节点出现即可输入，阶段提示，`session/new` 60 秒超时，菜单打开时预启动（契约 §51，#206）。
- 同时启动多个同类 CLI 时按配置目录排队，失败自动重试一次并可手动重试（契约 §52，#201）。
- 注入只认本产品命名，不再识别旧别名（契约 §13.5，#203）。
- 协议 minor 24。

## 0.2.3（2026-10-08）

修复版。

### 修复

- 集成与启动迁移只认本产品自己写入的 hook、技能目录与指令块；其他工具的注入不再展示、修改或删除，启动迁移不再写用户 HOME，执行主机上的 Worker 不再改 Codex 配置（#198）。

## 0.2.2（2026-10-08）

界面与多端体验修整。中转仍用 armadra-cloud 0.2.1。

### 改进与修复

- 设置 → 集成：每家一张卡片、固定五行；适配器与 CLI 都可一键安装 / 重装 / 恢复上一版本（OpenCode、Oh My Pi、GitHub Copilot、Pi 等），只跑 `npm i -g`、不写 CLI 配置（契约 §47，#193）。
- 在画布中创建 Agent：按驱动报告可用性，节点菜单「派生 Agent…」；Pi 的 ACP 适配器标为仅终端视图（契约 §48，#193）。
- ACP 会话视图：按协议内容分类展示，复制、编辑后重发、重新生成、停止、看 diff、打开文件、计划、图片与资源链接、`/` 命令与用量；会话内可选中、点击，不再拖动画布（契约 §49，#196）。
- 设置弹窗按视口比例；节点头的徽标与按钮常显、样式统一（#192）。
- 画布整理：组、导入批次、白板对象按整块移动，保持原顺序；主 Agent 在左、子 Agent 在右侧等距对齐；可只整理选中，一次撤销；导入两个以上对象自动成组（#194）。
- 多端：新端加入不再让其他端的终端整屏重绘、被压成手机尺寸；身份通知分级，续期不再全量重取；丢失租约只切只读、不重载（#195）。
- CI：runs 编排测试按平台注入、controller 通道先读完请求体再回复（#191）。

## 0.2.1（2026-10-07）

个人中转模式补齐。需要配合 armadra-cloud 0.2.1 的中继（镜像 `ghcr.io/owlbay/armadra-relay:0.2.1`）。

### 修复与补齐

- iPad 经中转发消息偶发「这一轮没有完成」：中转、云端与 core 的 HTTP 空闲 keep-alive 统一 75 秒；中转限流与预检缓存按真实使用放宽（#184、armadra-cloud#11）。
- Agent 回合对账：提示带 `clientTurnId`，core 去重；网络失败先确认再判，重连后补读断线期间的回合（契约 §39.9，#185）。
- 远程访问时的设置页：只对本机有效的项隐藏或禁用，不能停用本页正走的连接；中转托管页刷新不丢登录（#186）。
- 手机：推送点开切到对应主机，经中转时显示中转不可用提示，访客令牌不再覆盖主人（#187）。
- 媒体与下载：短期媒体票加 Range，视频音频边下边播，经中转同样可用；图片与文本设大小上限；语言会话断线后持续重连；同一中转上两台源不再共用凭据（契约 §37.4，#188、armadra-cloud#12）。
- 测试：多源探针全部经中转，新增 WebKit 往返探针。

## 0.2.0（2026-10-07）

0.1.0 之后的第一个版本。0.1.0 是 Tauri 壳加 Rust Runtime / Go Host；0.2.0 起只剩一份 TypeScript core，由 Electron 桌面壳与无窗口服务器壳装配，页面仍是同一份。

### 兼容性

- `minimumInstalled` 仍为 0.1.0：迁移只新增（0001–0013 与 0.1.0 逐字节相同，新增到 0041），0.1.0 的数据库可以直接升上来。
- 随桌面壳打包的 `@armadra/agent` 为 0.6.8，宿主 API 版本 1。
- `GET /api/agents` 的行不再有启动兼容字段 `launchWords` / `launchArgs`（从没有公开版本带过旧启动格式），页面只经 `launcher` 拼行。
- ACP 入口实测通过的版本：claude-agent-acp 0.85.1 起、pi-acp 0.0.34 起；其余五家（codex-acp、opencode、omp、copilot、ama）还没有真跑记录。

### 架构与壳（#5–#13）

- 桌面壳换成 Electron；Runtime 与 Host 合并为 Electron-free 的 TypeScript core（`apps/desktop/src/core/`），新增无窗口的服务器壳 `apps/server`。
- 远端执行主机：SSH 终端里的 Agent 拿到画布注入，远端的 Git 长操作、文件监听、语言服务、资源采样与交接都经执行主机上的 Worker。
- 节能休眠：空闲的 Agent 会话结束以释放内存，聚焦、投递或计划冷启动时用 CLI 自己的 resume 接回。
- `canvas team` 一次组一队 Agent；`open-agent` / 成员可各带一条 worktree。
- 浏览器节点的 Agent 工具补强（无障碍快照、hover / drag / fill / pdf、多选、穿 shadow root、整页截图）。
- 成员权限：组管理员管自己的组，只读共享、写租约与接管按权限判。
- Hook、技能与画布说明只在画布启动时注入，不再写全局配置；Gemini CLI 退役。
- CLI 协作第一部分：投递前的画面门、通信与共享上下文。

### 画布启动器（#14–#19）

- 启动行统一经 `run/<cli>` 启动器与委托垫片拼出，节点终端只带垫片 PATH；`/api/agents` 答 `launcher`。
- Codex 改用会话旗标，不再写信任记录；迁移 v2 清掉旧信任记录。
- Windows 启动器 `armadra-launch.exe`。

### Agent 与 ACP

- ACP 传输与适配器表（#29），会话视图页面（#37），ACP 作为同一节点的另一种驱动、与终端共用行 / 代次 / 租约 / 休眠（#51）。
- 第七个内置 Agent ama 与宿主适配器（#35）；`@armadra/agent` 升到 0.6.5（ACP 会话带画布 MCP，#52）与 0.6.7（宿主注入的 runner，ama 可以给 ama 派任务，#71）。
- `armadra-hook mcp`：stdio MCP，工具表与 `armadra-hook canvas` 一致（#44）。
- 画面门补齐，计划投递也经过它；未登记的选择菜单一律拦下（#38）。
- 节点凭据：多账号第二阶段，启动器按需兑换，节点 shell 里只有引用（#30）。
- `HostApi.runners` 与 `wait` 动词（#63）；输出到画板与新建 Agent 向导（#48）。
- Agent 权限角色：operator 驱动与审批自己起的终端，ACP 与工作流按对象落到画布（#64）。
- 跨主机交接与 Worker 舰队（#42）。

### 协作与工作流

- 实时协同：core（#32）、页面绑定与在线光标（#50）、评论与提及，Agent 可读评论（#56）。
- 工作流引擎：草案、模板、运行与关卡（#36）；工作流页面、再运行与定时（#65）。

### 账号与安全

- 身份加固：口令策略、限流锁定、passkey、TOTP（#34）；安全页面：会话 / 设备、MFA、审计、两步登录（#61）。
- OAuth / OIDC / SSO：GitHub 与通用 OIDC（#39）。
- 安全收尾：泄露口令检查、公网加固、安全审查（#73）。
- 出站地址表与用量端点政策（#40）；密钥后端按平台补齐（#25）。
- 同浏览器多窗口不再互相作废 CSRF（#58）。
- 桌面壳不再放行回环匿名请求（安全审查 L9，#114 与 G5-28）：core 回环监听上的每一条 `/api/` 与每一条 WebSocket 都要会话，本机别的回环端口上的网页与不带凭据的本机进程一律 401。桌面页面的请求带票据换来的 Bearer、流先换一次性票，托盘用自己的会话；只有设了 `ARMADRA_LOOPBACK_OWNER=1` 的裸 core（探针、`armadra.sh run web`）照旧放行。
- 依赖安全告警修复：undici、brace-expansion、ip-address、hono、fast-uri、dompurify（#46）。

### Gateway、推送与手机

- Gateway core：本地 CA、配对载荷、Bearer 模式与 `/api/gateway`（#31）；桌面 Gateway 设置页与配对（#47）。
- 推送 core：Web Push、APNs / FCM 直连与端到端加密中继（#33）。
- 移动网页连接页与手机细节（#62）；Capacitor 手机壳：iOS / Android 原生端，钥匙串、指纹钉扎、扫码、推送解密、深链（#68）。

### 平台、发布与运维

- 签名、公证与自动更新端到端；本地构建不自动更新（#53）。更新链路修正与通道（#41）。
- 服务器部署：镜像、内建 ACME、公网部署指南、备份与升级（#54）；服务端性能基线与执行主机舰队视图（#55）。
- Linux 打包验证与夜间冒烟（#57）；Windows 真机验收包与启动器凭据兑换（#66）。
- 分发渠道与第三方声明（#67）；可选崩溃上报（#59）。
- 界面：设计系统 token 与基础件（#24）、设计展示页（#43）、存量界面两轮套用（#49、#72）。

### 个人中转与远程服务（#131–#181）

- 个人中转：桌面与服务器壳经出站隧道登记到自建中转（自签 TLS 加指纹钉扎、账号口令登录），手机与浏览器经中转访问同一台主机；中转托管页面（#143、#148、#152、#169、#170）。
- 客户端源表与「远程服务」设置页：添加、登录、分享本机，侧栏按源分组并可拖动排序；地址错误给出具体提示（#138、#144、#171、#181）。
- 分享链接：可多次使用、就地可见、复制、撤销与改备注；桌面系统分享菜单（#145、#149、#175、#181）。
- 页面多源：一个标签页同时挂多台主机，查询与 store 按源区分，切源不串，中转停了单独提示；手机多连接与扫码挂载（#139、#141、#142、#178）。
- 安装包带服务器壳，`Armadra serve` 无窗口启动（#157）；单实例锁、撤销时清理中转侧记录（#154）。

### 接口与契约（#136–#182）

- 全部域迁到 oRPC 契约（§34–§43），旧路径保留并由对偶测试核对逐字节一致；控制面 WebSocket `/api/ws`，语言会话保持独立连接（§35.6）；错误码注册表补齐（#136、#146、#147、#150、#151、#153、#155、#158–#162、#164、#182）。

### 其他修复（#115–#182）

- 回环请求全部要会话（#116、#117）；GitLab / Gitea 补齐：子组、变基、合并方式与检查通过后合并（#115、#118、#179）。
- 新建 Agent 只选 Agent 即创建，目录跟画布走（#122、#168）；ACP 适配器安装与重装入口（#173）。
- 钥匙串长密钥被截断导致远程服务登录 500（#172）；「谁读过我」清单为空（#156）；资源抽屉显示不全（#124）。
- iPad 状态栏、窗口控件与浮层按安全区让开（#174、#180）；下载改为流式、浏览器画面背压（#180）。

### 工程

- 共享层、core 骨架与契约节（#22、#23、#27）；CI 端到端分档、每条一个清单文件（#26、#57）；本地 dev-stack（#28）。
- 真 CLI 端到端 C 档探针与运行手册（#70）；探针一律用临时 HOME（#69）。
- 端到端稳定性修复（#45、#60、#74）。
- macOS 上无头 Chromium 关掉 GPU，修掉 CI 虚拟机里浏览器偶发整体冻住；CDP 线路追踪与卡住时的现场采集；update-e2e 进程树清理（#76）。
- 真 CLI 端到端探针：Claude / Codex 前提改为可选、`--preflight` / `--setup-only`、TUI / ACP 只跑选中的家、信任对话框等选项画出再答；实跑通过 claude-agent-acp 0.85.1 与 pi-acp 0.0.34，记入兼容表（#77）。

### 已知限制

- 证书与发布源要由维护者提供；没有时发布按「未签名」处理，系统首次安装会警告。
- 手机壳不随本版上架商店。

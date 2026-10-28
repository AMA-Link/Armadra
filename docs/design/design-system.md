# 设计系统

> 状态：改版设计（2026-10-23，基线 `f395dd396`）。上一版（2026-10-04）已实施的内容保留在各节；本次改值标「改」、新增标「新」、删除标「删」。实施批次与工作包在工作区 `docs/armadra/plans/ui-design-unify.md`；验收面仍是[设计展示页](design-showcase.md)。
> 风格定位：**极简生产力工具**——近黑 / 近白的中性底、极低饱和、单一品牌强调色只用于焦点、选中与主操作；1px 细边框为主、阴影只给真正浮起来的东西；紧凑的信息密度（列表行 28–32、正文 13px）；精确短促的动效（< 300ms，无回弹）；键盘优先（主操作都有快捷键并以 `Kbd` 显示，命令面板是中枢，焦点可见，列表可上下键导航）。与参考套件、参考 A（设置布局）、参考 B（克制与发丝线）合并使用，冲突时以这一段为准。
> 现状来源：`apps/web/src/styles/{tokens,app,canvas,nodes}.css`、`apps/web/src/ui/*`、[界面规范](../guides/ui-refinement.md)、[v3 契约](../contracts/v3-agent-terminal-plan.md) §3–§4、§24。本文不改契约编号；与 §4.3 的差异沿用 `tokens.css` 头部注释里的说明（品牌蓝叫 `--brand`，`--accent` 是 shadcn 语义）。
> 硬性规则（用户定）：界面极简，不写说明性文字，不出现「预留 / 未实现」字样，chrome 里不放版本与状态字符串；文案只用简体中文（品牌与 CLI 名除外），全部经 `apps/web/src/i18n/` 且中英同步；控件只用 `apps/web/src/ui/` 里的 shadcn 组件（可以给它们加 variant / size，不另造组件库；新的组合件放 `ui/` 并进展示页）；功能代码里不手写 `<button className>`；仓库内容不出现任何参考来源的名字。

## §1 原则

| #   | 原则                          | 落点                                                                                                                                                                    |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 一套 token，两套主题          | 颜色、圆角、字号、动效、z 轴只从 `tokens.css` 取；深色是默认，浅色是 `:root[data-theme="light"]` 覆盖层；功能代码里不出现字面色值，也不写 `dark:` 分支                  |
| 2   | 层级靠灰度与 1px 线，不靠阴影 | 窗口底 → 面板 → 卡片三档表面 + 1px 发丝边；阴影只给浮层、对话框与画布节点（§2.9）                                                                                       |
| 3   | 状态 = 文字 + 颜色            | 动画（脉冲、光晕、流动虚线）只是加强，`prefers-reduced-motion` 下全部静止而不丢信息                                                                                     |
| 4   | 同一个对象，一种外观          | 画布节点、焦点页、会话视图、ACP 卡片、移动端都渲染同一份组件；平台差异只改布局常量与断点，不另做一套「简化版」                                                          |
| 5   | 克制的文字                    | 标签是名词或动词短语，没有句号；不解释后果的行不给脚注；空态只有一句话和一个动作；没有常驻说明段落（§6）                                                                |
| 6   | 可达性是验收项                | 文字 ≥ 4.5:1，图形与焦点环 ≥ 3:1（WCAG 2.1 AA，1.4.3 / 1.4.11）；全部控件可键盘到达；触屏命中区 ≥ 44px；`forced-colors` 下保留系统焦点环                                |
| 7   | Agent 颜色只属于 Agent        | 七种内置 CLI 各一个固定色相，只用于标识「这是谁」；状态（运行、需要你、失败）用状态色，两套色永远不互相借                                                               |
| 8   | **新** 单一强调色             | 界面是灰阶的；彩色只出现在三处：状态色、Agent 标识色、品牌蓝。品牌蓝只做四件事：焦点、选中 / 当前项、主操作（一屏一个实底按钮）、进度与指示器。它不做标题色、不做装饰底 |
| 9   | **新** 浮层从触发点生长       | 菜单、弹层、提示以触发点为 `transform-origin` 从 0.96 放大到 1（对话框居中，不设起点）；同组元素的「当前项」靠一个指示器平移过去，不各自变色；无回弹（§8）              |
| 10  | **新** 等宽元信息与发丝线     | 时间、字节、计数、路径、版本一律等宽字体 + `tabular-nums`；分组之间用 1px 发丝线（两端渐隐）或留白，不用色块切分                                                        |
| 11  | **新** 键盘优先               | 每个主操作有快捷键，并在按钮、菜单项、Tooltip 里以 `Kbd` 显示；命令面板（⌘K）收录全部命令；键盘触发的面板不播动画；列表可 ↑↓ 导航（§11）                                |
| 12  | **新** 紧凑密度               | 列表行 28、菜单项 28、表格行 36、设置行 40；控件 24 / 28 / 32；间距阶梯不放大，靠对齐与发丝线读出结构                                                                   |

## §2 Token

全部名字已在或将加入 `apps/web/src/styles/tokens.css`，并经 `app.css` 的 `@theme inline` 映射成 Tailwind 工具类。本节只列**语义层**；原始值在表里，实现时逐条对照。表中「验证」列是按 WCAG 相对亮度公式算出的对比度（文字对其默认表面）。

### §2.1 表面与文字

| token                  | 深色        | 浅色               | 用途                                                   | 验证                                                           |
| ---------------------- | ----------- | ------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| `--bg`                 | `#1c1c1c`   | `#f7f7f7`          | 窗口底、设置工作台的外层底                             |                                                                |
| `--panel`              | `#262626`   | `#f5f5f5`          | 侧栏、Dock、工具簇、抽屉、KPI 托盘外层                 |                                                                |
| `--card`               | `#2c2c2c`   | `#ffffff`          | 节点、设置分组、消息气泡、列表卡、托盘内卡             |                                                                |
| `--surface-raised`     | `#333333`   | `#ebebeb`          | 卡片内的次级块（代码块、引用、表头、输入框底）         |                                                                |
| `--surface-overlay`    | `#3a3a3a`   | `#ffffff`          | 菜单、Popover、Tooltip                                 |                                                                |
| `--canvas-bg`          | `#191919`   | `#ffffff`          | 画布                                                   |                                                                |
| `--term-bg`            | `#0a0a0a`   | `#fafafa`          | 终端底；`--term-*` 共 19 个令牌整组随主题换（见下）    | 浅：前景与 ANSI 十六色对底均 ≥ 4.5                             |
| `--text`               | 白 85%      | `#202020` 90%      | 正文                                                   | 深 12.5 / 浅 11.4                                              |
| `--muted-foreground`   | 白 55%      | `#202020` 70%      | 次要文字、图标默认色、元信息                           | 深：bg 6.0 · card 5.3 · overlay 4.7；浅：card 6.0 · raised 5.5 |
| `--faint`              | 白 38%      | `#202020` 50%      | **只用于装饰**：分隔点、禁用态、占位图标、刻度条未填格 | 3.6 / 3.2，禁止做可读文字                                      |
| `--border`             | 白 8%       | `#202020` 10%      | 发丝线：分隔线、卡片边、托盘边                         | 装饰                                                           |
| `--border-strong`      | 白 16%      | `#202020` 20%      | 输入框边、hover 边、浮层边                             | 装饰（输入框另靠底色区分）                                     |
| `--hover` / `--active` | 白 7% / 12% | `#202020` 6% / 11% | 行与钮的悬停 / 按下                                    |                                                                |
| `--scrim`              | 黑 55%      | 黑 28%             | 对话框遮罩                                             |                                                                |

终端配色（#501）：`--term-*`（底、前景、选区、ANSI 十六色）在浅色主题下是一套浅底调色板，不再两套主题都深。浅色底 `#fafafa`，前景 `#1f1f1f`，十六色按浅底重调（bright 系列在浅底上更深而不是更亮），每个前景对底 ≥ 4.5:1，选区是品牌蓝 20%；`terminal-palette.test.ts` 逐条守卫。终端偏好「配色」可选「跟随主题」（缺省）或「始终深色」（给按深底配色的 CLI 用）。始终深色时，终端容器与终端节点的框（`.node-frame`，不是外层：骑在边上的连接点、外圈光晕留在应用主题里）带 `data-term-scheme="dark"`，框内重设文字色为 `--text`：`tokens.css` 把深色那一整套令牌同时声明在 `[data-term-scheme="dark"]` 与 `:root` 上（深色值只写一处），这棵子树在浅色主题里就地回到深色，外框、头部与 xterm 连成一体；`dark:` 变体也认这个属性。xterm 的 `options.theme` 读容器的计算样式，应用主题或这项设置变化时就地重设，不重建会话。

规则：文字只放在 `--bg / --panel / --card` 上用 `--muted-foreground`；在 `--surface-overlay` 上（菜单）次要文字对比度 4.7，仍过线，但不要再叠透明度。发丝线的「两端渐隐」形态是工具类 `.hairline-x`（`mask-image: linear-gradient(90deg, transparent, black 20%, black 80%, transparent)`），用于设置工作台分组之间与官网分区之间；卡片边仍是满宽。

### §2.2 品牌与焦点

| token           | 深色      | 浅色      | 用途                                                       | 验证                               |
| --------------- | --------- | --------- | ---------------------------------------------------------- | ---------------------------------- |
| `--brand`       | `#0a84ff` | `#007aff` | 选中框、连线预览、把手、未读光晕、进度条、指示器（非文字） | 深 card 3.8 · 浅 white 3.7（≥3:1） |
| `--brand-text`  | `#6cb0ff` | `#0a5fc4` | 链接与强调性数据（提及、未读、改名标记等）                 | 深 card 6.2 · 浅 raised 5.1        |
| `--brand-solid` | `#0a6fd6` | `#0066cc` | 实底主按钮（`--primary` 指向它，不变）、`Badge brand` 实底 | 白字 4.9 / 5.6                     |
| `--brand-soft`  | 品牌 16%  | 品牌 12%  | 选中态的底、`--brand-text` 的衬底                          | 文字叠在上面 5.2 / 5.2             |
| `--focus-ring`  | `#b8dbff` | `#082340` | 焦点环，shadcn 按 50% 画 3px                               | 50% 叠在最深 / 最浅表面 3.2 / 3.2  |
| `--on-accent`   | `#ffffff` | `#ffffff` | 实底按钮上的字                                             |                                    |

**选中态 = `--brand-soft` 底 + 正文色**（`text-foreground`），不反白，字与图标都不着强调色：侧栏画板行、会话行、控制台导航当前页、`IconButton active`、`Table` 选中行、差异段头、手机按键条锁住的修饰键、收藏星标都按这条写。`--brand-text` 只给链接与强调性数据；手机底部导航的当前项是导航指示，仍用 `--brand-text`。

主按钮保持品牌蓝实底（§1 第 8 条：主操作是品牌蓝的四个用途之一）。参考套件的反白主按钮不采用。一屏只能有一个 `Button variant=default`；次要动作 `outline`，行内 `ghost`。

### §2.3 状态色

每个状态三个名字：`--<s>`（图形 / 圆点 / 边，≥3:1）、`--<s>-text`（文字，≥4.5:1，也用于叠在 `-soft` 上）、`--<s>-soft`（衬底）。深色主题下 `-text` 与图形色大多同值；浅色主题要分开。

| 状态        | 深色 图形 / 文字 / 衬底            | 浅色 图形 / 文字 / 衬底     | 验证（文字对 card；文字对 soft） |
| ----------- | ---------------------------------- | --------------------------- | -------------------------------- |
| danger      | `#ff453a` / `#ff9c94` / 16%        | `#d70015` / `#b8000f` / 10% | 深 6.9；5.9 ｜ 浅 6.9；5.8       |
| warn        | `#ff9f0a` / `#ff9f0a` / 16%        | `#a35a00` / `#8f4e00` / 10% | 深 6.8；5.0 ｜ 浅 6.5；5.7       |
| caution     | `#ffd60a` / `#ffd60a` / **新** 16% | `#7f6000` / 同 / **新** 10% | 深 9.9 ｜ 浅 5.9                 |
| success     | `#32d74b` / `#32d74b` / 16%        | `#177a2e` / `#15702a` / 10% | 深 7.3；5.3 ｜ 浅 6.2；5.4       |
| working     | `#d97757` / `#e08a6e` / 18%        | `#b8532f` / `#9e4526` / 14% | 深 5.3 ｜ 浅 6.3；5.5            |
| danger 实底 | `#d93025`（白字 4.8）              | `#d70015`（白字 5.4）       |                                  |

新增 `--caution-text`（深色同图形值，浅色同 `--caution`）与 `--caution-soft`，让 caution 也有三件套。状态语义映射（`StatusPill` 的 tone）保持：`working / attention(=warn) / failed(=danger) / queued / paused(=muted-foreground) / unread(=brand) / idle(=faint，只做圆点) / done(=success)`；新增 `--status-done: var(--success)`，功能代码不再直接写 `var(--success)` 表示完成。

功能代码里状态文字一律写语义类：`text-danger-text / text-warn-text / text-success-text / text-working-text`；`text-destructive` 只留给 ui/ 生成件；`text-[var(--warn)]`、`text-[var(--success)]`（图形色当文字）禁止，由守卫测试拦（§10）。

### §2.4 Agent 品牌色（含 `ama`）

不变。`--agent-<id>` 是标识色（头像底、圆点、节点头部色标、连线上的归属）；`--agent-<id>-text` 是文字色。深色主题标识色保持各家品牌原值，文字色在需要时提亮；浅色主题两者合一，统一用压暗值。

| id       | 深色 标识 | 深色 文字（对 card ≥4.5） | 浅色 标识 = 文字 |
| -------- | --------- | ------------------------- | ---------------- |
| claude   | `#d97757` | `#e08a6e`（5.3）          | `#a85c43`        |
| codex    | `#10a37f` | `#2fbd97`（5.9）          | `#0c7f63`        |
| opencode | `#a78bfa` | 同（5.1）                 | `#7763b3`        |
| pi       | `#e8b86d` | 同（7.7）                 | `#886c3f`        |
| omp      | `#d4a373` | 同（6.2）                 | `#8a6a4a`        |
| copilot  | `#a371f7` | `#b78df7`（5.4）          | `#835bc6`        |
| ama      | `#1cb5c9` | 同（5.7）                 | `#137c8a`        |

- `--on-agent`：实底头像上的字——深色 `#1c1c1c`，浅色 `#ffffff`。
- Agent 文字色只用在 `--bg / --panel / --card` 上；在 `--surface-raised` / `--surface-overlay` 上改用 `--text` 配一个色点。
- 自定义 Agent（`custom:*`）沿用注册表里的 `color` 做标识，文字色一律退回 `--text` + 色点。
- `--agent-working` 与 claude 同源（陶土色），但它是状态色，不是 claude 的标识。

### §2.5 成员色（多人协同）

不变：八色环 `--member-1..8`，深色前七条等于 `--node-color-1..7`，自己永远是 `--member-1`。小地图类型色 `--mm-*`、上下文连线 `--link-context`（深 `#ff5fb8` / 浅 `#c2187a`）不变。

### §2.6 字号、字重、行高

**字体**。界面 `--font-ui` 首位是 Inter（`"Inter Variable"`，开光学尺寸轴），等宽 `--font-code` 首位是 Geist Mono（`"Geist Mono Variable"`）；两款都是 SIL OFL 1.1 的可变字体，由 `@fontsource-variable/*` 随包本地打包（`main.tsx` 最先引入，woff2 由 Vite 打成本地资源，CSP `font-src 'self' data:` 不用改），不加载在线字体，登记在 `THIRD_PARTY_NOTICES.md`。两款只覆盖拉丁、希腊、西里尔，中文逐字回退到后面原有的系统字体链（PingFang SC / Microsoft YaHei / Noto Sans CJK SC）。终端不跟着换：xterm 建实例时就量字宽，网页字体没到就会量错整格，所以终端单独读 `--font-term`（系统等宽链，即 `--font-code` 去掉首位），偏好里填的字体照旧优先；编辑器、代码块、元信息行用 `--font-code`。

**阶梯（六档）**。界面不出现 11px 以下（`type-scale.test.ts` 守着）。

| token                | 值   | 行高 | 字重      | Tailwind 类 **新**                 | 用途                                                        |
| -------------------- | ---- | ---- | --------- | ---------------------------------- | ----------------------------------------------------------- |
| `--text-display`     | 22px | 28px | 590       | `text-display`                     | 登录页、设置工作台页头、KPI 大数字、手机整页的页标题        |
| `--text-title`       | 17px | 24px | 590       | `text-title`                       | 对话框标题（**改**：`DialogTitle` 从 15 回到 17）、抽屉标题 |
| `--text-section`     | 15px | 22px | 500       | `text-section`                     | 卡片标题、表格卡标题、消息流里的分段                        |
| `--text-body`        | 13px | 19px | 400 / 500 | `text-body`                        | 正文、标签、按钮、输入、菜单项、设置行、表格单元格          |
| `--text-meta` **新** | 12px | 16px | 400       | `text-meta`                        | 次要行、元信息（时间、路径、字节）、代码块、按钮 xs         |
| `--text-caption`     | 11px | 16px | 400 / 500 | `text-caption`                     | 胶囊、脚注、连线标签、分组小标题                            |
| `--text-input-touch` | 16px | —    | —         | （只在 `Input / Textarea` 手机档） | 手机上的输入字号，防 iOS 聚焦缩放                           |

`--text-code`（12px）保留为 `--text-meta` 的别名，代码块行高 1.5。行高列的值是 `tokens.css` 的 `--leading-display / title / section / body / meta / caption`，`app.css` 的 `@theme` 读它们，不写死 px。

**13 与 14 的冲突，这样收口**：shadcn 生成件写的是 Tailwind 刻度（`text-sm` = 14、`text-xs` = 12），功能代码写的是 13。本次在 `app.css` 的 `@theme` 里把刻度本身对齐到阶梯：`--text-sm: 13px`（行高 19px）、`--text-xs: 12px`（行高 16px）、`--text-base` 保持 16px（只给手机输入与 `text-base md:text-sm` 这一种写法）。这样 ui/ 里的 `text-sm` 不用逐个改就落到 13；功能代码**只写语义类** `text-body / text-meta / text-caption / text-section / text-title / text-display`，任意值 `text-[13px]` 等由守卫测试禁止（§10），存量用 codemod 一次换掉。

**字重**：三档令牌 `--fw-regular` 400（正文）、`--fw-medium` 500（标签与按钮）、`--fw-semibold` 590（标题，比 600 略收）。medium 不取 510：中文回退到只有整百字重的字体（雅黑 400 / 700、Noto CJK 500 / 700）时，CSS 字重匹配会把 510 向上落到 700。`app.css` 的 `@theme` 把 Tailwind 的 `font-normal / font-medium / font-semibold` 映射到这三档，CSS 与内联样式里写 `var(--fw-*)`，不写数字。不用 700 及以上（`font-bold / extrabold / black` 由守卫规则 `font-heavy` 拦），不用 300 以下。

**字距**：只收紧两档大标题——`text-display` 读 `--ls-display`（-0.015em），`text-title` 读 `--ls-title`（-0.01em），写在 `app.css` 的 `@layer base`；其余 0。小标签与胶囊不放宽字距（中文会散）；标题不全大写，分组小标题是 `text-caption` 510 的 `--muted-foreground`，不大写。

**数字**：所有会变的值（计时、计数、字节、百分比、版本、价格）加 `tabular-nums`；元信息行整行用 `--font-code`。`app.css` 新增 `@layer base { [data-numeric], time, kbd { font-variant-numeric: tabular-nums } }`，组件里的数字容器统一标 `data-numeric`。千分位与相对时间一律 `Intl.NumberFormat / RelativeTimeFormat`，不手拼。

**换行**：标题 `text-wrap: balance`，可换行的次要文字 `text-wrap: pretty`，路径与 ID `overflow-wrap: anywhere`，标签与胶囊 `whitespace-nowrap`。

### §2.7 间距与布局常量

4px 基数：`2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32`。间距层级不变：

| token             | 值   | Tailwind 刻度 | 用在                                                       |
| ----------------- | ---- | ------------- | ---------------------------------------------------------- |
| `--space-item`    | 4px  | `1`           | 一个控件或一行之内：图标与文字、标签与数值                 |
| `--space-group`   | 8px  | `2`           | 同组并列：卡片之间、列表项之间、按钮组；标题与它下面的内容 |
| `--space-inset`   | 12px | `3`           | 卡片、行、小面板的内边距                                   |
| `--space-block`   | 16px | `4`           | 一个区块里的子块之间；大卡片与对话框以外的容器的宽松内边距 |
| `--space-section` | 24px | `6`           | 不同主题的区块之间；设置工作台内容面板的内边距             |
| `--space-page`    | 16px | `4`           | 抽屉、面板、整页内容区的外边距（对话框仍是 24）            |

规则 1–6 不变（由内向外只增不减、内松外紧、区块 ≥ 2× 容器内边距、标题贴内容、密集区守比例、容器层用 token 叶子层用刻度）。

**控件内边距（新，按高度档）**：24 → `px-1.5`（6）、28 → `px-2`（8）、32 → `px-2.5`（10）、36 / 44 → `px-3`（12）；图标与文字之间 `gap-1`（24 / 28）或 `gap-1.5`（32 以上）。

**行高（新，密度）**：

| 行                                   | 高度                  | 说明                                          |
| ------------------------------------ | --------------------- | --------------------------------------------- |
| 侧栏树行、会话行、菜单项、命令面板项 | 28                    | `py-1`，图标 14 / 16，文字 `text-body`        |
| 设置导航项、Tabs 触发器、工具条      | 28                    |                                               |
| 表头                                 | 32                    | `--surface-raised` 底、`text-caption` 500     |
| 表格行、通知行、运行记录行           | 36                    | `py-2`，控件 xs 24                            |
| 设置行                               | 40                    | `px-4 py-2`，控件 default 32（**改**：原 48） |
| 对话框底部按钮行                     | 32 控件 + `pt-4`      |                                               |
| 触屏                                 | 以上各加 8，命中 ≥ 44 |

布局常量：

| 常量                                                     | 值                                                            | 说明                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `--tabbar-h`                                             | 44px                                                          | 标题栏                                                                          |
| `--row-h` **新**                                         | 28px                                                          | 非控件的行高（树行、Git 行、工具条行）；类写 `h-(--row-h)`，不手写 `h-[28px]`   |
| `--row-h-table` **新**                                   | 36px                                                          | 表格行、通知行、横幅行；类写 `h-(--row-h-table)`                                |
| `--sidebar-w`                                            | 240px                                                         | 左侧栏                                                                          |
| `--dock-h`                                               | 44px                                                          | Dock；钮 32，图标 18                                                            |
| `--drawer-w`                                             | 360px                                                         | 右侧抽屉                                                                        |
| `--scm-w`                                                | 460px                                                         | 源码控制抽屉                                                                    |
| `--settings-dialog-w/h` **改**                           | `calc(100vw - 96px)` × `calc(100dvh - 96px)`，上限 1280 × 860 | 设置工作台（§5.17）：四周各留 48px；平板满宽 −32、满高 −48；手机底部 Sheet 整高 |
| `--settings-nav-w` **新**                                | `clamp(200px, 18%, 256px)`                                    | 工作台左导航                                                                    |
| `--settings-topbar-h` **新**                             | 48px                                                          | 工作台顶栏（面包屑 + 搜索）                                                     |
| `--mobile-nav-h`                                         | 56px                                                          | 手机底部导航（不含安全区）                                                      |
| `--safe-*`、`--window-controls-*`、`--overlay-inset-top` | 不变                                                          |                                                                                 |
| 节点头部                                                 | 30px                                                          | 头部图标钮 24，折叠高 32                                                        |
| 对话框                                                   | 520（表单）、420（确认）；边距 24；手机上改底部 Sheet         |                                                                                 |
| 触屏命中区                                               | ≥44px（可用 `::after` 扩）；桌面 ≥ 24px                       | 手写 `min-h-10 / h-11` 改用 `Button size="touch"`                               |

断点：手机 ≤767px（`isCompactLayout`）；平板 768–1023px；桌面 ≥1024px。画布内继续用容器查询（1000 / 760 / 440 / 360）。

### §2.8 圆角

**改**：七档语义，同心规则「外圆角 = 内圆角 + 内边距」。shadcn 别名重新对齐到这张表，`--r-sm / --r-md / --r-lg / --r-xl` 四个原始名**删**，功能代码只写语义类。

| token         | 值    | Tailwind 类（= shadcn 别名）        | 用在                                                                             |
| ------------- | ----- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `--r-tight`   | 4px   | `rounded-tight`（= `rounded-sm`）   | Kbd、favicon、热力图格、刻度条的格、24px 控件内嵌块、Tooltip 箭头                |
| `--r-control` | 6px   | `rounded-control`（= `rounded-md`） | 按钮、输入、Select、菜单项、Tabs 触发器、Switch 轨道外、Checkbox                 |
| `--r-card`    | 10px  | `rounded-card`（= `rounded-lg`）    | 卡片、节点、菜单容器（6 + 4）、Tabs 列表（6 + 3，取 10）、托盘内卡、表格卡、横幅 |
| `--r-panel`   | 12px  | `rounded-panel`（= `rounded-xl`）   | 侧栏面板、Dock、抽屉、Popover、小地图                                            |
| `--r-dialog`  | 14px  | `rounded-dialog`                    | Dialog、Sheet 顶角、节点光晕外圈（10 + 4）                                       |
| `--r-float`   | 16px  | `rounded-float`（= `rounded-2xl`）  | 设置工作台内容面板、审批卡（6 + 10）、KPI 托盘外层（10 + 6）                     |
| `--r-pill`    | 999px | `rounded-pill`（= `rounded-full`）  | 头像、圆点、Badge、StatusPill、分段控件指示器                                    |

ui/ 生成件里 `Button / Input / SelectTrigger / Textarea` 的 `rounded-lg` 改为 `rounded-control`，`Card` 的 `rounded-xl` 改为 `rounded-card`，`PopoverContent / DropdownMenuContent / ContextMenuContent` 改为 `rounded-card`（菜单项 6 + `p-1` 4），`DialogContent` 改为 `rounded-dialog`。`--radius-2xl/3xl/4xl` 的 `calc` 删，Badge 改 `rounded-pill`。裸 `rounded`、`rounded-sm/md/lg/xl`、`rounded-[14px]`、`rounded-[var(--r-*)]` 在功能代码里由守卫禁止（§10）。

### §2.9 层级与阴影

边框表达结构，阴影只表达「浮在上面」。

| 层       | 表面                | 边                    | 阴影 token                                             | 深色值                                                     | 浅色值                                                     | 例                                        |
| -------- | ------------------- | --------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| 0 底     | `--bg` / `--canvas` | —                     | 无                                                     |                                                            |                                                            | 窗口、画布                                |
| 1 面板   | `--panel`           | 1px `--border`        | 无                                                     |                                                            |                                                            | 侧栏、Dock 槽、工具簇、抽屉、托盘外层     |
| 2 卡片   | `--card`            | 1px `--border`        | **无**（**删** `--shadow-pill`，不加 `--shadow-card`） |                                                            |                                                            | 设置分组、托盘内卡、表格卡、消息卡        |
| 2 节点   | `--card`            | 1px `--border`        | `--shadow-node` **改**                                 | `0 1px 2px rgb(0 0 0 / 20%), 0 4px 12px rgb(0 0 0 / 14%)`  | `0 1px 2px rgb(0 0 0 / 8%), 0 4px 12px rgb(0 0 0 / 6%)`    | 画布节点（拖动中加倍）                    |
| 3 浮层   | `--surface-overlay` | 1px `--border-strong` | `--shadow-overlay` **改**                              | `0 4px 12px rgb(0 0 0 / 28%)`                              | `0 4px 12px rgb(0 0 0 / 8%)`                               | 菜单、Popover、Tooltip、Dock、横幅、Toast |
| 4 对话框 | `--card`            | 1px `--border-strong` | `--shadow-dialog`                                      | `0 2px 8px rgb(0 0 0 / 24%), 0 24px 64px rgb(0 0 0 / 36%)` | `0 2px 8px rgb(0 0 0 / 12%), 0 24px 64px rgb(0 0 0 / 18%)` | Dialog、Sheet、焦点页                     |

另有两类不表达层次的投影也是令牌：展示页强制焦点态的 `--shadow-focus-ring`（3px、`--ring` 50%，与生成组件的 `ring-3 ring-ring/50` 一致），节点状态光晕 `--shadow-glow-unread / working / attention / failed`（2px 实环 + 18px 晕）。

ui/ 里的 `shadow-md / shadow-lg / shadow-sm / ring-1 ring-foreground/10` 全部换成 1px `border-border` 或这三个 token 的工具类 `shadow-node / shadow-overlay / shadow-dialog`；功能代码禁止 `shadow`、`shadow-sm/md/lg` 与 `shadow-[…]`。阴影不做动画；需要动的阴影用 `filter: drop-shadow()`。

### §2.10 动效

动效令牌与配方全部在 §8；这里只列名字，`tokens.css` 与 `styles/motion.css` 逐条对应。

| token                  | 值                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dur-instant` **新** | 100ms                                                                                                                                                                                       |
| `--dur-fast`           | 120ms                                                                                                                                                                                       |
| `--dur-base` **改**    | 160ms（原 150）                                                                                                                                                                             |
| `--dur-slow` **改**    | 200ms（原 180）                                                                                                                                                                             |
| `--dur-page` **改**    | 280ms（原 220）                                                                                                                                                                             |
| `--dur-hero` **新**    | 600ms                                                                                                                                                                                       |
| `--ease-out` **改**    | `cubic-bezier(0.23, 1, 0.32, 1)`（原 `(0.32, 0.72, 0, 1)` 改名为 `--ease-drawer`）                                                                                                          |
| `--ease-in-out` **新** | `cubic-bezier(0.77, 0, 0.175, 1)`                                                                                                                                                           |
| `--ease-drawer` **新** | `cubic-bezier(0.32, 0.72, 0, 1)`                                                                                                                                                            |
| `--ease-color` **新**  | `ease`                                                                                                                                                                                      |
| `--press-scale` **新** | 0.97                                                                                                                                                                                        |
| `--pop-scale` **新**   | 0.96                                                                                                                                                                                        |
| `--stagger` **新**     | 40ms                                                                                                                                                                                        |
| `--dur-loop-*` **新**  | 一圈的时长：`pulse` 1600 · `rope` 1000 · `delivery` 600 · `shimmer` 1400 · `spin` 800 · `indeterminate` 1200 · `glow` 2000 · `glow-working` 2600 · `glow-attention` 1800 · `bell` 600（ms） |

没有回弹曲线；`linear` 只给 spinner、进度与长按填充。界面动效不超过 300ms，开屏的 `--dur-hero` 是唯一例外（一次性的启动序列）；状态指示动画（循环的脉冲、流光、微光、转圈、不确定进度、光晕，以及终端铃声闪两下）不是界面过渡，一圈的时长读 `--dur-loop-*`，不在样式表里写字面时长。

### §2.11 z 轴

不变：`pills 5 · canvas-overlay 8 · sessions 12 · dock 20 · cluster 26 · banners 27 · shared-session 28 · tabbar 30 · focus 40 · menu 46 · dialog 55 · focus-page 60 · toast 70 · splash 90`。`tokens.css` 里把 `--z-canvas-overlay` 挪到 `--z-pills` 之后（只是顺序）。ui/ 生成件的 `z-50` 改成 `z-[var(--z-menu)]` / `z-[var(--z-dialog)]`，功能代码不再逐个覆盖。

### §2.12 图标

`lucide-react`，**线宽 1.5 全局生效**：`app.css` 加 `@layer base { .lucide { stroke-width: 1.5px } }`，组件里的 `strokeWidth={1.5}` 与 `[&_svg]:[stroke-width:1.5]` 删掉；只有 600 字重标题旁的图标允许 2（显式写）。尺寸四档，由容器决定、图标自己不写尺寸：

| 尺寸 | 容器                                                        | 类            |
| ---- | ----------------------------------------------------------- | ------------- |
| 12   | `Button size=xs`、Badge 内、表格行内的状态图标              | `size-3`      |
| 14   | `Button size=sm`、`IconButton inline`、节点头部、列表行前导 | `size-3.5`    |
| 16   | `Button` 默认、菜单项、`IconButton cluster`、设置导航、空态 | `size-4`      |
| 18   | `IconButton dock`、底部导航                                 | `size-[18px]` |

图标钮必有 `aria-label`（`IconButton` 强制）。图标用 `currentColor`，状态靠颜色与透明度，不换素材；线性是默认，实心只表示「激活」。Agent 没有各家 logo。

### §2.13 控件高度 **新**

| 档    | 高度 | Button size    | Input / Select | 用在                                             |
| ----- | ---- | -------------- | -------------- | ------------------------------------------------ |
| xs    | 24   | `xs`           | `xs` **新**    | 节点头部、表格行内、胶囊簇旁、编辑器外栏         |
| sm    | 28   | `sm`           | `sm`           | 工具条、抽屉标题行、筛选行、Git 工具条、设置导航 |
| md    | 32   | `default`      | `default`      | 设置行、表单、对话框、PromptBox                  |
| lg    | 36   | `lg`           | —              | 登录页、空态主动作                               |
| touch | 44   | `touch` **新** | `touch` **新** | 手机连接 / 登录页、触屏底部 Sheet 里的主动作     |

同一行里的控件取同一档；手写 `h-6 / h-7 / h-9 / h-10 / h-11 / min-h-10` 禁止（§10）。

## §3 组件清单

### §3.1 已有（`apps/web/src/ui/`）

本次改动后的变体 / 尺寸（完整尺寸、状态、动效、无障碍要求见 §9）：

| 组件                                                                                                                                                                         | 变体 / 尺寸                                                                                                                                                                                                                                | 本文约定的用法                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `button`                                                                                                                                                                     | default（品牌蓝实底）/ outline / secondary / ghost / destructive（软）/ **新** destructive-solid / link；xs 24 · sm 28 · default 32 · lg 36 · **新** touch 44 · icon\*；**新** `loading`、**新** `static`、**新** `shortcut`（尾部 `Kbd`） | 主动作 default（一屏一个）、次要 outline、行内 ghost、危险确认 destructive-solid |
| `icon-button`（封装）                                                                                                                                                        | cluster 28 / dock 32 / inline 24，`active`，**新** `shortcut`（进 Tooltip）                                                                                                                                                                | 全部纯图标钮；危险确认用 `variant="destructive-solid"`                           |
| `badge`                                                                                                                                                                      | default / secondary / destructive / outline / ghost / link / **新** success / **新** warn / **新** brand；**新** size sm 18 · md 20                                                                                                        | 角色、通道、计数、风险；节点头胶囊 = `outline` + `sm`                            |
| `status-pill`（封装）                                                                                                                                                        | **改** 组件族：`StatusDot` / `StatusPill` / `StatusLine`；tone × size × pulse                                                                                                                                                              | 一切「运行中 / 需要你 / 失败 / 完成 / 离线」的展示（§11）                        |
| `color-dot` / `member-dot` / `agent-avatar` / `brand-mark`                                                                                                                   | 不变                                                                                                                                                                                                                                       |                                                                                  |
| `kbd`                                                                                                                                                                        | **改** 20 高（按钮 / Tooltip 内 16）、`rounded-tight`、`text-caption` 500、等宽、`--surface-raised` 底                                                                                                                                     | 快捷键提示；所有主操作旁                                                         |
| `input` / `textarea` / `input-group`                                                                                                                                         | **新** size xs 24 · sm 28 · default 32 · touch 44；手机档 16px                                                                                                                                                                             | 设置行右侧控件、工具条筛选                                                       |
| `select` / `switch` / `slider` / `toggle` / `toggle-group` / `checkbox` / `radio-group`                                                                                      | `SelectTrigger` size 与 Input 同四档                                                                                                                                                                                                       |                                                                                  |
| `tabs`                                                                                                                                                                       | `TabsList` variant default / line / **新** segmented（滑动指示器）                                                                                                                                                                         | 对话框内分页；表格卡筛选、设置分段、有效期分段都用 `segmented`                   |
| `card`                                                                                                                                                                       | size default / sm；**新** variant default / tray / table                                                                                                                                                                                   | 设置分组、托盘内卡、表格卡、消息卡、权限卡                                       |
| `dialog` / `alert-dialog` / `sheet`                                                                                                                                          | 手机 ≤767 一律 `Sheet side="bottom"`（`panels/ResponsiveDialog`）；**新** `data-instant`（键盘打开时无动画）                                                                                                                               | 标题 `text-title`，无 `Description`（§6）                                        |
| `dropdown-menu` / `context-menu` / `popover` / `hover-card` / `tooltip` / `command`                                                                                          | 发芽式出场（§8.3）；`TooltipContent` **新** `shortcut`；`Command` 无开关动画；触屏不出 Tooltip                                                                                                                                             |                                                                                  |
| `progress`                                                                                                                                                                   | tone brand / warn / danger / **新** success；**新** variant bar / ticks（刻度条）                                                                                                                                                          | 用量、上下文、更新下载、KPI 内卡                                                 |
| `empty` / `state`                                                                                                                                                            | `EmptyState` / `ErrorState`，`inline`                                                                                                                                                                                                      | 所有空态与错误；`Empty` 不在功能代码里直接用                                     |
| `skeleton` / `skeletons` / `spinner`                                                                                                                                         | `Spinner` **新** `state: spinning / done / failed`，一圈 0.8s                                                                                                                                                                              | 加载与完成反馈                                                                   |
| `sonner`                                                                                                                                                                     | **改** `Toaster` 配置固定（§9）；功能代码只从 `ui/toast.tsx` 调 `toast`                                                                                                                                                                    | 失败与需要撤销的动作                                                             |
| `table` / `item` / `accordion` / `collapsible` / `button-group` / `scroll-area` / `resizable` / `separator` / `chart` / `input-otp` / `label` / `field` / `alert` / `avatar` | 不变                                                                                                                                                                                                                                       |                                                                                  |

### §3.2 经 shadcn CLI 新增

已全部加入（avatar、card、alert、empty、skeleton、spinner、checkbox、radio-group、label、field、input-otp、table、item、collapsible、accordion、button-group）。本次不再新增 shadcn 组件；不加：`drawer`、`calendar / date-picker`、`navigation-menu / menubar / sidebar`、`breadcrumb`（设置面包屑用 `nav + ol`，见 §5.17）。

### §3.3 仓库自己的薄封装（放 `ui/`，只做取色、尺寸预设与动效配方）

| 文件                                                                         | 内容                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui/agent-avatar.tsx`                                                        | `Avatar` + 首字母 + `--agent-<id>` 底 / `--on-agent` 字；`size` 20/24/32；首字母用 `Intl.Segmenter` 取第一个字素（emoji 与代理对不裂）                                                                                                                                                                       |
| `ui/member-dot.tsx`                                                          | `ColorDot` 预设 `--member-n`，带 `title`                                                                                                                                                                                                                                                                     |
| `ui/status-pill.tsx` **改**                                                  | `StatusDot` / `StatusPill` / `StatusLine` 三件（§11）；`TONE_COLOR`、`STATUS_PILL_TEXT`、`STATUS_PILL_PULSES` 保留                                                                                                                                                                                           |
| `ui/tray.tsx` **新**                                                         | `Tray`（外层 `--panel` + 发丝边 + `rounded-float` + `p-1.5`）、`TrayHeader`（图标 14 + `text-meta` 标签 + 右侧动作槽）、`TrayCard`（内层 `Card` `rounded-card`）、`TrayValue`（`text-display` 等宽大数字，内部用 `AnimatedNumber`）、`TrayTrend`（箭头 + 增减，success / danger 文字色）                     |
| `ui/animated-number.tsx` **新**（从 `panels/usage/AnimatedNumber.tsx` 移入） | 数字滚动：400ms `--ease-out`，`tabular-nums`，减少动效直接跳                                                                                                                                                                                                                                                 |
| `ui/text-swap.tsx` **新**                                                    | 文字替换过渡（「复制」→「已复制」、胶囊文案、Dock 百分比）：旧字淡出 + 模糊 2px，新字淡入，容器宽度 `--dur-base` 平滑；减少动效直接换                                                                                                                                                                        |
| `ui/indicator.tsx` **新**                                                    | 共享指示器：同组元素的「当前项 / 悬停」底块，用 `motion` 的 `layoutId` 在组内平移（设置导航、分段控件、Tabs line、Dock 工具组）；页面忙时用完整 `transform` 字符串                                                                                                                                           |
| `ui/shimmer.tsx` **新**                                                      | 文字微光（加载中的按钮标签、思考行标签）：`.anim-shimmer` 遮罩 1.4s 线性循环；减少动效静止                                                                                                                                                                                                                   |
| `ui/agent-tree.tsx` **新**                                                   | 缩略 Agent 树（§11.1）：自上而下的正交树，节点是状态色小方块，连线 1px 发丝；`size sm`（≤ 96×48，通知行右侧）/ `md`（≤ 240 宽，带极短标签与折叠，弹层与活动卡用）；纯展示，数据由 `agent/agent-tree-model.ts` 组装                                                                                           |
| `ui/toast.tsx` **新**                                                        | 对 sonner 的唯一入口：`toast.success / error / info / loading / promise / dismiss`，用 `toast.custom` 渲染本设计系统的壳（`--surface-overlay`、1px `--border-strong`、`rounded-panel`、`StatusDot` / `Spinner` 前导、`Button xs outline` 动作、`Kbd` 可选）；功能代码不直接 `import { toast } from "sonner"` |

其余（光标、评论钉、差异块、工具调用行、KPI 页块）是功能组件，各自放在功能目录，组合上面这些基础件。

### §3.4 状态矩阵（每个控件都要过）

默认 / hover（`--hover` 底，`--dur-instant`，只在 `(hover: hover) and (pointer: fine)`）/ active（`scale(0.97)` + `--active` 底，`:hover:active` 才生效，`--dur-instant`）/ focus-visible（3px ring 50%，无过渡）/ disabled（50% 不透明，不接指针，不参与指示器共享）/ aria-invalid（destructive 边 + 20% 环）/ loading（`aria-busy`，图标换 `Spinner`，标签微光，宽度不变，**仍可聚焦**）/ 选中（`--brand-soft` 底 + `--brand-text` 字，不加粗）。

## §4 画布视觉语言

| 元素                                   | 外观                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 节点外壳 `NodeShell`                   | `--card` 底、1px `--border`、`rounded-card` 10、`--shadow-node`；头部 30px 同色，底部 1px 分隔；折叠 32px。**改**：悬停时边框 `--border-strong`（`--dur-fast`），拖动中 `data-dragging` 阴影加倍并 `will-change: transform`，松手无惯性；新建节点入场 `opacity 0→1 + scale 0.96→1` `--dur-slow`，删除只做淡出 `--dur-fast`（§8.5）                                                                                          |
| 节点头                                 | 四段从左到右：身份（色点 标题 名字 主从）→ 胶囊簇 → 状态 → 审批 → 动作（`···` ×）；全部常显。**改**：标题 `text-meta` 500；胶囊一律 `Badge outline size=sm`（18 / caption / `px-1.5` / 等宽）；状态段是 `StatusDot 8`（空闲不画）或 `StatusPill sm`（节点 ≥ 560 宽且非空闲时带字，否则只点）；动作钮 `IconButton inline` 24；段内 4px（审批、动作 2px），段间 8px；胶囊簇最多占 40%、多于 3 枚折成计数；≤440 藏胶囊簇与状态 |
| 终端 / Agent 节点头                    | 身份段：Agent 色点 6 + 标题；SSH 标签 `Badge outline sm` 带 14px 图标；头部上的允许 / 拒绝两枚 `Button xs`（允许 `default`、拒绝 `outline`），≤440 只剩图标                                                                                                                                                                                                                                                                 |
| 便签 `StickyNode`                      | **改**：颜色只做顶部 3px 色条 + 底色 `color-mix(便签色 10%, --card)`；正文 `text-body`；底栏 `text-caption` 等宽（字数、修改时间）；唯一的 `role="button"` 改成 `Button ghost size=xs` 或整块 `Textarea`                                                                                                                                                                                                                    |
| 编辑器 / 文件 / 差异 / 自动化          | 外栏按钮全部 `Button size=xs`（删掉 `size=sm className=h-6`）；未保存点 `StatusDot 6 tone=attention`；差异行 `+N −M` 用 `text-success-text / text-danger-text`，行底 `--success-soft / --danger-soft`；文件树行 28px；自动化节点的状态列 `StatusPill sm`                                                                                                                                                                    |
| 选中                                   | 边框换 `--brand` 1.5px；多人时他人的选区是 1.5px **虚线** 成员色，自己实线                                                                                                                                                                                                                                                                                                                                                  |
| 光晕                                   | unread 品牌蓝 / working 陶土 / attention 橙 / failed 红，外圈 `rounded-dialog` 14（10 + 4），只动 opacity，`ease-in-out` 循环呼吸是允许的例外                                                                                                                                                                                                                                                                               |
| 把手                                   | 四边中点各一个，14px 圆、`--card` 2px 描边；触屏 16 / 命中 36；悬停或选中时 `--foreground`；吸附时 `--dur-slow` `--ease-in-out` 软位移，不可连接时把手变 `--danger` 并左右各 2px 抖两次（`armadra-shake` 240ms linear，无回弹曲线）                                                                                                                                                                                         |
| 连线 `link` 对等（上下文）             | 2px `--link-context`，就近边，按类型定箭头；标签胶囊：纸色底、线色描边、`text-caption` 等宽；选中 3.5px `--brand`                                                                                                                                                                                                                                                                                                           |
| 连线 `link` 派发（`role: supervises`） | 2px 簇色（`familyOf`：`--node-color-1/2/3/6/7` 五色循环），只在子一端画箭头；选中 3.5px `--brand` 并写「派发」                                                                                                                                                                                                                                                                                                              |
| 连线 `reference`                       | 1.5px 点线 `--muted-foreground`，无箭头                                                                                                                                                                                                                                                                                                                                                                                     |
| 等待 / 投递                            | rope 1s 流动虚线；投递 0.6s 流光，两秒后撤                                                                                                                                                                                                                                                                                                                                                                                  |
| 分组                                   | 1.5px 节点色边 + `--panel` 22% 底、`rounded-card`；标签 `text-caption` 500 在左上外侧；选中时 `outline 2px --brand` 偏 2px                                                                                                                                                                                                                                                                                                  |
| 工具栏 Dock                            | 44 高、`rounded-panel` 12、`--panel` 90% + `backdrop-blur 12`、1px `--border-strong`、`--shadow-overlay`；钮 `IconButton dock` 32，每钮 Tooltip 带 `Kbd`；**改**：工具组的激活项用共享指示器平移（`ui/indicator`），缩放百分比用 `TextSwap`；分隔线 `Separator` 20 高                                                                                                                                                       |
| 右上工具簇                             | `--panel` 条、1px `--border`、`IconButton cluster` 28，同一条里悬停底块共享                                                                                                                                                                                                                                                                                                                                                 |
| 小地图                                 | 填充按 `familyOf` 混透明，浓度取 `--mm-fill` / `--mm-fill-selected` / `--mm-fill-plain`（深色 55% / 80% / 35%，浅色 32% / 50% / 25%），描边三种状态色；`rounded-panel` 12、1px `--border-strong`、`--shadow-overlay`、`backdrop-blur 12`；收起钮悬停出现；专注模式隐藏                                                                                                                                                      |
| 横幅 `Banners`                         | 36 高、`rounded-card`、`--panel` 90% + 模糊、1px `--border-strong`、`--shadow-overlay`；tone danger / warn / **新** success / info（=brand）用 `StatusDot 6` + 文字色                                                                                                                                                                                                                                                       |
| 成员光标 / 选区 / 评论钉               | 不变（16px 箭头成员色 + 名字标签；1.5px 虚线；24px 圆钉）                                                                                                                                                                                                                                                                                                                                                                   |
| 协调者（ama）                          | 普通终端节点，头部色点 `--agent-ama`；派生成员自动连 supervises 边，组标题用 ama 色                                                                                                                                                                                                                                                                                                                                         |
| 工作流运行                             | 运行中的节点在头部状态前多一个 `Badge secondary sm`「第 n 步」；完成的节点边框 1px `--success`                                                                                                                                                                                                                                                                                                                              |

## §5 界面模式

每个模式给布局、组件、状态五元组（空 / 加载 / 错误 / 权限 / 离线）与文案键前缀。

### §5.1 ACP 会话视图（节点体 / 焦点页）

```text
┌ 节点头部（色点 标题 … 胶囊 允许/拒绝 ⋯）───────────────────────────────┐
│ ScrollArea                                                             │
│  ┌ 用户消息 ───────────────────────────┐  右对齐，--surface-raised      │
│  └──────────────────────────────────────┘                              │
│  助手消息（无底色；悬停右上 MessageActions：复制 · 落为便签 · ⋯）       │
│   ▸ 思考 · 12 s          （ThoughtRow：折叠；流式时标签微光 + 步骤逐条） │
│   ⌁ read  src/x.ts   +12 −3   ● 已完成  3 s   ▸   （ToolRow）          │
│   ┌ 权限卡 ApprovalShell ──────────────────────────────────┐            │
│   │ ⚠ 运行 `pnpm test`                      [有风险]        │            │
│   │ 将发生：src/x.ts +12 −3 · tests/x.spec.ts +31 −2        │            │
│   │ [本次 | 始终]                [拒绝 Esc]  [允许 ↵]        │            │
│   └─────────────────────────────────────────────────────────┘            │
│  活动行 StatusLine：◌ 调用工具 · pnpm test · 12 s                        │
├ PromptBox ─────────────────────────────────────────────────────────────┤
│ Textarea 1–6 行   [模式 ▾] [模型 ▾]   ▮▮▮▯▯ 18.3万/20万   [发送 ↵]     │
└────────────────────────────────────────────────────────────────────────┘
```

- 发言人不写名字：用户靠右，Agent 靠左，头像只在焦点页 / 多 Agent 聚合视图里出现。
- **工具调用行 `ToolRow`**（**改**）：图标 14 按 kind；工具名 `text-meta` 等宽；摘要（文件名胶囊最多 2 枚 + `+N`）；差异计数 `+N −M` 等宽着色；`StatusPill sm`；时长等宽；展开看入参与输出（`--surface-raised`，等宽 12px，最多 20 行后「展开全部」）。运行中的行标签微光，完成时 `Spinner state=done` 收成对勾。行高 28。
- **思考 `ThoughtRow`**（**改**）：折叠标题「思考 · 12 s」；流式时标题带 `Shimmer` + 阶段标签用 `TextSwap` 滚动；结束后固定成「思考了 12 s」。
- **活动行 `StatusLine`**（§11）：阶段 + 细节 + 计时，`aria-live=polite` 只播阶段。
- **权限卡**（**改**，仍出自 `approval/ApprovalShell`）：外壳 `Card` `rounded-float` 16 配 10px 内边距、1px `--warn` 40% 边；标题行 = 警示图标 14 + 动作名（命令等宽、最多 3 行、点开展开）+ 右侧 `Badge warn sm`「有风险」（只在 `toolKind` 为 `execute / delete / move` 时出现）；「将发生」行 = `locations` 文件胶囊与 `DiffBlock` 的 `+N −M`（有才出）；选项按 kind 折成**两段**：`Tabs segmented`「本次 ｜ 始终」+ 两枚按钮「拒绝 Esc」（`outline`，内嵌 `Kbd`）与「允许 ↵」（`default`，拿焦点）；选了「始终」时允许 = `allow_always`、拒绝 = `reject_always`（`reject_always` 用 `destructive`）。数字键 1–9 仍按选项顺序直答；答完焦点还给输入框。只有一张卡待答时固定在 PromptBox 上方。节点头部的允许 / 拒绝继续答第一组。
- **上下文窗口**（**改**）：PromptBox 右侧的用量改成 `Progress variant=ticks`（20 格，已用格 `--brand`，≥80% `--warn`，≥95% `--danger`）+ 等宽「18.3万 / 20万」；点开 `Popover`：大数字（已用 / 总量 / 百分比 `Badge`）、剩余 tokens（`--warn-text` 当 ≥80%）、费用（有才出）、「压缩」按钮（只在 Agent 的可用命令里有 `compact` 时出现，发送该命令）。不画分类图例——数据里没有分类。
- 切换视图：头部 `⋯` 里「会话视图 / 终端视图」打钩项（带 `Kbd`）；切换时节点体 `--dur-fast` 淡入，尺寸不变。
- 状态：空 → `EmptyState`「向它说第一句话」+ 聚焦输入框；加载历史 → 三条 `Skeleton`；流式中 → 最后一条消息尾部 `Spinner 12`；错误 → `ErrorState inline` + 「重试」；权限 → 上面那张卡；离线 → PromptBox 禁用，上方 `Alert`「已断开，正在重连」。
- 手机：同一组件铺满焦点页；PromptBox 坐在软键盘上；模式 Select 收进「⋯」。

### §5.2 输出到画板

不变：助手消息悬停出 `MessageActions`（`IconButton inline`）→ `DropdownMenu`：「落为便签」「落为白板文字」「代码块 → 编辑器」「Mermaid → 白板」。落成后相机 `--dur-base` 平移到新节点，节点带 `unread` 光晕一次。失败 → toast 一行「没有放到画板上」+「重试」。

### §5.3 派生与拖线建从

不变（节点菜单「派生」是 `ContextMenuSub`；从把手拖到空白处开同一份菜单的「派发」形态）。

### §5.4 协调者（ama）分派与汇总

汇总视图（右侧抽屉 `--drawer-w`）每行改用 `StatusLine`：`[Claude] src/x · ● 已完成 · 12 分钟`，左侧 2px `--agent-<id>`；成员失败 → 该行 `failed` + 行尾「重试」；离线 → 整树置灰 + 顶部 `Alert`。空态 → `EmptyState`「让 ama 组织一次分工」。

### §5.5 工作流：编辑器、模板库、运行历史

模板卡 `Card`（标题 `text-section`、元信息行 `text-caption` 等宽「3 角色 · 2 步 · 2 天前」、底部 [运行] default + [编辑] ghost）；运行历史 `Table`（时间 tabular · 模板 · 参数 · `StatusPill sm` · 产出 · [对比]），手机 `Item`。草案卡：画布上一张 `Card` 浮卡。

### §5.6 多人在线：光标、选区、头像

不变（`PresenceBar` 头像堆叠 `Avatar 20`，悬停互相挤开 `--dur-base`；写租约持有者 2px `--brand` 环）。

### §5.7 评论与讨论

不变（钉、抽屉线程、`Accordion` 折叠已解决）。空态 `EmptyState`「在画布上点一下放评论」。

### §5.8 角色与审批

不变（三档角色；非驱动者看到同一张权限卡，按钮换成 `Badge outline sm`「等待驱动者」）。

### §5.9 登录：口令、通行密钥、OAuth、SSO、多因素

布局不变（居中 360 列，`BrandMark 48`，标题 `text-display`）。按钮 `size=lg`（桌面）/ `touch`（手机），全部 `outline` 除「继续 / 登录」用 default。错误全部在 `Field` 下方一行，输入框左右各 4px 抖两次；锁定 `Alert destructive` + 倒计时等宽。

### §5.10 会话与设备管理

设置 → 设备与会话：`Table`（设备 · 平台 · 最近活动 tabular · [退出]），当前设备行 `Badge secondary sm`「当前」；通行密钥列表同页；见 §5.17 的页面块。

### §5.11 审计日志

`Card variant=table`：标题「审计」+ 右侧筛选（时间范围 `Select sm` · 成员 · 类型）；`Table`（时间 tabular · 成员头像+名 · 动作 · 对象 · 结果 `StatusPill sm`），行可展开看详情 JSON。「加载更多」outline。

### §5.12 Gateway 配对与设备列表

不变（QR 200px 白底黑码；配对码 `Kbd` 风格 8 位分组、倒计时等宽；已配对设备 `Table`）。

### §5.13 移动网页与原生壳

不变（底部导航 56 + 安全区；焦点页顶栏 48；对话框一律 `Sheet side="bottom"`；安全区与窗口控件处理见 `ui/safe-area.ts`）。按钮一律 `touch` 44；悬停才出现的动作在触屏上常显或长按。

### §5.14 更新与安装

设置 → 关于：状态集合按[更新设计](updates-and-service-install.md) §4.1，一行文字 + 一个按钮；下载中 → `Progress tone=brand` + 「取消」；已下载 → 「重启并更新」default + 「稍后」ghost；失败 → `Alert destructive` + 「重试」。chrome 里不出现版本号。

### §5.15 Agent CLI 与 SSH

主表改成 §5.17 的表格卡：一家一行（名称 · `StatusPill sm`：就绪 done / 需安装 attention / 需更新 attention / 已禁用 paused · 画布视图 · 动作）；状态正常时胶囊也出现（表格列对齐优先于「正常不出现」）。子页三组不变。SSH `Table`（名称 · 地址 `user@host:port` 等宽 · Worker `StatusPill sm` · [验证]）。

### §5.16 通用状态矩阵

| 状态 | 组件                                                                                 | 文案形态                                                     |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 空   | `EmptyState`（整块：虚线框 `rounded-card`、图标 16 可选；`inline`：一行灰字）        | 一句名词短语 + 至多一个 default 动作                         |
| 加载 | `ui/skeletons`（行 / 卡 / 表 / 表单 / 节点体 / 回合）或 `Spinner`（按钮 / 行内动作） | 不写「加载中…」                                              |
| 错误 | `ErrorState`（整块 / `inline`）/ toast（瞬时）                                       | 发生了什么 + 一个动作（重试 / 打开设置）；不显示原始异常文本 |
| 权限 | `Badge outline sm` 替代按钮，或分区不出现                                            | 「等待驱动者」「只读」                                       |
| 离线 | 顶部 `Alert`，输入禁用                                                               | 「已断开，正在重连」                                         |

加载态规则不变：只有没有可展示数据时才出骨架；短于 200ms 不显示，显示后至少停 300ms；骨架行高取 `SKELETON_ROW` 档位，与终态同布局；内容出现不得有布局跳动；读屏名字用 `state.loading`。功能代码不再直接用 `Empty`，`Empty` 的 `border-0 / py-*` 覆盖 **删**，统一走 `EmptyState` 的 `inline` 与 `className` 只允许外边距。边界状态（§12）在展示页夹具里必须出现。

### §5.17 设置工作台 **新**

参考 A 的布局：大窗（四周各留 48px）、左导航贴底、右侧一块大圆角内容面板「浮」在底上。

```text
┌ Dialog（--bg 底 + 色板渐变，rounded-dialog 14，--shadow-dialog）──────────────────────────────┐
│ 导航 --settings-nav-w          │ 顶栏 48：设置 › Agent › 用量          [搜索 ⌘F ····]  [本机] [×] │
│  常用        ← caption 500 灰  │ ┌ 内容面板 Card rounded-float 16，1px 边，p-6 ─────────────────┐ │
│  ☆ 默认                        │ │ 用量                                     [刷新]  [打开用量面板] │ │
│  ── 发丝线（两端渐隐）──        │ │ ┌ Tray ──────┐ ┌ Tray ──────┐ ┌ Tray ──────┐                    │ │
│  外观与交互                    │ │ │ ◔ Claude  ⋯│ │ ◔ Codex   ⋯│ │ ◔ Copilot ⋯│                    │ │
│  ⚙ 通用                        │ │ │ ┌ 82%     ┐│ │ ┌ 41%     ┐│ │ ┌ —       ┐│                    │ │
│  🔔 通知               [3]     │ │ │ │▮▮▮▮▮▮▮▮▯▯││ │ │▮▮▮▮▯▯▯▯▯▯││ │ │          ││                    │ │
│  …                             │ │ │ │ 5 小时 · 2:14 重置 ││ ...                                     │ │
│  Agent                         │ │ └────────────┘ └────────────┘ └────────────┘                    │ │
│  🤖 Agent CLI          [1]     │ │ ┌ SettingsGroup ─────────────────────────────────────────────┐ │ │
│  ◉ 用量  ← 选中：raised 底 +   │ │ │ 显示用量                                           [开关]   │ │ │
│          共享指示器平移         │ │ │ 刷新频率                                        [Select ▾] │ │ │
│                                │ │ └────────────────────────────────────────────────────────────┘ │ │
│                                │ │ ┌ Card table ─ 会话  [全部 | Claude | Codex]  查看全部 ───────┐ │ │
│                                │ │ │ 表头 raised 32 │ 行 36 │ 数字右对齐 │ StatusPill sm        │ │ │
│                                │ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────┴───────────────────────────────────────────────────────────────────┘
```

- **外层**：`DialogContent` `--settings-dialog-w/h`，底色 `--bg` 叠 `.material-backdrop`，无内边框；导航列直接贴底（无卡片），`p-4 pr-3`；内容面板 `Card` `rounded-float` 16、1px `--border`、`p-(--space-section)`，距顶栏 0、距右 / 下 16，内部滚动。⌘, 打开时无动画（`data-instant`），菜单 / 按钮打开时按 §8.3 对话框出场。
- **导航**：分组标题 `text-caption` 500 `--muted-foreground`，组间 `.hairline-x`；项 28px `Button ghost size=sm` 全宽左对齐，图标 16 + `text-body`，当前项 `--surface-raised` 底由 `ui/indicator` 平移；↑↓ 在项之间移动、回车打开；行尾可带 `Badge sm`：计数（通知未读、需安装的 Agent 数、待接受邀请数）或 `StatusDot 6`（本机服务离线 / 中继断开）——只放已有 store 能给的数。
- **顶栏**：面包屑 `nav aria-label` + `ol`：「设置 › {分组} › {页名}（› 子页）」，末级 `text-body` 500 `--text`，其余 `--muted-foreground`，分隔符 `›` `--faint`；右侧 `Input sm` 搜索（占位「搜索设置」，⌘F 聚焦，`InputGroup` 前导放大镜 + 尾部 `Kbd`）；`ScopeBadge`（本设备 / 主机 / 账号，`Badge outline sm`）；关闭 `IconButton cluster`（Tooltip 带 `Kbd` Esc）。搜索只做客户端过滤：匹配导航项与各页的行标签（`panels/settings/search-index.ts` 登记每页的 i18n 键），结果以 `Command` 列表形态出现在搜索框下方（↑↓ 选择，无开关动画），选中即跳转并高亮该行 1 次（`--brand-soft` 淡出 `--dur-page`）。
- **页头**：`h2 text-display`（页名）+ 右侧动作槽（至多一个 `default` + 若干 `outline sm`，主动作带 `shortcut`）；**没有副标题**。
- **KPI 托盘** `Tray`（§3.3）：网格 `grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2`；托盘头 = 图标 14 + `text-meta` 标签 + `IconButton inline` ⋯（可选）；内卡 = `TrayValue`（22px/600 等宽，`AnimatedNumber`）+ `Progress variant=ticks`（20 格，tone 按阈值）+ 一行 `text-meta`：`TrayTrend`（↗ +15.2% `--success-text` / ↘ `--danger-text`，只在有上一周期可比时出现）或元信息（重置时间、窗口名）。没有数值型数据的页不放托盘；值是字符串（版本号、主机名）的托盘不画刻度。
- **分组卡**：现有 `SettingsGroup`（`Card` `rounded-card`、1px 边、行 `divide-y`）；行 40px；标题 `text-body` 500 贴卡片上方。
- **表格卡** `Card variant=table`：头行 = 标题 `text-section` + 右侧 `Tabs segmented`（≤4 项）+ 「查看全部」`Button link sm`（有更多时）；`Table` 表头 `--surface-raised` 32px `text-caption` 500；行 36px；首列主体、数字列右对齐等宽、状态列 `StatusPill sm`、末列动作 `IconButton inline`；行可 ↑↓ 聚焦；空 → 卡内 `EmptyState`；加载 → `SkeletonTable`。
- **子页**：同一内容面板里推入（`translateX(16px) → 0`，`--dur-page` `--ease-drawer`），面包屑多一级，页头左侧「←」`IconButton cluster`（Tooltip `Kbd` Esc）；底部「取消 / 保存」固定不动（表单页）。
- **平板**：导航 52px 只留图标；**手机**：底部 Sheet 整高，导航收进顶部 `Select`，托盘单列。
- 每一页用哪些块、数据从哪来，见工作区计划 §5。

## §6 文案

- 按钮：动词或动宾（「保存」「重启并更新」「使用通行密钥」）；取消永远在左、主动作在右；危险动作用 `destructive-solid` 且在 `AlertDialog` 里重复一次对象名（「停用「张三」？」）。
- 标签：名词，无标点；不写「请」「您」。
- 状态：两到四字（运行中 / 需要你 / 本轮失败 / 已排队 / 已暂停 / 未读 / 已完成）。
- 错误：先说发生了什么，再给一个动作；不写错误码；不猜原因；不渲染原始异常文本。
- 不写：「预留」「未实现」「即将推出」「v1.2.3」（除关于页）、英文夹杂（CLI 与品牌名除外）。
- **没有说明文字（新）**：
  1. 对话框不带 `Description`：确认框的标题本身写清对象与后果（≤ 20 字，如「丢弃 3 处未提交改动？」），`ResponsiveDialogDescription / AlertDescription / CardDescription / EmptyDescription / ItemDescription / FieldDescription` 在功能代码里不出现（守卫 §10）。
  2. 页面里不出现常驻的灰字段落（`<p className="text-muted-foreground">` 之类）；需要让人知道的事放进标签、值、状态胶囊或动作本身。
  3. `SettingsRow.footnote` 只放**当下的**状态与错误（校验失败、被拒原因、指纹、倒计时），不放静态解释；`hint`（悬停）只给 `IconButton` 与被截断的值，原生 `title=` 不再用于解释。
  4. i18n 里的 `*Description / *hint / *Note / *detail / *body / *safety / *help` 键随渲染点一起删；中文值 ≥ 36 字的键只允许出现在错误文案与法律文本（许可证）。
  5. 空态一句名词短语；加载不写字；成功不弹 toast（文字替换式反馈），失败与可撤销的动作才弹。
- 中英对照示例：

| 键                           | zh-CN             | en                     |
| ---------------------------- | ----------------- | ---------------------- |
| `acp.permission.allow`       | 允许              | Allow                  |
| `acp.permission.once`        | 本次              | Once                   |
| `acp.permission.always`      | 始终              | Always                 |
| `acp.permission.risky`       | 有风险            | Risky                  |
| `acp.context.compact`        | 压缩              | Compact                |
| `acp.context.remaining`      | 剩余 {value}      | {value} left           |
| `settings.search`            | 搜索设置          | Search settings        |
| `settings.breadcrumb.root`   | 设置              | Settings               |
| `settings.kpi.ready`         | 就绪              | Ready                  |
| `settings.kpi.installNeeded` | 需安装            | Install needed         |
| `timeline.thoughtDone`       | 思考了 {duration} | Thought for {duration} |
| `status.done`                | 已完成            | Done                   |
| `updates.restart`            | 重启并更新        | Restart and update     |

## §7 从现有样式迁移

上一版的 11 步（新增 token、浅色修正、对比度守卫、Agent 两层色、z 轴、`MotionConfig`、CLI 加组件、手写 `<button>` 收口、空态统一、手机 Sheet、删旧别名）**已全部完成**（2026-10-04 至 2026-10-12）。本次改版的迁移按工作区 `docs/armadra/plans/ui-design-unify.md` 的批次执行：批次 1 一个包（令牌与 ui/ 基础件，本文 §2、§3、§8、§9、§10），批次 2 并行包（设置工作台、画布与节点、Agent 状态族、ACP 时间线、动效与开屏、其余面板与说明文字删减），批次 3 收尾（展示页、探针、守卫归零）。与 §4.3 契约的关系不变：只增不改 shadcn 别名集合；`tokens.test.ts` 的 `SHADCN_ALIASES`、`LAYOUT_CONSTANTS`、`Z_SCALE` 随本文改值。

## §8 动效系统 **新**

动效只做三件事：连接起点与终点、解释层级、给操作即时反馈。全部数值都是定值，不是范围；没有「临时写的」时长与曲线；没有回弹。

### §8.1 先决：这个东西该不该动

| 出现频率                                                 | 决定                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 每天 100+ 次：快捷键、命令面板开关、节点间切换、视图切换 | **不动画**。`CommandPalette` / `QuickOpen` 的开关、⌘, 打开设置、Esc 关闭都是即时的 |
| 每天几十次：悬停、列表导航、常用开关、折叠               | 只做 ≤ `--dur-fast` 的颜色 / 透明度变化，或不做                                    |
| 偶尔：对话框、抽屉、toast、设置子页                      | 标准出场（§8.3）                                                                   |
| 罕见 / 首次：开屏、空态出现、完成反馈                    | 允许错落与 `--dur-hero`                                                            |

**键盘触发的动作一律不动画**：同一个面板，指针点开时按 §8.3 出场，快捷键打开时渲染终态（`data-instant` 属性由调用方传入，`DialogContent / PopoverContent / DropdownMenuContent` 读到后 `animation: none`）。每个动画必须能用一个词说明目的（反馈 / 空间连续 / 状态变化 / 防止跳变），说不出就不做；用户正在读的数据（图表、列表数字）不为了好看而动。

### §8.2 令牌

| token           | 值                                             | 用途                                                                 |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `--dur-instant` | 100ms                                          | 按下、悬停底色、图标透明度                                           |
| `--dur-fast`    | 120ms                                          | 颜色、淡入淡出、Tooltip、退场、减少动效下允许的唯一时长              |
| `--dur-base`    | 160ms                                          | 选中、指示器平移、文字替换、宽度变化、图标切换                       |
| `--dur-slow`    | 200ms                                          | 菜单 / Popover / Select 发芽、列表项与节点进出、折叠面板             |
| `--dur-page`    | 280ms                                          | 对话框、Sheet、设置子页推入、手机整页推入、整理时的节点位移          |
| `--dur-hero`    | 600ms                                          | 开屏淡出后的首屏错落入场、官网首屏；唯一超过 300ms 的界面动效        |
| `--dur-loop-*`  | 600–2600ms（§2.10）                            | 状态指示动画的一圈：脉冲、流光、微光、转圈、不确定进度、光晕、铃声   |
| `--ease-out`    | `cubic-bezier(0.23, 1, 0.32, 1)`               | 一切进场与退场、按下、`MotionConfig` 默认                            |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)`              | 已在屏上的元素移动 / 变形：指示器平移、整理、把手吸附                |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)`               | Sheet、抽屉、设置子页与手机页面推入                                  |
| `--ease-color`  | `ease`                                         | 悬停与颜色变化                                                       |
| `linear`        | —                                              | spinner、进度、长按填充、流动虚线                                    |
| `--press-scale` | 0.97                                           | 按钮、胶囊、Dock 钮按下                                              |
| `--pop-scale`   | 0.96                                           | 浮层与对话框起始缩放（Tooltip 0.97）                                 |
| `--stagger`     | 40ms                                           | 列表 / 节点批量入场的错落步长，最多前 6 个有错落，总长 ≤ 300ms       |
| `MOTION_SPRING` | `{ type: "spring", duration: 0.3, bounce: 0 }` | `motion` 库的唯一弹簧（指示器、布局动画、图标切换）；bounce 永远是 0 |

除 `--dur-hero` 外，界面动效（进场、退场、过渡）都不超过 300ms；样式表里超过 300ms 的时长只能来自 `--dur-hero` 与 `--dur-loop-*`（`styles/css-guards.test.ts` 守着，`tokens.test.ts` 核对超过 300ms 的令牌只有这两类）。

`main.tsx` 的 `MotionConfig` 改为 `transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}`，`reducedMotion="user"` 不变。`ease-in` 在任何地方都禁止；功能代码与 ui/ 里不出现字面 `cubic-bezier(`（只在 `tokens.css`）。只动 `opacity / transform / color / filter / clip-path`（折叠面板的 `height` 例外，≤ `--dur-slow`，用测量高度不用 `auto`）；`transition-all` 在 ui/ 与功能代码里都**删**，改成点名属性（`transition-[color,background-color,border-color]`、`transition-transform`、`transition-opacity`）。退场永远比入场短：取入场的一半或 `--dur-fast`。

### §8.3 浮层（发芽）

| 浮层                                                      | 出场                                                                                                               | 退场                                                | 备注                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tooltip                                                   | `opacity 0 → 1` + `scale 0.97 → 1`，origin = `--radix-tooltip-content-transform-origin`，`--dur-fast` `--ease-out` | `--dur-fast` 淡出                                   | 首次延迟 500ms；同一 `TooltipProvider` 内已有一个打开时，邻近的立即打开且无动画（`data-state="instant-open"` → `animation: none`）；离开后 200ms 才消失 |
| DropdownMenu / ContextMenu / Popover / Select / HoverCard | `opacity 0 → 1` + `scale 0.96 → 1`，origin 在触发点（ContextMenu 在指针位置），`--dur-slow` `--ease-out`           | `--dur-fast` 淡出 + `scale 1 → 0.98`                | 子菜单保持父项悬停态，关闭延迟 200ms；滚动祖先时跟随；用 transition 不用 keyframes，快速连点可打断                                                      |
| Command（命令面板、快速打开、设置搜索结果）               | **无**                                                                                                             | 无                                                  | 键盘中枢，即时出现                                                                                                                                      |
| Dialog / AlertDialog                                      | 遮罩 `--dur-page` 淡入；内容 `opacity 0 → 1` + `scale 0.96 → 1`，`--dur-page` `--ease-out`，origin 居中            | 内容 `--dur-fast` 淡出 + `scale 1 → 0.98`，遮罩随后 | 内容超高：先缩到 0.9 再滚动；`data-instant` 时无动画                                                                                                    |
| Sheet（底 / 右）                                          | `translateY/X(100% → 0)` `--dur-page` `--ease-drawer`                                                              | 反向 `--dur-slow`                                   | 可向来的方向拖走：拖动 1:1 跟手、`setPointerCapture`、速度 > 0.11 px/ms 即关闭、过界阻力递增                                                            |
| Toast                                                     | `translateY(100% → 0)` + 淡入，400ms `ease`（刻意比其它 UI 慢），`@starting-style` 入场，transition 不用 keyframes | 向来的方向滑走 `--dur-slow`                         | 堆叠最多 3 层，悬停展开并暂停计时，标签页隐藏时暂停；带动作或错误的不自动消失                                                                           |
| 设置子页                                                  | `translateX(16px → 0)` + 淡入 `--dur-page` `--ease-drawer`                                                         | 反向 `--dur-slow`                                   | 底部按钮行固定不动                                                                                                                                      |

实现：`styles/motion.css` 定义 `@keyframes armadra-pop-in / fade-out / rise-in / shimmer / shake` 与工具类，ui/ 生成件的 `data-open:animate-in … zoom-in-95` 改成这些关键帧（保留 tw-animate 的 `data-open / data-closed` 变体）；Tooltip 与菜单在 `[data-instant]` / `[data-state="instant-open"]` 下 `animation: none`。

### §8.4 高频反馈

- 悬停：底色 `--hover` `--dur-instant` `--ease-color`，只在 `@media (hover: hover) and (pointer: fine)`；同一父容器内的按钮、菜单项、导航项、Tabs 共享一块悬停底（`ui/indicator`，`layoutId` 以父容器 id 为组），指针从一项移到邻项时底块平移 `--dur-base` `--ease-in-out`，离开整组才淡出。
- 按下：`scale(0.97)` `--dur-instant` `--ease-out`，`:hover:active` 才生效；`Button static` 关掉；禁用态不参与；按下时就反馈，不等松手。
- 选中 / 当前项：指示器平移（设置导航、分段控件、Tabs line、Dock 工具组、PromptBox 模式切换），`--dur-base` `--ease-in-out`，文字本身不在点击瞬间变化。
- 焦点环：无过渡，立即出现。
- 图标切换（展开 / 折叠、播放 / 暂停、复制 / 已复制）：两枚图标都在 DOM 里，一枚绝对定位；`scale 0.25 → 1`、`opacity 0 → 1`、`blur 4px → 0`，`--dur-base`；用 `motion` 时 `MOTION_SPRING`。
- 文字替换（`TextSwap`）：旧字 `opacity 1 → 0` + `blur 0 → 2px` `--dur-fast`，新字反向 `--dur-fast` 延迟 40ms，容器宽度 `--dur-base` `--ease-out`；只用于非用户直接输入的文字（状态、计数、「已复制」）；成功反馈用它，不弹 toast。
- 数字（`AnimatedNumber`）：400ms `--ease-out` 从旧值滚到新值，`tabular-nums`，首次出现从 0 填充（KPI、用量、Dock 百分比；计时不滚）。
- 开关 / 复选：选中指示器 `scale 1 → 1.05 → 1` `--dur-base`；开关滑块 `--dur-base` `--ease-out`，不回弹。
- 校验失败：输入框 `armadra-shake`（`translateX` ±4px 两次，240ms linear）+ 红边，`aria-invalid` 同帧。

### §8.5 加载与完成

- 按钮 `loading`：前导图标用图标切换配方换成 `Spinner`，标签叠 `Shimmer`，宽度不变，`aria-busy="true"`，不 `disabled`（仍可聚焦，点击无效）；结束时 `Spinner state=done` 收成对勾（`stroke-dashoffset` 画出 240ms `--ease-out`），停 800ms 后恢复。
- Spinner 一圈 0.8s linear。
- 骨架：`animate-pulse` 2s，`motion-reduce:animate-none`；骨架与终态同布局，不跳版。
- 进度条首次出现从 0 填到当前值 `--dur-page`；刻度条逐格点亮（每格 15ms，最多 20 格 = 300ms）；进度本身 linear。
- 流式文本：不做逐字动画；只在新块出现时 `opacity 0 → 1` `--dur-fast`。
- 长按确认（破坏性动作可选）：`clip-path: inset(0 100% 0 0)` 覆盖层按下 2s linear 填满，松手 `--dur-slow` `--ease-out` 收回，同时按钮 `scale(0.97)`。

### §8.6 列表、节点与布局

- 列表项入场：`opacity 0 → 1` + `translateY(4px → 0)`，`--dur-slow` `--ease-out`，第 i 项延迟 `i × --stagger`（i ≤ 6）；退场：先透明度 `--dur-fast`，再 `translateY(-4px)`，高度不动画；添加时位移先、删除时透明度先，二者不重叠。只用于偶尔出现的列表（通知面板打开、搜索结果、运行记录），不用于侧栏树与会话列表的日常更新。
- 画布节点：新建 `opacity 0 → 1 + scale 0.96 → 1` `--dur-slow`（批量时同错落）；删除只淡出 `--dur-fast`；整理（tidy）位移 `--dur-page` `--ease-in-out`；拖动中 `will-change: transform`，松手无惯性；fit view 动画可被下一次拖动打断（`motion` 从当前值重定向）。
- 宽度 / 高度变化：只允许在节点折叠 / 展开（`--dur-slow`）与 `TextSwap` 容器；高频输入路径（PromptBox 增高、终端 fit）不加过渡。
- 页面忙时（流式输出、导航、加载）播放的动画用 CSS 而不是 `motion`；`motion` 里必须动的用完整 `transform` 字符串，不用 `x / y / scale` 简写；不用父元素 CSS 变量驱动子元素 `transform`。
- 主题切换：切换前给 `<html data-theme-switching>` 注入 `*,*::before,*::after { transition: none !important }`，强制 reflow，下一帧移除，整页瞬间换色而不是逐个渐变。

### §8.7 开屏时间线

`splash/timeline.ts` 的 4000ms 结构不变（0–1500 书写签名、1500–1970 签名下沉、1100–2900 犰狳走入、2900–3000 擦成静止、3000–3240 淡成标识），只改接缝与配色：

| 时刻      | 动作                                                                                                                                                                                                                                                      | 令牌                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 0         | 覆盖层挂上，`<html data-theme>` 由 splash 立刻写成解析后的主题（原来等 App 挂载后才写），`splash.css` 直接读 `--bg / --text / --brand / --brand-text`，**删** 8 个硬编码色                                                                                | —                               |
| 0–4000    | 按 30fps 推帧（不变）                                                                                                                                                                                                                                     | —                               |
| ≥1000     | 允许跳过（不变）                                                                                                                                                                                                                                          | —                               |
| 4000      | 覆盖层淡出 `--dur-page` `--ease-out`（原 260ms `ease`）                                                                                                                                                                                                   | `--dur-page`                    |
| 4000 + 80 | App 首屏错落入场：侧栏 → 画布内容 → Dock / 工具簇，三块各 `opacity 0 → 1 + translateY(4px → 0)` `--dur-slow`，间隔 100ms（总长 ≤ 600ms）；只在 splash 刚退场的这一次播，`App.tsx` 用 `AnimatePresence initial={false}` 保证平时首帧不播；播放期间一切可点 | `--dur-slow`、`--dur-hero` 上限 |
| 减少动效  | 直接落终态停 1000ms，淡出 `--dur-fast`；首屏不错落                                                                                                                                                                                                        | `--dur-fast`                    |

### §8.8 减少动效与触屏

`tokens.css` 的全局压制改为「减少而不是归零」：`prefers-reduced-motion: reduce` 下位移、缩放、视差、循环（脉冲、rope、流光、微光、光晕呼吸）全部关闭，透明度与颜色过渡保留但压到 `--dur-fast`；`Spinner` 保留转圈（唯一必要的循环）；弹簧改为淡入；JS 侧（`motion`）走 `useReducedMotion`。`hover: none` 的设备关掉依赖悬停的效果（共享悬停底、Tooltip），悬停才出现的动作常显。触屏点按不画系统高亮（`html` 上 `-webkit-tap-highlight-color: transparent`），按钮、链接、`[role=button]` 与 `label` 用 `touch-action: manipulation`，点下不等双击缩放；`Kbd` 在主指针是粗指针、且没有任何精细指针时隐藏（`pointer-coarse:not-any-pointer-fine:hidden`），接了触控板或鼠标的 iPad 照常显示；键帽本身是内容时（配对码、快捷键设置页的绑定）传 `persistent`，触屏上照常显示。

## §9 组件变体总表 **新**

每行：尺寸 · 状态 · 动效 · 无障碍。「尺寸」里的高度即 §2.13 的档；字号即 §2.6 的类。

| 组件                           | 变体 / 尺寸                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 状态                                                              | 动效                                                                         | 无障碍 / 键盘                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Button`                       | variant：default（`--brand-solid` + 白字）/ outline（1px `--border-strong` + `--card`）/ secondary（`--surface-raised`）/ ghost / destructive（`--danger-soft` 底 + `--danger-text`）/ destructive-solid（`--danger-solid` + 白字）/ link（`--brand-text`）；size：xs 24 `text-meta` `px-1.5` 图标 12 / sm 28 `text-body` `px-2` 图标 14 / default 32 `text-body` `px-2.5` 图标 16 / lg 36 `px-3` / touch 44 `px-3` / icon · icon-xs · icon-sm · icon-lg；`loading`、`static`、`shortcut`（尾部 `Kbd` 16） | §3.4 全部；`aria-expanded` 时保持 hover 底                        | 悬停 `--dur-instant`；按下 0.97；loading 见 §8.5；图标切换 §8.4              | 原生 `button`；图标钮必须有 `aria-label`；loading 用 `aria-busy` 不用 `disabled`；`shortcut` 同时注册到 `useGlobalShortcuts` |
| `IconButton`                   | inline 24 / cluster 28 / dock 32；`active`；`shortcut`（进 Tooltip）                                                                                                                                                                                                                                                                                                                                                                                                                                       | active = `--brand-soft` + `--brand-text`                          | 同 Button；同一条里的钮共享悬停底                                            | `label` 必填 → `aria-label` + `aria-pressed`                                                                                 |
| `Badge`                        | variant：default（`--brand-solid`）/ secondary / outline / ghost / destructive（danger 软）/ success / warn / brand（`--brand-soft` + `--brand-text`）/ link；size：sm 18 `text-caption` `px-1.5` 图标 12 / md 20 `text-meta` `px-2`；`rounded-pill`；`tabular-nums`                                                                                                                                                                                                                                       | 可点时（`asChild` 包 Button）有 hover                             | 计数变化用 `TextSwap`                                                        | 纯装饰的计数加 `aria-label`「3 条未读」                                                                                      |
| `StatusDot`                    | size 6 / 8；tone 8 种 + `color` 自定义；`pulse`；`corner`（贴图标右上角，2px `--panel` 环）                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                 | working / attention 呼吸 1.6s（减少动效静止）                                | `role="img"` + `aria-label`（状态文案）或 `aria-hidden`（旁边已有文字）                                                      |
| `StatusPill`                   | size sm 18 / md 20；tone 8 种；`label` 必填；`trailing`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                 | 点同上；文案变化 `TextSwap`                                                  | 文字即状态；颜色不是唯一通道                                                                                                 |
| `StatusLine`                   | 行内：`StatusDot 6` 或 `Spinner 12`（跑着的阶段）+ 阶段 `text-body` + 细节 `text-meta` 等宽 + 计时等宽；`compact`（只阶段 + 计时）                                                                                                                                                                                                                                                                                                                                                                         | 审批 / 出错不转圈，换对应 tone                                    | 阶段文案 `TextSwap`；细节最多显示 300ms 防闪（`useSmoothedActivity`）        | `aria-live="polite"` 只包阶段文字，计时不播报                                                                                |
| `AgentTree`                    | size sm（≤ 96×48，方块 8 / 6，每层 ≤ 5，深 ≤ 3）/ md（≤ 240 宽，方块 12 + 标签，每层 ≤ 8，可折叠）；连线 1px `--border-strong`，分叉点 2px                                                                                                                                                                                                                                                                                                                                                                 | 节点 tone 8 种；idle 空心；超出 `+k`                              | working / attention 外圈呼吸（减少动效静止）；折叠 `--dur-slow` 只动 opacity | `role="img"` + 汇总 `aria-label`；sm 一个焦点停留点；md 节点各可聚焦，↑↓←→ 移动，回车折叠；Tooltip「名称 · 状态」            |
| `Input` / `Textarea`           | size xs 24 / sm 28 / default 32 / touch 44；手机档 16px；`InputGroup` 前后缀                                                                                                                                                                                                                                                                                                                                                                                                                               | focus 环；invalid 红边 + 20% 环；disabled 50%                     | 边框色 `--dur-fast`；校验失败 shake                                          | `label for` 必有；占位不是标签；`autocomplete / inputmode`；不拦截粘贴                                                       |
| `Select`                       | Trigger 同 Input 四档；内容 `rounded-card` 10、1px `--border-strong`、项 28 `rounded-control` 6、`p-1`                                                                                                                                                                                                                                                                                                                                                                                                     | 项 hover 共享底块；选中项前对勾                                   | 发芽 §8.3；项之间底块平移                                                    | Radix 自带；手机有安全区时 popper；字母跳选                                                                                  |
| `Card`                         | variant default（`--card`、1px `--border`、`rounded-card`、`p-4`，无阴影）/ tray（§3.3 `Tray`）/ table（头行 + `Table`，`p-0`）；size default / sm（`p-3`）                                                                                                                                                                                                                                                                                                                                                | 可选中时 `--brand` 1.5px 边                                       | 入场 §8.6                                                                    | 可点的整卡用 `a / button` 包，不给 `div` 加 onClick                                                                          |
| `Tray` / KPI                   | `Tray`：`--panel` + 1px `--border` + `rounded-float` 16 + `p-1.5`；`TrayHeader` 24 高；`TrayCard`：`Card` `rounded-card` `p-3`；`TrayValue` 22/600 等宽；`Progress ticks` 20 格；`TrayTrend` `text-meta`                                                                                                                                                                                                                                                                                                   | 阈值 tone：≥80% warn、≥95% danger                                 | 数字滚动 400ms；刻度逐格 15ms                                                | 大数字外包 `dl / dt / dd`；趋势箭头 `aria-hidden`，文字含 ±                                                                  |
| `Table`                        | 表头 `--surface-raised` 32 `text-caption` 500；行 36（`sm` 28）；单元格 `px-3`；数字列 `text-end tabular-nums`；首列可带头像 20；长串 `overflow-wrap: anywhere` 或中间截断                                                                                                                                                                                                                                                                                                                                 | 行 hover `--hover`；选中行 `--brand-soft`；可展开行 `Collapsible` | 行进出 §8.6（只在筛选切换时）                                                | `th scope`；排序列 `aria-sort`；行 roving tabindex ↑↓；手机退化为 `Item` 列表                                                |
| `Tabs segmented`               | `TabsList variant=segmented`：`--surface-raised` 底、`rounded-card` 10、`p-[3px]`；触发器 28（`sm` 24）`text-body` 500 `rounded-control`；指示器 `--card` + 1px `--border`；可带图标 14 / 计数 `Badge sm`                                                                                                                                                                                                                                                                                                  | 禁用项 50%                                                        | 指示器平移 `--dur-base` `--ease-in-out`；文字色跟随                          | Radix tabs 的 ←→；`aria-label` 给整组                                                                                        |
| `Tabs line`                    | 触发器 28 `text-body`，下划线 2px `--text`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                 | 下划线作为指示器平移                                                         | 同上                                                                                                                         |
| `Dialog`                       | 宽 420 / 520 / 自定；`rounded-dialog` 14、1px `--border-strong`、`--shadow-dialog`、`p-6`；标题 `text-title`；无 Description；底部按钮行取消左、主右；`data-instant`                                                                                                                                                                                                                                                                                                                                       | —                                                                 | §8.3                                                                         | 背景 `inert`；焦点进入第一个可操作元素与归还；`overscroll-behavior: contain`；Esc 关闭                                       |
| `Sheet`                        | side 四向；底部 `rounded-dialog` 顶角 + 36×4 拖柄；右侧宽 `--drawer-w`                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                 | §8.3；拖拽关闭                                                               | 同 Dialog                                                                                                                    |
| `Popover` / `HoverCard`        | `rounded-panel` 12、`--surface-overlay`、1px `--border-strong`、`--shadow-overlay`、`p-3`；最大宽 320                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                 | 发芽 §8.3；hover 关闭延迟 200ms                                              | `collisionPadding` 走 `ui/safe-area`                                                                                         |
| `DropdownMenu` / `ContextMenu` | 容器 `rounded-card` 10 `p-1` 1px `--border-strong`、项 28 `rounded-control` `text-body` 图标 16、分组标题 `text-caption`、快捷键 `DropdownMenuShortcut`（`Kbd`）右对齐                                                                                                                                                                                                                                                                                                                                     | 项 hover 共享底；禁用 50%                                         | 发芽；子菜单就地替换不重建                                                   | ↑↓、Home/End、字母跳；每个有快捷键的项都显示 `Kbd`                                                                           |
| `Command`                      | 面板 `rounded-panel`、输入 32、项 28、分组标题 `text-caption`、`CommandShortcut` `Kbd`；运行后项尾出现对勾 800ms                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                 | **无开关动画**；选中项高亮即时                                               | 全部命令可搜；`CommandEmpty` 用 `EmptyState inline`                                                                          |
| `Tooltip`                      | `--text` 底 + `--bg` 字、`text-caption` 500、`rounded-control`、`px-2 py-1`、最大宽 240；内嵌 `Kbd` 16 高反色                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                 | §8.3；首个之后即时                                                           | 不在 `disabled` 控件上挂；触屏不出；`shortcut` 同时进 `aria-keyshortcuts`                                                    |
| `Toast`（`ui/toast`）          | `--surface-overlay`、1px `--border-strong`、`rounded-panel`、`--shadow-overlay`、`text-body`；前导 `StatusDot 6`（success / warn / danger / brand）或 `Spinner 12`；动作 `Button xs outline`；最多 3 层                                                                                                                                                                                                                                                                                                    | success / error / info / loading / promise                        | §8.3                                                                         | `role="status"`；错误或带动作的不自动消失；`--z-toast`；⌥T 聚焦 toast 区                                                     |
| `Skeleton`                     | 行 / 卡 / 表 / 表单 / 设置行 / 节点体 / 回合（`ui/skeletons`）；`rounded-control`；宽度固定序列                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                 | pulse 2s；减少动效静止                                                       | `aria-hidden`；外层 `state.loading` 读屏                                                                                     |
| `Spinner` / `Shimmer`          | `Spinner` 12 / 16；state spinning / done / failed；`Shimmer` 包文字                                                                                                                                                                                                                                                                                                                                                                                                                                        | done → 对勾，failed → ×                                           | 转圈 0.8s 线性；对勾画出 240ms；微光 1.4s                                    | 有 `aria-label` 时 `role="status"`，否则 `aria-hidden`                                                                       |
| `EmptyState` / `ErrorState`    | 整块：虚线框 `rounded-card`、`p-6`、图标 16（可选）、标题 `text-body`、动作 `Button default sm`；`inline`：一行 `text-meta` 灰字                                                                                                                                                                                                                                                                                                                                                                           | —                                                                 | 淡入 `--dur-fast`                                                            | `ErrorState` 里重试是 `IconButton` 带 `label`；错误 `role="alert"` 只给一次性错误                                            |
| `Kbd`                          | 20 高（按钮 / Tooltip 内 16）、`rounded-tight`、`--surface-raised` 底、`text-caption` 500 等宽、`px-1`；Tooltip 内反色                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                 | —                                                                            | `kbd` 元素；组合键用 `KbdGroup`；按平台显示 ⌘ / Ctrl                                                                         |
| `Progress`                     | variant bar（4px，`rounded-pill`）/ ticks（20 格，格 3×8，间 2，`rounded-tight`，未填 `--faint` 30%）；tone brand / success / warn / danger                                                                                                                                                                                                                                                                                                                                                                | `indeterminate` 时 bar 扫动 1.2s linear                           | 首次从 0 填 `--dur-page` linear；ticks 逐格                                  | Radix `progressbar` + `aria-valuenow`；文字值在旁边                                                                          |

## §10 守卫测试 **新**

| 测试                                                                            | 守什么                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styles/tokens.test.ts`（改）                                                   | §2 全部 token 名在两套主题都存在；新圆角七档、阴影三档、动效令牌值；`--primary` 仍指向 `--brand-solid`；`--r-sm/md/lg/xl`、`--shadow-pill`、`--shadow-card` 不存在；没有 `ease-in` 与回弹曲线                                                                                                                                                                                                                        |
| `styles/tokens-contrast.test.ts`（改）                                          | 新增 `--caution-text` 对 `--caution-soft`、Badge success / warn 文字对衬底、Tooltip 字对底 ≥ 4.5；`--faint` 刻度未填格不做文字                                                                                                                                                                                                                                                                                       |
| `styles/type-scale.test.ts`（改）                                               | 11px 以下禁止（不变）；**新增**：功能代码（非 ui/、非 showcase/fixtures）禁止 `text-[Npx]`、`text-[length:var(--text-*)]`、`text-sm / text-xs / text-base`（手机输入档的 `text-base md:text-sm` 例外登记），只许 `text-caption / meta / body / section / title / display`；`font-bold` 及以上禁止（`font-heavy`）                                                                                                    |
| `styles/class-guards.test.ts`（新）                                             | 功能代码禁止：裸 `rounded`、`rounded-sm/md/lg/xl/2xl/4xl`、`rounded-[…]`；`shadow`、`shadow-sm/md/lg`、`shadow-[…]`；`h-6/h-7/h-9/h-10/h-11/min-h-10/min-h-9` 等手写控件高度；`text-[var(--…)]`、`bg-[var(--…)]`、`border-[var(--…)]`（有对应工具类的）；`transition-all`；`duration-N` / `ease-in` / 字面 `cubic-bezier(`；`strokeWidth=`；`from "sonner"`（只许 ui/toast.tsx）。带 `LEGACY_BUDGET` 表，批次 3 归零 |
| `styles/css-guards.test.ts`（新）                                               | `src/` 下的样式表（令牌文件 `tokens.css`、`backdrops.css` 除外）按声明扫描，禁止：写死的字号与行高 px；padding / margin / gap 里 0、1px、2px 以外的 px；字面颜色（遮罩除外）；`transition: all`；非零字面圆角；`ease-in`；`scale(0)`；超过 300ms 的字面时长；带模糊或超过 2px 扩散的字面投影（`var(--shadow-*)`、`none` 与无模糊的 1–2px 细线放过）。例外在同一条声明里写 `design-ok` 并说明原因，现为零处           |
| `styles/no-literal-color.test.ts`（改）                                         | 扫描范围加入 `splash/splash.css`、`styles/motion.css`；`LEGACY_COLOR_BUDGET` 只剩数据文件                                                                                                                                                                                                                                                                                                                            |
| `ui/ui.test.tsx`（改）                                                          | 每个变体 / 尺寸渲染出对应的 `data-variant / data-size`；`Button loading` 有 `aria-busy` 且无 `disabled`；`Button shortcut` 渲染 `Kbd` 与 `aria-keyshortcuts`；`Badge size`；`Tabs segmented` 有指示器；`Progress ticks` 渲染 20 格；`Tray` 结构；`DialogContent data-instant` 无 animation 类；`IconButton active` 是淡底 + 正文色、不带 `text-brand-text`；`Kbd` / `KbdGroup` 带触屏隐藏类                          |
| `ui/status-family.test.tsx`（新，替代 `status-pill-contrast.test.ts` 的一部分） | 三件的 tone → 色 / 文字 / 脉冲映射一致；`StatusLine` 的 `aria-live` 只包阶段                                                                                                                                                                                                                                                                                                                                         |
| `ui/toast.test.tsx`（新）                                                       | `ui/toast` 的五种调用渲染出 `role="status"`、对应 `StatusDot` tone；错误与带动作的 `duration` 为 `Infinity`                                                                                                                                                                                                                                                                                                          |
| `panels/no-description.test.ts`（新）                                           | 功能代码不出现 `ResponsiveDialogDescription / AlertDialogDescription / DialogDescription / AlertDescription / CardDescription / EmptyDescription / ItemDescription / FieldDescription`（sr-only 例外登记）；`SettingsRow footnote=` 只接变量不接 `t("…")` 字面静态键                                                                                                                                                 |
| `panels/no-raw-*.test.ts`（不变）                                               | 手写 `<button>`、`<dialog>`、表单元素                                                                                                                                                                                                                                                                                                                                                                                |
| `panels/shortcuts-shown.test.ts`（新）                                          | `commands.ts` 里登记了快捷键的命令，在它出现的菜单项 / 按钮 / Tooltip 里带 `Kbd`（扫 `DropdownMenuShortcut / CommandShortcut / shortcut=`）                                                                                                                                                                                                                                                                          |
| `i18n/i18n.test.ts`（改）                                                       | 四条守卫不变；**新增**：键名含 `Description / hint / Note / detail / body / safety / help` 的条目必须被引用，且中文值 ≤ 36 字（错误文案与 `licenses` 例外）                                                                                                                                                                                                                                                          |
| `agent/display-consistency.test.ts`（不变）                                     | 同一状态每个视图同一句话                                                                                                                                                                                                                                                                                                                                                                                             |
| `splash/timeline.test.ts`（改）                                                 | 时间点不变；**新增** `splash.test.tsx` 断言淡出时长读自 `--dur-page`，`splash.css` 无字面色                                                                                                                                                                                                                                                                                                                          |
| `tools/probes/design-showcase.mjs`（改）                                        | 分区加 `settings / status / motion`；对比度表加新对；`prefers-reduced-motion` 下 `motion` 分区无位移；`components` 分区 Tab 遍历焦点环；`states` 分区渲染 §12 的边界夹具                                                                                                                                                                                                                                             |

## §11 状态组件族与键盘优先 **新**

### §11.1 状态组件族

同一语义（运行中 / 需要你 / 失败 / 完成 / 排队 / 暂停 / 未读 / 空闲）只有三种形态，都在 `ui/status-pill.tsx`，共享 `TONE_COLOR / STATUS_PILL_TEXT / STATUS_PILL_PULSES`：

| 形态         | 用在                                                                                                       | 取代                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `StatusDot`  | 节点头空闲 / 窄节点、侧栏树与会话行的前导点、铃铛角标、横幅前导、编辑器未保存、问题面板严重度、Dock 保存点 | `sidebar/SignalDot`、`SessionRow` 的 Bell / Check / ColorDot 三态、七处手写 6 / 7 / 8px 圆点、`ColorDot size={6}` 表状态 |
| `StatusPill` | 节点头（宽节点）、表格状态列、设置页 Agent / 设备 / 会话 / Worker 状态、工作流运行记录、通知行、子代理卡   | `Badge outline / secondary` 做状态的 20 处、`<span className="text-destructive">` 文本型状态、`Banners` 的 tone 文字     |
| `StatusLine` | 时间线活动行、协调者抽屉成员行、`AgentActivityNode` 正文、节点观察抽屉、设置页「本机服务」连接行           | `timeline/view/ActivityLine`、`AgentActivityNode` 的三段文字、`DispatchDrawer` 的 Item 行                                |

**缩略 Agent 树 `AgentTree`**（同族第四件，`ui/agent-tree.tsx`）：只表达「谁派了谁」与「各自什么状态」，其余（模型、费用、耗时、任务名）一律不放。

| 项      | 规格                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据    | `agent/agent-tree-model.ts` 的 `agentTreeOf(rootId, document, statuses, cards)` → `AgentTreeNode { id, label, tone, kind: "agent" \| "subagent", children }`：子节点 = `supervises` 边的下级（`canvas/supervision.ts` 规则，第一条上级边赢，环路截断）+ 该节点的子代理卡片（`useSubagentCards`，`working → working`、`done → done`）；每个 Agent 节点的 tone 经 `displayOfStatus(status)`；没有下级也没有卡片时不渲染 |
| 形态 sm | SVG，宽 ≤ 96、高 ≤ 48，放在行右侧；根 8×8 方块居中顶部，子节点 6×6 方块一行，`rounded-tight` 2px；连线 1px `--border-strong`：根下方竖线 6px → 横向母线 → 每个子节点上方竖线 4px，分叉点 2px 圆点；每层最多 5 个，超出最后一格换成 `+k`（`text-caption` 等宽 `--muted-foreground`）；最多 3 层（根 + 2），再深在末层方块右下角画一个 2px 点表示「还有下级」；只有一个焦点停留点                                       |
| 形态 md | 宽 ≤ 240，节点为 12×12 方块 + 右侧极短标签（`text-caption` 等宽，≤ 8 字截断）；每层最多 8 个；父节点可点击折叠整条分支成一行「▸ 名称 · +k」；顶部一行汇总 `text-caption` 等宽「7 个 Agent · 6 个运行中」；每个节点可聚焦                                                                                                                                                                                              |
| 颜色    | 方块填充 = `TONE_COLOR[tone]`；`idle` 为空心（1px `--faint` 边）；`working / attention` 方块外圈 1px 同色环按 `anim-dot-pulse` 呼吸（只动 opacity），减少动效静止；`failed` 实心 `--danger`；`done` 实心 `--success`                                                                                                                                                                                                  |
| 交互    | 悬停任一方块 → `Tooltip`「名称 · 状态」（文案走 `i18n/status.ts`）；整体 `role="img"` + `aria-label`（sm：「3 个子 Agent，2 个运行中，1 个失败」；md 每节点各自 `aria-label`）；sm 整体一个 `tabIndex=0`，聚焦显示汇总 Tooltip；md 内 ↑↓ / ←→ 在节点间移动，回车折叠 / 展开                                                                                                                                           |
| 用在    | 通知面板 `NeedRow` 右侧（sm，只在该节点有下级或子代理时）；`AgentActivityNode` 正文（md，替代「最近子代理一行」）；节点头状态弹层（md，与 `StatusLine` 同一张 `Popover`）；协调者抽屉顶部（md）                                                                                                                                                                                                                       |
| 不做    | 费用、耗时、模型、任务描述；根卡大卡片；曲线连线；多于 3 层的完整展开（去画布看）                                                                                                                                                                                                                                                                                                                                     |

tone 与颜色、文案的映射只在 `agent/display.ts`（`pillOf / glowOf / headerOf`，新增 `lineOf(display, activity)` 给 `StatusLine`，`agentTreeOf` 在 `agent/agent-tree-model.ts`），其余组件不再自己写 `TONE` 表（`ServicePicker.STATUS_TONE`、`showcase/coordinator.TONES`、`ToolRow.STATUS_TONES` 迁到 `agent/display.ts` 或 `ui/status-pill.ts` 的导出）。`AgentActivityNode` 只剩：来源节点名 + `StatusLine`（当前阶段 · 细节 · 计时）+ 最近一次子代理 `StatusPill` 行；「转为平台计划」与三段说明删除。`SubagentCard` 只剩：`StatusPill sm` + 任务名 + 计时等宽 + 展开结果；tokens / 工具数两枚 `Badge` 合成一枚 `text-caption` 等宽「1.2k · 3 次」。

### §11.2 键盘优先

| 要求               | 落点                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每个主操作有快捷键 | `commands.ts` 是唯一登记处；`Button shortcut` / `IconButton shortcut` / `DropdownMenuShortcut` / `CommandShortcut` / `TooltipContent shortcut` 从同一张表取；按平台显示 ⌘ / Ctrl    |
| 命令面板是中枢     | `CommandPalette`（⌘K）列出全部命令与设置页跳转；无开关动画；最近使用置顶；运行后项尾对勾 800ms                                                                                      |
| 焦点可见           | `:focus-visible` 3px ring 50%，无过渡；`forced-colors` 下系统色                                                                                                                     |
| 列表可 ↑↓          | 侧栏树、会话列表、通知面板、表格行、设置导航、搜索结果、命令面板、Dock 工具组：roving tabindex，↑↓ 移动、Home / End、回车激活、Esc 退出；`panels/tabs-focus.ts` 扩成 `ui/roving.ts` |
| 面板打开即聚焦     | Dialog / Sheet / Popover 打开时焦点进入第一个可操作元素，关闭回到触发元素（Radix 自带，自定义浮层照做）                                                                             |
| 键盘触发无动画     | §8.1                                                                                                                                                                                |
| 审批可键盘直答     | 权限卡 ↵ 允许、Esc 拒绝、1–9 按序；节点头审批同                                                                                                                                     |

## §12 边界状态清单 **新**

展示页的夹具（`showcase/fixtures/*`）与审查都要覆盖这些值；组件在这些值下不得溢出、不得错位、不得渲染 `NaN / null / undefined`。

| 类别 | 必测值                                                                                      | 组件要求                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 名字 | 两字名、单字名、CJK 无空格、RTL、emoji 首字、带连字符的长名、首尾多空格、缺名只剩邮箱       | 首字母用 `Intl.Segmenter` 取字素；`dir="auto"`；`truncate` + `title`                         |
| 长串 | 60 字符邮箱、长 URL 带 query、UUID、带括号与版本的文件名、`IMG_…HEIC`、30 字符德语复合词    | `overflow-wrap: anywhere` 或中间截断；等宽；完整值可悬停或复制                               |
| 标签 | 12 枚标签、单枚超宽标签、空标题、`<script>` 字面、含换行、2000 字粘贴                       | 胶囊簇折 `+N`；空标题回退「未命名」；转义；单行字段吞换行；`line-clamp` + 展开               |
| 数字 | 0、1、1284、1000000、负数、`0.1 + 0.2`、142% 与 −3%、`NaN / null / undefined`、实时变化的值 | `Intl.NumberFormat` 千分位 / 紧凑；进度夹到 0–100；空值显示 `—`；`tabular-nums`              |
| 集合 | 0、1、恰好一页、一页 +1、1000+、一条高 10 倍、同名项                                        | 空态；单卡不撑满；分页文案；虚拟化；网格行高按内容；同名项靠次要列区分                       |
| 时间 | 刚刚、12 天前、11 个月前、3 年前、未来、`1970-01-01`、跨时区、1284 小时                     | `Intl.RelativeTimeFormat / DateTimeFormat`；超一周改绝对日期；零时间戳显示 `—`；时长进位到天 |
| 图片 | 头像 404、无头像、4000×200、200×4000、透明深色 logo、慢加载                                 | 首字母回退；`object-fit: cover`；固定 `aspect-ratio`                                         |
| 状态 | 加载、API 错误、部分字段缺失、全部枚举并存、无权限、列表里的自己                            | 骨架同布局；错误不露异常原文；缺字段行仍对齐；胶囊等宽；禁用动作不改布局；「你」标签         |
| 环境 | 容器 320px、280px 侧栏列、2560px、200% 缩放、深色、`dir="rtl"`、触屏                        | 不横向滚动；`min-height` 不 `height`；logical properties；悬停才出现的动作常显或长按         |

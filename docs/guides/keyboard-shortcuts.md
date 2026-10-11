# 键盘快捷键

现行的全部快捷键、它们在哪里生效、与系统 / 浏览器 / 终端的关系。命令表的唯一来源是 `apps/web/src/keybindings/commands.ts`，本表随它维护；设置 → 快捷键里可以逐条改键、加替代键、设为无、改 `when` 条件，或用顶部的「启用快捷键」整体关掉。

## 总开关

- 存在 `settings.keymap.enabled`（[契约 §66](../contracts/core-json-api.md)），缺省为开，跟随主机设置同步；服务器壳上的成员读不到主机设置，按开处理。
- 关掉之后：页面不接任何下表的命令（含编辑器、浏览器节点内的键），终端里的按键全部进 shell，系统全局热键全部释放，菜单与命令面板不再显示键位。
- 仍然生效的只有窗口与系统自己的键：⌘W / Ctrl+W、⌘Q、Alt+F4、macOS 菜单的系统项，以及下文「组件内的键」。

## 写法与规则

- `Mod` 在 macOS（含 iPad 硬件键盘）上是 ⌘，Windows / Linux 上是 Ctrl。
- 「终端」列：焦点在 xterm 里时这条是否仍归应用；「输入」列：焦点在输入框、textarea、contenteditable 里时是否仍归应用。
- **终端控制键一律归 shell**：焦点在终端里时，Ctrl（不带 Shift）或 Alt 加一个键、且没有 ⌘ 的组合（Ctrl+C/D/Z/R/K/P/F/B/W、Alt+B/F/. 等）不会被应用截走，即使用户把它绑给了某条命令。Ctrl+Shift+字母与 ⌘ 组合不受影响。
- 同一组合键只要 `when` 条件能同时成立就算冲突，设置页会标出；内置的「默认」与「VS Code 风格」两个配置档在两个平台上都没有冲突（`keymap-profiles.test.ts` 钉住）。

## 命令表（默认配置档）

| 命令                                                             | macOS                | Windows / Linux                   | 终端 | 输入 | 条件                                                             |
| ---------------------------------------------------------------- | -------------------- | --------------------------------- | ---- | ---- | ---------------------------------------------------------------- |
| 命令面板 `app.commandPalette`                                    | ⌘K                   | Ctrl+K / Ctrl+Shift+P             | 是   | 是   |                                                                  |
| 设置 `app.settings`                                              | ⌘,                   | Ctrl+,                            | 是   | 是   |                                                                  |
| 侧栏 `app.sidebar`                                               | ⇧⌘L                  | Ctrl+Shift+L                      | 是   | 是   |                                                                  |
| 资源管理器 `app.explorer`                                        | ⇧⌘E                  | Ctrl+Shift+E                      | 是   | 是   |                                                                  |
| 源码控制 `app.sourceControl`                                     | ⇧⌘G                  | Ctrl+Shift+G                      | 是   | 是   |                                                                  |
| 资源面板 `app.resources`                                         | ⇧⌘U                  | Ctrl+Shift+U                      | 是   | 是   |                                                                  |
| 快速打开 `app.quickOpen`                                         | ⌘P                   | Ctrl+P                            | 是   | 是   |                                                                  |
| 项目搜索 `app.projectSearch`                                     | ⇧⌘H                  | Ctrl+Shift+H                      | 是   | 是   |                                                                  |
| Git 托管 / 问题 / 引用面板                                       | 无                   | 无                                |      |      | 命令面板进入                                                     |
| 新建终端 `canvas.newTerminal`                                    | ⌘T                   | Ctrl+T                            |      |      |                                                                  |
| 新建 Agent `canvas.newAgent`                                     | ⇧⌘C                  | Ctrl+Shift+C                      |      |      |                                                                  |
| 焦点模式 `canvas.focusMode`                                      | ⇧⌘F                  | Ctrl+Shift+F                      |      |      |                                                                  |
| 最大化节点 `canvas.maximize`                                     | ⇧⌘⏎                  | Ctrl+Shift+Enter                  |      |      |                                                                  |
| 关闭节点 `canvas.closeNode`                                      | 无（⌘W 经壳）        | 无（Ctrl+W 经壳）                 |      |      | 见「壳与菜单」                                                   |
| 撤销 / 重做                                                      | ⌘Z / ⇧⌘Z             | Ctrl+Z / Ctrl+Shift+Z             |      |      |                                                                  |
| 整理画布 `canvas.tidy`                                           | ⇧⌘A                  | Ctrl+Shift+A                      |      |      |                                                                  |
| 导入 Mermaid `canvas.importMermaid`                              | ⇧⌘M                  | Ctrl+Shift+M                      |      |      |                                                                  |
| 放大 / 缩小 / 实际大小 / 适应                                    | ⌘= ⌘- ⌘0 ⌘1          | Ctrl+= Ctrl+- Ctrl+0 Ctrl+1       |      |      |                                                                  |
| 节点间移动焦点                                                   | ⌘←↑→↓                | Ctrl+←↑→↓                         |      |      |                                                                  |
| 删除 `canvas.delete`                                             | ⌫ / ⌦                | Delete / Backspace                |      |      |                                                                  |
| 复制 / 剪切 / 粘贴                                               | ⌘C ⌘X ⌘V             | Ctrl+C Ctrl+X Ctrl+V              |      |      | 粘贴放行给原生 `paste`                                           |
| 网格 / 专注                                                      | ⌘' / ⌘.              | Ctrl+' / Ctrl+.                   |      |      | 专注：`!editorFocus`                                             |
| 白板工具 选择 / 抓手 / 画笔 / 荧光笔 / 形状 / 直线 / 箭头 / 文字 | V H D ⇧D R L A T     | 同左                              |      |      | 工具用完保持选中；原「工具锁定」开关与 Q 键已撤掉                |
| 终端搜索 `terminal.search`                                       | ⌘F                   | Ctrl+F                            | 是   |      | Windows / Linux 终端里 Ctrl+F 归 shell，从节点头部或命令面板打开 |
| 保存 / 重命名 / 格式化                                           | ⌘S / F2 / ⇧⌥F        | Ctrl+S / F2 / Shift+Alt+F         |      | 是   | `editorFocus`                                                    |
| 跳到定义 / 查找引用 / 代码操作 / 跳到行                          | F12 / ⇧F12 / ⌘. / ⌃G | F12 / Shift+F12 / Ctrl+. / Ctrl+G |      | 是   | `editorFocus`                                                    |
| 刷新 / 后退 / 前进 / 地址栏                                      | ⌘R / ⌘[ / ⌘] / ⌘L    | Ctrl+R / Alt+← / Alt+→ / Ctrl+L   |      | 是   | `browserFocus`                                                   |
| 提交 `scm.commit`                                                | ⌘⏎                   | Ctrl+Enter                        |      | 是   | `scmFocus`（Git 提交页内）                                       |
| 显示 / 隐藏窗口、新建终端（系统全局）                            | 无                   | 无                                |      |      | 仅桌面壳，用户设置后才向系统注册                                 |

「VS Code 风格」配置档改动：命令面板 Mod+Shift+P、侧栏 Mod+B、项目搜索 Mod+Shift+F、问题面板 Mod+Shift+M、焦点模式 Mod+Shift+\\、新建终端 Ctrl+`，导入 Mermaid 设为无。

## 壳与菜单

| 按键                         | 平台            | 谁处理                                     | 行为                                                                                                                 |
| ---------------------------- | --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| ⌘W / Ctrl+W                  | 桌面            | 主进程 `keydown-intercept.ts` 拦下后问页面 | 有选中或专注的节点就关节点（受总开关管），否则关窗口（macOS 为隐藏）；Windows / Linux 焦点在终端里时写 `^W` 给该终端 |
| ⌘Q                           | macOS           | 应用菜单                                   | 退出应用与后台服务                                                                                                   |
| ⌘H、⌥⌘H、⌘M                  | macOS           | 系统菜单 role                              | 隐藏、隐藏其他、最小化                                                                                               |
| 编辑菜单 ⌘Z ⇧⌘Z ⌘X ⌘C ⌘V ⌘A  | macOS           | 菜单 role                                  | 页面没接时才轮到菜单                                                                                                 |
| 编辑菜单 Ctrl+Z/Y/X/C/V/A    | Windows / Linux | 菜单 role                                  | 同上；退出没有快捷键，从托盘或菜单                                                                                   |
| Alt+F4                       | Windows / Linux | 系统                                       | 关窗口                                                                                                               |
| 浏览器节点里带主修饰键的组合 | 桌面            | `guest-keys.ts`                            | 除复制、粘贴、全选、撤销、查找、保存、页面缩放与方向键外转给画布；⌘W / Ctrl+W 走上面的关闭流程                       |

## 终端里

- ⌘C（macOS）/ Ctrl+Shift+C：有选区时复制；没有选区时 ⌘C 什么也不做、Ctrl+C 照常发 SIGINT。
- ⌘V / Ctrl+Shift+V：交给 xterm 的粘贴（开启括号粘贴时自动包裹）。
- 应用接管的只有上表「终端」列为「是」且不是终端控制键的组合，其余全部原样进 PTY：Ctrl+C/D/Z/R/K/P/F/B/W、Alt 组合、方向键、F1–F12、Home / End。

## 组件内的键（不可配置）

只在对应控件有焦点或对应状态打开时生效，不进命令表，不受总开关影响：Esc（画布回到选择工具、关闭面板与菜单、退出评论模式、取消文件拖放）、按住 Space 平移、Shift 加选、Mod+滚轮缩放、节点标题上的 Enter / F2 重命名、ACP 输入框 Enter 发送与 Shift+Enter 换行、评论框 Mod+Enter 发送与 Enter / Tab 选提及、命令面板与快速打开的方向键与 Enter。

## 已知冲突与限制

- 网页版（浏览器里打开）：Ctrl / ⌘+T、Ctrl+W 等是浏览器保留键，页面拦不住；Ctrl+Shift+C（开发者工具）、⇧⌘A（Chrome 标签搜索）、Ctrl+Shift+M（Chrome 切换用户）、Ctrl+Shift+E / H（Firefox）可能先被浏览器处理。桌面版不受影响。
- 浏览器节点：总开关关掉后，桌面壳仍会把网页里的主修饰键组合转给画布，此时这些键在网页里不生效。
- 服务器壳成员看不到总开关（主机设置），只能改本设备的键位。
- 手机与平板没有原生按键处理，硬件键盘走同一张网页表；iPad 上 `Mod` 为 ⌘。
- 被隐藏的功能（凭据与密钥、用量统计、活动卡片、定时任务、工作流）没有任何快捷键绑定。

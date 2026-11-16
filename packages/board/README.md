# 画板引擎

`@armadra/board` 是画布的底层引擎，设计见 [画板引擎设计](../../docs/design/board-engine.md)。

| 入口                   | 内容                                          | 依赖                   |
| ---------------------- | --------------------------------------------- | ---------------------- |
| `@armadra/board/core`  | 纯 TypeScript：场景、相机、几何、索引、编解码 | 无（无 DOM、无 React） |
| `@armadra/board/dom`   | 输入路由、手势、分层渲染、绘制                | DOM，无 React          |
| `@armadra/board/react` | 对 dom 入口的薄绑定                           | react（peer）          |

包直接以 TypeScript 源码发布给 `apps/web`，不需要构建：`exports` 指向 `src/`，Vite 与 vitest 会转译
工作区内的源码，类型检查同样读源码。边界由三处强制：`tsconfig.core.json`（类型环境不含 DOM）、
根 `eslint.config.js` 的 import 与全局限制、`pnpm board:budget` 的行数预算。

```sh
pnpm --filter @armadra/board test
pnpm --filter @armadra/board typecheck
pnpm board:budget
```

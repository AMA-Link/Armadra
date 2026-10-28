import { config } from "zod";

/**
 * zod 不按 `new Function` 编译快速路径：控制台来源要求 Trusted Types
 * （`require-trusted-types-for 'script'`，设计 saas-host-open §5.4）之后，那次试探本身就是一条
 * CSP 违规。zod 在**构建** schema 时就读这个开关并试探 eval，所以必须在任何模块构建第一个
 * schema 之前定下：生产构建里它与 zod 同一块（`vite.config.ts` 的 `zod` 组），块一求值就执行；
 * 入口与偏好存储再把它作为第一个导入，开发服务器与测试里同样先于别的模块。
 */
config({ jitless: true });

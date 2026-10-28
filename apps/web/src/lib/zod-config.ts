import { config } from "zod";

/**
 * zod 不按 `new Function` 编译快速路径：控制台来源要求 Trusted Types
 * （`require-trusted-types-for 'script'`，设计 saas-host-open §5.4）之后，那次试探本身就是一条
 * CSP 违规。入口与偏好存储（它在入口正文之前就已求值、读本地偏好时解析）都把它作为第一个
 * 导入，好在任何一次解析之前定下。
 */
config({ jitless: true });

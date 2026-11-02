# syntax=docker/dockerfile:1
#
# 推送中继的正式镜像（#658，运行与变量见 apps/push-relay/README.md）。
#
#   docker build -f apps/push-relay/docker/Dockerfile -t armadra-push-relay .
#
# 构建上下文是仓库根：中继直接打包 apps/desktop/src/core/push 里的 APNs / FCM
# 客户端与信封形状，单拿 apps/push-relay 一个目录造不出来。两段：
#
#   build    只装中继及其依赖闭包，esbuild 打成一个 out/main.js。
#   runtime  node 运行时，没有 npm / 包管理器 / shell 工具，非 root 用户 armadra
#            （uid 10001）；运行时不写任何文件，根文件系统可以只读。
#
# 中继无状态：没有卷。密钥只给文件路径（ARMADRA_RELAY_SECRET_FILE 必填；APNs 的
# .p8 与 FCM 服务账号可选），文件由部署方只读挂进来，文件要让 uid 10001 读得到。

ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build

ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable

WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter @armadra/push-relay... \
 && pnpm --filter @armadra/push-relay build \
 && mkdir -p /app/docker \
 && cp apps/push-relay/out/main.js /app/main.js \
 && cp apps/push-relay/docker/healthcheck.mjs /app/docker/healthcheck.mjs

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="armadra-push-relay" \
      org.opencontainers.image.description="Armadra 推送中继（无状态，端到端加密载荷）" \
      org.opencontainers.image.source="https://github.com/AMA-Link/Armadra" \
      org.opencontainers.image.licenses="NOASSERTION"

# 中继只用 Node 自带模块：去掉 npm / npx / corepack / yarn，缩小体积与攻击面。
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --system --gid 10001 armadra \
 && useradd --system --uid 10001 --gid armadra --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin armadra

COPY --from=build /app /app

ENV NODE_ENV=production \
    # 容器里要从映射的端口进来，不能是缺省的回环；公网前面放 TLS 反向代理。
    ARMADRA_RELAY_HOST=0.0.0.0 \
    ARMADRA_RELAY_PORT=8095

USER armadra:armadra
WORKDIR /app
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

# node 作 PID 1：main.js 自己接 SIGTERM / SIGINT 并关闭监听，没有子进程要回收。
ENTRYPOINT ["node", "/app/main.js"]

// 容器健康检查：从容器里经回环打中继的 `/health`，200 即健康。
//
// 不看 platforms：APNs 与 FCM 凭据可以后补，没配时中继照常启动、照常健康。
import { request } from "node:http";

const port = Number(process.env.ARMADRA_RELAY_PORT || 8095);

const probe = request(
  { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: 4000 },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
probe.on("timeout", () => probe.destroy(new Error("timeout")));
probe.on("error", () => process.exit(1));
probe.end();

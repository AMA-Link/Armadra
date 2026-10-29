import { describe, expect, it } from "vitest";

import {
  SOURCE_CORE_OUTDATED,
  sourceCoreOutdatedDetails,
} from "./source-core-outdated.js";

describe("版本门的独立错误码", () => {
  it("码与云端协议包 0.11 同拼法", () => {
    expect(SOURCE_CORE_OUTDATED).toBe("source_core_outdated");
  });

  it("details：两个版本号原样取；coreVersion 缺省或不是字符串当空串", () => {
    expect(
      sourceCoreOutdatedDetails({ coreVersion: "0.9.9", minVersion: "0.10.0" }),
    ).toEqual({ coreVersion: "0.9.9", minVersion: "0.10.0" });
    expect(sourceCoreOutdatedDetails({ minVersion: "0.10.0" })).toEqual({
      coreVersion: "",
      minVersion: "0.10.0",
    });
    expect(
      sourceCoreOutdatedDetails({ coreVersion: 9, minVersion: "0.10.0" }),
    ).toEqual({ coreVersion: "", minVersion: "0.10.0" });
  });

  it("没有 minVersion 或不是对象：null，调用方按自己知道的门槛补", () => {
    for (const details of [
      undefined,
      null,
      "x",
      {},
      { coreVersion: "0.9.9" },
      { coreVersion: "0.9.9", minVersion: "" },
      { coreVersion: "0.9.9", minVersion: 10 },
    ])
      expect(sourceCoreOutdatedDetails(details), String(details)).toBeNull();
  });
});

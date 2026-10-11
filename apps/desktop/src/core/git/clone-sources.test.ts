import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupFixtures, temporaryDirectory } from "./fixture";
import { defaultCloneParent } from "./clone-sources";

afterAll(() => cleanupFixtures());

describe("克隆的缺省父目录", () => {
  it("家目录下有 Projects 就用它", () => {
    const home = temporaryDirectory("clone-home-projects");
    mkdirSync(join(home, "code"));
    mkdirSync(join(home, "Projects"));
    expect(defaultCloneParent(home)).toEqual({
      parent: join(home, "Projects"),
    });
  });

  it("候选目录都没有就是家目录；没有家目录是空串", () => {
    const home = temporaryDirectory("clone-home-bare");
    expect(defaultCloneParent(home)).toEqual({ parent: home });
    expect(defaultCloneParent(undefined)).toEqual({ parent: "" });
  });
});

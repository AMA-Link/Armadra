import { spaceKey, type SpaceKey } from "./api/keys";

/** 页面所在的空间（云端控制台 §6.2）：个人，或某个团队（带地址里的 slug）。主机与链接页个人 / 团队共用。 */
export type CloudSpace =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamId: string; readonly slug: string };

export const PERSONAL_SPACE: CloudSpace = { kind: "personal" };

/** 线上的 `space` 入参。 */
export const spaceWire = (space: CloudSpace) =>
  space.kind === "personal"
    ? ({ kind: "personal" } as const)
    : ({ kind: "team", teamId: space.teamId } as const);

export const keyOfSpace = (space: CloudSpace): SpaceKey =>
  spaceKey(space.kind === "team" ? space.teamId : undefined);

/** 空间根地址：`/me` 或 `/t/<slug>`。 */
export const spaceBase = (space: CloudSpace) =>
  space.kind === "personal" ? "/me" : `/t/${encodeURIComponent(space.slug)}`;

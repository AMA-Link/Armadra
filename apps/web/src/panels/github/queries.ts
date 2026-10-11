import { srcPrefix } from "../../sources/scope";

/**
 * Query keys for the GitHub credential and the canvas reference badges. Every
 * key carries the source and the workspace, so switching either one cannot
 * show the previous one's answer.
 */
export const githubKeys = {
  get all() {
    return [...srcPrefix(), "github"] as const;
  },
  references: (workspaceId: string, targetId: string) =>
    [...srcPrefix(), "github", "references", workspaceId, targetId] as const,
  credential: (workspaceId: string) =>
    [...srcPrefix(), "github", "credential", workspaceId] as const,
};

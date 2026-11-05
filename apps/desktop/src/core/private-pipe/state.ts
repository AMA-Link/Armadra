/**
 * Whether the private pipes of this run have a hardened DACL (contract §102.3).
 *
 * `hardened`: every pipe's descriptor was replaced and read back as expected.
 * `default`: at least one pipe is served on the handshake alone because the
 * DACL could not be tightened (no helper, PowerShell locked down, a policy
 * block). Absent when this run has no pipe at all — every non-Windows run.
 * Surfaces in `GET /health` as `pipeAcl`.
 */
export type PipeAcl = "hardened" | "default";

const pipes = new Map<string, PipeAcl>();

export function recordPipeAcl(pipe: string, state: PipeAcl): void {
  pipes.set(pipe.toLowerCase(), state);
}

export function forgetPipeAcl(pipe: string): void {
  pipes.delete(pipe.toLowerCase());
}

export function pipeAclSummary(): PipeAcl | undefined {
  if (pipes.size === 0) return undefined;
  return [...pipes.values()].includes("default") ? "default" : "hardened";
}

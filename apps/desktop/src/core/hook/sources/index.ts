import { registerNodeChannelGate } from "../../agent/state-source";
import { registerStateSlot } from "../../timeline/sources/state-slot";
import { type GrokDeps, grokSlotProvider, realGrokDeps } from "./grok-events";

/**
 * Registers the status sources core reads itself (no hook client, no extension):
 * a slot provider per CLI (`timeline/sources/state-slot.ts`) and the per-node
 * rule for whether that CLI's channel exists on a given node. Returns the undo.
 *
 * grok: the channel is the session record on this machine, so it does not exist
 * on a remote node, on Windows (no `active_sessions.json` reader, no `ps`), or
 * where the slot found the record unreadable (`unbound`) — the delivery gate
 * then takes the observed path instead of waiting for a first report that cannot
 * come. Contract §121.
 */
export function installCoreStateSources(
  deps: GrokDeps = realGrokDeps,
): () => void {
  const offs = [
    registerStateSlot(grokSlotProvider(deps)),
    registerNodeChannelGate(
      "grok",
      (facts) =>
        !facts.remote && facts.unbound !== true && deps.platform() !== "win32",
    ),
  ];
  return () => {
    for (const off of offs) off();
  };
}

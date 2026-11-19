/**
 * Preset names for new terminal and agent nodes (Armadra#969).
 *
 * A new node gets the first word of {@link PRESET_NODE_NAMES} that nobody on
 * the same board answers to — neither as a title nor as a handle — and the
 * word becomes both its title (`Atlas`) and its handle (`atlas`). Once the
 * pool is used up the words come round again with a number (`Atlas 2` /
 * `atlas-2`).
 *
 * The words are the same in every locale: they are names, not descriptions,
 * and a handle has to be ASCII anyway. The agent type is not in the name: it
 * is the header mark's job (`AGENT_REGISTRY[id].mark`), so the name survives
 * auto-title rewriting the title and still says who the node is.
 *
 * The web page (`store/canvas/nodes.ts`) and core's control verbs
 * (`collab/control/nodes.ts`) both call {@link presetNodeName}, so a node made
 * from the menu and one made by `canvas open-agent` are named the same way.
 */
export const PRESET_NODE_NAMES = [
  "Atlas",
  "Birch",
  "Cedar",
  "Comet",
  "Delta",
  "Ember",
  "Fern",
  "Flint",
  "Harbor",
  "Iris",
  "Juniper",
  "Kite",
  "Lark",
  "Maple",
  "Nova",
  "Onyx",
  "Orbit",
  "Pebble",
  "Quill",
  "Raven",
  "Sage",
  "Tide",
  "Vega",
  "Willow",
] as const;

/** The highest round tried before giving up and reusing a numbered name. */
const MAX_ROUNDS = 99;

export interface PresetNodeName {
  /** What the header shows: `Atlas`, `Atlas 2`. */
  readonly title: string;
  /** What other agents call it: `atlas`, `atlas-2`. */
  readonly handle: string;
}

/** The smallest shape this needs from a node: title plus `data.handle`. */
export interface NamedNode {
  readonly title?: string | null;
  readonly data?: unknown;
}

function handleIn(data: unknown): string | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const raw = (data as Record<string, unknown>).handle;
  return typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
}

function nameAt(word: string, round: number): PresetNodeName {
  const handle = word.toLowerCase();
  return round === 1
    ? { title: word, handle }
    : { title: `${word} ${round}`, handle: `${handle}-${round}` };
}

/**
 * The next free preset name on a board.
 *
 * `reserved` holds names already handed out in the same batch (a team of
 * members created at once) that are not in `nodes` yet. Titles and handles
 * are compared case-folded, and both forms of a numbered name are checked,
 * so a node someone titled `atlas` by hand still takes `Atlas` off the list.
 */
export function presetNodeName(
  nodes: readonly NamedNode[],
  reserved: Iterable<string> = [],
): PresetNodeName {
  const taken = new Set<string>();
  const take = (value: string | undefined | null): void => {
    const folded = value?.trim().toLowerCase();
    if (folded) taken.add(folded);
  };
  for (const node of nodes) {
    take(node.title);
    take(handleIn(node.data));
  }
  for (const value of reserved) take(value);
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    for (const word of PRESET_NODE_NAMES) {
      const name = nameAt(word, round);
      if (!taken.has(name.handle) && !taken.has(name.title.toLowerCase())) {
        return name;
      }
    }
  }
  // 2,376 nodes on one board: hand out the last numbered name and let the
  // handle table refuse it rather than loop forever.
  return nameAt(PRESET_NODE_NAMES[0], MAX_ROUNDS + 1);
}

/**
 * Whether `title` is still the preset name that goes with `handle`, i.e.
 * nobody has renamed the node since it was created. Auto-title treats such a
 * title as a placeholder it may replace.
 */
export function isPresetTitle(
  title: string,
  handle: string | undefined,
): boolean {
  if (handle === undefined) return false;
  const match = /^([a-z]+)(?:-(\d+))?$/.exec(handle.trim().toLowerCase());
  if (!match) return false;
  const word = PRESET_NODE_NAMES.find(
    (candidate) => candidate.toLowerCase() === match[1],
  );
  if (word === undefined) return false;
  const round = match[2] === undefined ? 1 : Number(match[2]);
  if (round < 2 && match[2] !== undefined) return false;
  return nameAt(word, round).title === title.trim();
}

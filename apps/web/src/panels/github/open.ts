import { create } from "zustand";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * What the GitHub page is looking at. Kept out of the board document: it is a
 * view preference, not something to undo or save.
 *
 * Selecting an Issue and asking to *see* it are separate intents, so `reveal`
 * is a counter — a card asking for the same Issue twice still navigates.
 */
export type GithubTab = "issues" | "pulls";

/**
 * The repository a revealed item lives in: the page looks it up before it can
 * show the item.
 */
export interface ForgeFocusTarget {
  readonly forge: "github" | "gitea" | "gitlab";
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export const useGithubFocus = create<{
  tab: GithubTab;
  number: bigint | null;
  /** The repository of the last revealed item; `null` when unknown. */
  target: ForgeFocusTarget | null;
  reveal: number;
  focus: (tab: GithubTab, number: bigint | null) => void;
  show: (
    tab: GithubTab,
    number: bigint,
    target?: ForgeFocusTarget | null,
  ) => void;
}>((set) => ({
  tab: "issues",
  number: null,
  target: null,
  focus: (tab, number) => set({ tab, number }),
  reveal: 0,
  show: (tab, number, target = null) =>
    set((state) => ({ tab, number, target, reveal: state.reveal + 1 })),
}));

/**
 * Opens the code-hosting page, on one Issue or pull request of the named
 * repository when given a number.
 */
export function openGithubPanel(
  tab: GithubTab = "issues",
  number: bigint | null = null,
  target: ForgeFocusTarget | null = null,
): void {
  const focus = useGithubFocus.getState();
  if (number !== null) focus.show(tab, number, target);
  else focus.focus(tab, null);
  useCanvasStore.getState().setPanel("github", "drawer");
}

import { describe, expect, it } from "vitest";
import { DELIVERY_LANES, DELIVERY_PHRASES } from "@armadra/shared";

import { translate } from "@/i18n";
import {
  BOARD_LANES,
  PHRASE_TONE,
  laneKey,
  phraseKey,
  phraseTone,
  pullRank,
  sortPulls,
} from "./model";
import { pull } from "./fixtures";

describe("PHRASE_TONE", () => {
  it("covers every phrase of every lane and nothing else", () => {
    const all = DELIVERY_LANES.flatMap((lane) => [...DELIVERY_PHRASES[lane]]);
    expect(Object.keys(PHRASE_TONE).sort()).toEqual([...all].sort());
  });

  it("falls back to idle for an unknown phrase", () => {
    expect(phraseTone("somethingNew")).toBe("idle");
  });
});

describe("sortPulls", () => {
  it("puts the least ready pull first", () => {
    const conflicting = pull({ number: 5, mergeable: "conflicting" });
    const failing = pull({
      number: 4,
      checks: { read: true, headSha: "a", rollup: "failure", failing: ["ci"] },
    });
    const changes = pull({ number: 3, review: "changesRequested" });
    const draft = pull({ number: 2, draft: true });
    const ready = pull({ number: 1, review: "approved" });
    const merged = pull({ number: 0, state: "merged" });
    const sorted = sortPulls([
      merged,
      ready,
      draft,
      changes,
      failing,
      conflicting,
    ]);
    expect(sorted.map((p) => p.number)).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it("breaks ties by number and does not mutate the input", () => {
    const input = [pull({ number: 9 }), pull({ number: 7 })];
    expect(sortPulls(input).map((p) => p.number)).toEqual([7, 9]);
    expect(input.map((p) => p.number)).toEqual([9, 7]);
    expect(pullRank(pull({ state: "closed" }))).toBeGreaterThan(
      pullRank(pull()),
    );
  });
});

describe("i18n keys", () => {
  it.each(["zh-CN", "en"] as const)(
    "every lane and phrase has a %s label",
    (locale) => {
      for (const lane of BOARD_LANES) {
        const key = laneKey(lane);
        expect(translate(locale, key), key).not.toBe(key);
      }
      for (const lane of DELIVERY_LANES) {
        for (const phrase of DELIVERY_PHRASES[lane]) {
          const key = phraseKey(lane, phrase);
          expect(translate(locale, key), key).not.toBe(key);
        }
      }
    },
  );
});

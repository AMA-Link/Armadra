import { beforeEach, describe, expect, it } from "vitest";

import { scoped } from "../sources/scope";
import {
  EMPTY_DELIVERY,
  beginDelivery,
  useAcpStore,
  type AcpDeliveryView,
} from "./store";

const prompt = { clientTurnId: "c1", text: "go", attachments: [] } as const;
const NOW = 1_760_000_000_000;

describe("beginDelivery", () => {
  it("draws the question and remembers the turn", () => {
    expect(beginDelivery(EMPTY_DELIVERY, prompt, NOW)).toEqual({
      pending: { ...prompt, at: NOW },
      clientTurnId: "c1",
      lastPrompt: "go",
      confirming: false,
      undelivered: false,
      failed: false,
    });
  });

  it("retrying the undelivered turn keeps the question that is already drawn", () => {
    const sent = beginDelivery(EMPTY_DELIVERY, prompt, NOW);
    const lost: AcpDeliveryView = { ...sent, undelivered: true };
    const retried = beginDelivery(lost, prompt, NOW + 5);
    expect(retried.pending).toBe(sent.pending);
    expect(retried.undelivered).toBe(false);
  });

  it("a new turn replaces the previous one and clears the failure flags", () => {
    const failed: AcpDeliveryView = {
      ...beginDelivery(EMPTY_DELIVERY, prompt, NOW),
      failed: true,
    };
    const next = beginDelivery(
      failed,
      { clientTurnId: "c2", text: "again", attachments: [] },
      NOW + 5,
    );
    expect(next.pending?.clientTurnId).toBe("c2");
    expect(next.failed).toBe(false);
    expect(next.lastPrompt).toBe("again");
  });
});

describe("delivery store", () => {
  const view = () => useAcpStore.getState().sessions[scoped("s1")];
  beforeEach(() => useAcpStore.getState().reset());

  it("walks sent -> confirming -> undelivered, and a core echo ends it", () => {
    const store = useAcpStore.getState();
    store.begin("s1", prompt);
    store.confirm("s1");
    expect(view()?.confirming).toBe(true);
    store.undeliver("s1");
    expect(view()).toMatchObject({ confirming: false, undelivered: true });
    // 重试后 core 回显了这一轮：不再需要页面自己画，也不再是「没送达」。
    store.begin("s1", prompt);
    store.ack("s1", "c1", true);
    expect(view()).toMatchObject({ pending: null, undelivered: false });
  });

  it("an echo of another turn leaves the pending question alone", () => {
    const store = useAcpStore.getState();
    store.begin("s1", prompt);
    store.ack("s1", "someone-else", true);
    expect(view()?.pending?.clientTurnId).toBe("c1");
  });

  it("a local echo (legacy path) does not count as delivery proof", () => {
    const store = useAcpStore.getState();
    store.begin("s1", prompt);
    store.confirm("s1");
    store.ack("s1", "c1", false);
    expect(view()).toMatchObject({ pending: null, confirming: true });
  });

  it("only a confirming turn can become undelivered", () => {
    const store = useAcpStore.getState();
    store.begin("s1", prompt);
    store.undeliver("s1");
    expect(view()?.undelivered).toBe(false);
    store.fail("s1");
    expect(view()?.failed).toBe(true);
    store.delivered("s1");
    expect(view()?.failed).toBe(true);
  });
});

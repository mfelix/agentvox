import { describe, it, expect, beforeEach, vi } from "vitest";

describe("PriorityQueue", () => {
  let queue;

  beforeEach(async () => {
    const { PriorityQueue } = await import("../queue.js");
    queue = new PriorityQueue({ maxSize: 5, dedupWindowMs: 1000, batchSubAgents: true });
  });

  it("dequeues high priority before normal", () => {
    queue.enqueue({ sessionId: "a", priority: "normal", context: "normal msg" });
    queue.enqueue({ sessionId: "b", priority: "high", context: "urgent msg" });

    const first = queue.dequeue();
    expect(first.priority).toBe("high");
    expect(first.context).toBe("urgent msg");
  });

  it("dequeues normal before low", () => {
    queue.enqueue({ sessionId: "a", priority: "low", context: "sub-agent" });
    queue.enqueue({ sessionId: "b", priority: "normal", context: "main" });

    const first = queue.dequeue();
    expect(first.priority).toBe("normal");
  });

  it("maintains FIFO within same priority", () => {
    queue.enqueue({ sessionId: "a", priority: "normal", context: "first" });
    queue.enqueue({ sessionId: "b", priority: "normal", context: "second" });

    expect(queue.dequeue().context).toBe("first");
    expect(queue.dequeue().context).toBe("second");
  });

  it("deduplicates by sessionId within window", () => {
    queue.enqueue({ sessionId: "a", priority: "normal", context: "old" });
    queue.enqueue({ sessionId: "a", priority: "normal", context: "new" });

    expect(queue.size()).toBe(1);
    expect(queue.dequeue().context).toBe("new");
  });

  it("drops oldest low-priority when full", () => {
    // Fill with 5 items (max)
    for (let i = 0; i < 3; i++) {
      queue.enqueue({ sessionId: `low-${i}`, priority: "low", context: `low-${i}` });
    }
    queue.enqueue({ sessionId: "n1", priority: "normal", context: "normal-1" });
    queue.enqueue({ sessionId: "n2", priority: "normal", context: "normal-2" });
    expect(queue.size()).toBe(5);

    // Adding one more should drop oldest low
    queue.enqueue({ sessionId: "n3", priority: "normal", context: "normal-3" });
    expect(queue.size()).toBe(5);

    // All normals should survive
    const items = queue.drain();
    const normalItems = items.filter((i) => i.priority === "normal");
    expect(normalItems.length).toBe(3);
  });

  it("returns null when empty", () => {
    expect(queue.dequeue()).toBeNull();
  });

  it("returns pending items via pending()", () => {
    queue.enqueue({ sessionId: "a", priority: "high", context: "one" });
    queue.enqueue({ sessionId: "b", priority: "normal", context: "two" });

    const pending = queue.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0].priority).toBe("high");
  });
});

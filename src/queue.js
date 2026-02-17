const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

export class PriorityQueue {
  constructor({ maxSize = 20, dedupWindowMs = 10000, batchSubAgents = true } = {}) {
    this.maxSize = maxSize;
    this.dedupWindowMs = dedupWindowMs;
    this.batchSubAgents = batchSubAgents;
    this.items = [];
    this.listeners = [];
  }

  enqueue(message) {
    const now = Date.now();
    message.enqueuedAt = now;

    // Dedup: replace existing message from same sessionId within window
    const existingIdx = this.items.findIndex(
      (item) =>
        item.sessionId === message.sessionId &&
        now - item.enqueuedAt < this.dedupWindowMs
    );
    if (existingIdx !== -1) {
      this.items[existingIdx] = message;
      this._notify("update", message);
      return;
    }

    // If at capacity, drop oldest low-priority
    if (this.items.length >= this.maxSize) {
      const lowIdx = this._findOldestLow();
      if (lowIdx !== -1) {
        this.items.splice(lowIdx, 1);
      } else {
        // All high/normal — drop oldest overall
        this.items.shift();
      }
    }

    this.items.push(message);
    this._notify("enqueue", message);
  }

  dequeue() {
    if (this.items.length === 0) return null;

    // Find highest priority item (lowest PRIORITY_ORDER value)
    let bestIdx = 0;
    let bestPriority = PRIORITY_ORDER[this.items[0].priority] ?? 1;

    for (let i = 1; i < this.items.length; i++) {
      const p = PRIORITY_ORDER[this.items[i].priority] ?? 1;
      if (p < bestPriority) {
        bestPriority = p;
        bestIdx = i;
      }
    }

    const item = this.items.splice(bestIdx, 1)[0];
    this._notify("dequeue", item);
    return item;
  }

  pending() {
    return [...this.items].sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
    );
  }

  drain() {
    const all = this.pending();
    this.items = [];
    return all;
  }

  size() {
    return this.items.length;
  }

  onEvent(listener) {
    this.listeners.push(listener);
  }

  _findOldestLow() {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].priority === "low") return i;
    }
    return -1;
  }

  _notify(event, message) {
    for (const listener of this.listeners) {
      listener(event, message);
    }
  }
}

// In-process job queue for dev (docs/02: "In-process for dev, Redis for prod").
// Same Job interface as the worker consumes; swap this for Redis without
// touching producers.
import type { Job } from "@repo/core";

type Handler = (job: Job) => void | Promise<void>;

class InMemoryQueue {
  private handlers: Set<Handler> = new Set();
  private buffer: Job[] = [];

  enqueue(job: Job) {
    this.buffer.push(job);
    this.drain();
  }

  onJob(handler: Handler) {
    this.handlers.add(handler);
    this.drain();
  }

  private drain() {
    while (this.buffer.length > 0 && this.handlers.size > 0) {
      const job = this.buffer.shift()!;
      for (const handler of this.handlers) void handler(job);
    }
  }
}

export const queue = new InMemoryQueue();
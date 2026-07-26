// The registry is a document with a compiler, so this suite asserts the two
// things a document cannot: that every entry agrees with doc 39's tables, and
// that the numbers restated elsewhere in the codebase have not drifted from it.

import { describe, expect, it } from "vitest";

import {
  QUEUE_NAMES,
  QUEUE_REGISTRY,
  flowControlKey,
  isQueueName,
  queuePath,
} from "./queues";

describe("the queue registry", () => {
  it("registers only queues that doc 39 names", () => {
    expect([...QUEUE_NAMES]).toEqual(["notify.email", "ocr.process"]);
  });

  // 0029's `jobs_queue_check` constrains the shape of the column, and a
  // registry entry that could not be stored would fail at the first enqueue.
  it("every queue name satisfies the database's shape check", () => {
    for (const queue of QUEUE_NAMES) {
      expect(queue).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  // Doc 39: "retries on publish = jobs.max_attempts - 1 (default 5 total
  // attempts)". The receipt pipeline's own budget is 3 (doc 36, and the
  // `ocr.max_attempts` setting 0028's sweep reads).
  it("carries doc 39's attempt budgets", () => {
    expect(QUEUE_REGISTRY["notify.email"].maxAttempts).toBe(5);
    expect(QUEUE_REGISTRY["ocr.process"].maxAttempts).toBe(3);
  });

  // 0029 bounds max_attempts between 1 and 20; an entry outside that range
  // would insert fine in TypeScript and fail with 23514 at runtime.
  it("keeps every budget inside the column's constraint", () => {
    for (const entry of Object.values(QUEUE_REGISTRY)) {
      expect(entry.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(entry.maxAttempts).toBeLessThanOrEqual(20);
    }
  });

  it("carries doc 39's timeout budgets", () => {
    expect(QUEUE_REGISTRY["notify.email"].maxDurationSeconds).toBe(60);
    expect(QUEUE_REGISTRY["ocr.process"].maxDurationSeconds).toBe(120);
  });

  it("carries doc 39's flow-control keys and limits", () => {
    expect(QUEUE_REGISTRY["notify.email"].flowControlKey).toBe("email:{business_id}");
    expect(QUEUE_REGISTRY["notify.email"].flowControlValue).toBe("rate=10");
    expect(QUEUE_REGISTRY["ocr.process"].flowControlKey).toBe("ocr");
    expect(QUEUE_REGISTRY["ocr.process"].flowControlValue).toBe("parallelism=10");
  });
});

describe("flowControlKey", () => {
  // Doc 39's fairness rule: one business's blast queues behind its OWN key
  // while other tenants proceed. That only works if the substitution happens.
  it("substitutes the tenant so one business cannot starve another", () => {
    expect(flowControlKey("notify.email", "biz-1")).toBe("email.biz-1");
    expect(flowControlKey("notify.email", "biz-2")).toBe("email.biz-2");
  });

  it("groups platform-level work under a named key rather than an empty one", () => {
    expect(flowControlKey("notify.email", null)).toBe("email.platform");
  });

  it("leaves a queue-wide key alone", () => {
    expect(flowControlKey("ocr.process", "biz-1")).toBe("ocr");
  });

  // Measured against the live API 2026-07-26: a key carrying doc 39's colon is
  // answered with `400 flowControlKey must be alphanumeric, hyphen, underscore,
  // or period`, and a rejected publish does not merely lose the grouping, it
  // loses the delivery. The registry keeps doc 39's notation; this is where it
  // becomes legal on the wire.
  it("emits only characters QStash accepts, whatever the tenant id looks like", () => {
    expect(flowControlKey("notify.email", "a:b/c d")).toBe("email.a.b.c.d");
    expect(flowControlKey("notify.email", "0198f0a1-0000-7000-8000-000000000001")).toMatch(
      /^[A-Za-z0-9._-]+$/,
    );
  });
});

describe("queuePath", () => {
  // The mapping is mechanical on purpose: the queue name IS the path segment,
  // so there is no second registry translating one into the other, and
  // verify.ts's destination check compares against exactly this.
  it("maps a queue name straight onto its route", () => {
    expect(queuePath("notify.email")).toBe("/api/jobs/notify.email");
    expect(queuePath("ocr.process")).toBe("/api/jobs/ocr.process");
  });
});

describe("isQueueName", () => {
  it("accepts registered queues and refuses everything else", () => {
    expect(isQueueName("notify.email")).toBe(true);
    // In doc 39's registry, absent from this build because it has no worker. A
    // registry entry for a queue with no route would make the enqueue compile,
    // publish, and 404 forever.
    expect(isQueueName("cleanup.temp")).toBe(false);
    expect(isQueueName("../../admin")).toBe(false);
  });
});

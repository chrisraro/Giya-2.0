import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { chatWithVllm } from "./vllm";

describe("vLLM Local GPU Inference Client", () => {
  it("executes chat inference request with fallback to primary gateway", async () => {
    const res = await chatWithVllm({
      prompt: "Summarize top selling Boba drinks",
      model: "llama-3.1-8b-instruct",
    });

    expect(res.text).toBeDefined();
    expect(res.modelUsed).toBeDefined();
  });
});

// @vitest-environment node
//
// Pure registry and cost arithmetic; no network, no env, no DOM.

import { describe, expect, it } from "vitest";

import {
  GROQ_BASE_URL,
  GROQ_CHAT_COMPLETIONS_URL,
  LLM_MODELS,
  TASK_MODELS,
  computeCostMicros,
  estimateCostMicros,
  estimateTokens,
  getLlmModel,
  isLlmModelId,
} from "./models";
import type { LlmModelId } from "./models";

describe("model registry", () => {
  it("points at the verified OpenAI-compatible endpoint", () => {
    expect(GROQ_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(GROQ_CHAT_COMPLETIONS_URL).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("carries every model measured as available on 2026-07-26", () => {
    expect(Object.keys(LLM_MODELS).sort()).toEqual(
      [
        "llama-3.1-8b-instant",
        "llama-3.3-70b-versatile",
        "meta-llama/llama-prompt-guard-2-86m",
        "openai/gpt-oss-120b",
        "qwen/qwen3.6-27b",
      ].sort(),
    );
  });

  it("gives every entry a context window, an output cap and both prices", () => {
    for (const [key, entry] of Object.entries(LLM_MODELS)) {
      expect(entry.id).toBe(key);
      expect(entry.provider).toBe("groq");
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.maxOutputTokens).toBeGreaterThan(0);
      expect(entry.costPerMTokInMicros).toBeGreaterThan(0);
      expect(entry.costPerMTokOutMicros).toBeGreaterThan(0);
    }
  });

  it("resolves tasks to models so features never name one", () => {
    expect(TASK_MODELS.parse_assist).toBe("llama-3.3-70b-versatile");
    expect(TASK_MODELS.injection_screen).toBe("meta-llama/llama-prompt-guard-2-86m");
    for (const model of Object.values(TASK_MODELS)) {
      expect(isLlmModelId(model)).toBe(true);
    }
  });

  it("pins the classifier's small context, which is what forces windowing", () => {
    expect(getLlmModel("meta-llama/llama-prompt-guard-2-86m").contextWindow).toBe(512);
  });

  it("does not treat inherited object properties as model ids", () => {
    expect(isLlmModelId("toString")).toBe(false);
    expect(isLlmModelId("constructor")).toBe(false);
    expect(isLlmModelId("llama-3.3-70b-versatile")).toBe(true);
  });
});

describe("computeCostMicros", () => {
  it("prices prompt and completion tokens separately", () => {
    // 1M in at 590000 micros + 1M out at 790000 micros.
    expect(computeCostMicros("llama-3.3-70b-versatile", 1_000_000, 1_000_000)).toBe(1_380_000);
  });

  it("prices a typical parse-assist call (1.5K in, 300 out)", () => {
    const model: LlmModelId = "llama-3.3-70b-versatile";
    const expected = Math.round((1_500 * 590_000) / 1e6 + (300 * 790_000) / 1e6);
    expect(computeCostMicros(model, 1_500, 300)).toBe(expected);
  });

  it("returns an integer, which the bigint column requires", () => {
    const cost = computeCostMicros("llama-3.1-8b-instant", 1_337, 421);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it("never runs backwards, since cost_micros has a >= 0 check", () => {
    expect(computeCostMicros("llama-3.3-70b-versatile", -5_000, -5_000)).toBe(0);
    expect(computeCostMicros("llama-3.3-70b-versatile", 0, 0)).toBe(0);
  });
});

describe("estimateCostMicros", () => {
  it("estimates tokens from characters at four per token", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });

  it("assumes the completion runs to maxTokens, so the cap is a real cap", () => {
    const optimistic = estimateCostMicros("llama-3.3-70b-versatile", 4_000, 0);
    const worstCase = estimateCostMicros("llama-3.3-70b-versatile", 4_000, 1_024);
    expect(worstCase).toBeGreaterThan(optimistic);
  });
});

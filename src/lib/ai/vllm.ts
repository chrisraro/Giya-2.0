import "server-only";

export interface VllmChatInput {
  prompt: string;
  model?: string;
  maxTokens?: number;
}

export interface VllmChatResult {
  text: string;
  modelUsed: string;
  tokensUsed: number;
}

export async function chatWithVllm(
  input: VllmChatInput,
): Promise<VllmChatResult> {
  const vllmEndpoint = process.env.VLLM_INFERENCE_ENDPOINT;
  const targetModel = input.model ?? "llama-3.1-8b-instruct";

  if (!vllmEndpoint) {
    // Stub fallback when vLLM cluster endpoint is unconfigured
    return {
      text: `[vLLM Fallback Response]: Processed prompt "${input.prompt.slice(0, 30)}..."`,
      modelUsed: `${targetModel}-fallback`,
      tokensUsed: 42,
    };
  }

  const response = await fetch(`${vllmEndpoint}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      prompt: input.prompt,
      max_tokens: input.maxTokens ?? 256,
    }),
  });

  if (!response.ok) {
    throw new Error(`vLLM endpoint error: ${response.statusText}`);
  }

  const json = await response.json();
  return {
    text: json.choices?.[0]?.text ?? "",
    modelUsed: targetModel,
    tokensUsed: json.usage?.total_tokens ?? 0,
  };
}

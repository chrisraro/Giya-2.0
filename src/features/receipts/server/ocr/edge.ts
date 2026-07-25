import "server-only";

import { createHttpOcrProvider } from "./http";
import type { OcrProvider } from "./provider";

// The third OCR implementation: the Supabase Edge Function in
// supabase/functions/ocr/index.ts, per the spec's section 2.1
// (docs/superpowers/specs/2026-07-26-ocr-rag-extraction-design.md).
//
// WHY THIS IS SO SHORT. The Edge Function honours doc 36 Stage 4's contract
// verbatim - same request fields, same response fields, same 401/413/422/503
// taxonomy - so there is nothing new to speak. Everything this provider needs
// already exists in ./http.ts: the request body, the status-to-OcrError
// mapping with its explicit retry decisions, the abort-based timeout that can
// tell a timeout from a transport failure, and the Zod validation of the 200
// body. A second copy of that logic would be a second place for the retry
// decisions to drift, and those decisions are the ones that keep a transient
// Hugging Face throttle from being recorded as a terminal failure. So this
// module configures ./http.ts rather than reimplementing it, and the two
// differences are exactly the two knobs it passes.
//
// The differences:
//
//   1. THE PATH. The container mounts OCR at `{OCR_SERVICE_URL}/v1/ocr`. A
//      Supabase Edge Function's URL IS the endpoint
//      (https://{ref}.supabase.co/functions/v1/ocr), so nothing is appended.
//   2. THE NAME. Reported as "edge", so a log line or a future
//      `ocr_results`-adjacent trace says which of the two HTTP paths answered.
//      The database column already distinguishes them independently: the Edge
//      Function writes `engine: "hf-vlm"` where the container writes
//      `engine: "paddleocr"`, and the stub writes `engine: "stub"`.
//
// WHAT THE CALLER SHOULD KNOW ABOUT FAILURE. The Edge Function's engine is a
// Hugging Face vision-language model on an account with no billing, so 402 and
// 429 are expected operating conditions rather than exceptions. The function
// folds both onto 503, which arrives here as OCR_UNAVAILABLE with
// `retryable: true`, and if the attempt budget runs out the receipt routes to
// review. It never becomes a transcription, and therefore never becomes an
// award (plan risk 3).

/**
 * The token is a per-environment shared secret (`OCR_FUNCTION_SECRET`), NOT
 * the service role key. The Edge Function's header comment carries the full
 * argument; the short version is that the function needs no database access,
 * so sending it the database god-key to authenticate would spread the
 * highest-privilege credential we own for no capability it can use.
 */
export interface EdgeOcrProviderConfig {
  /** `SUPABASE_EDGE_OCR_URL`, e.g. https://{ref}.supabase.co/functions/v1/ocr */
  functionUrl: string;
  /** `OCR_FUNCTION_SECRET`, sent as `Authorization: Bearer {secret}`. */
  secret: string;
  /** Defaults to OCR_WORKER_TIMEOUT_MS (30s), doc 36 Stage 4's worker budget. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function createEdgeOcrProvider(config: EdgeOcrProviderConfig): OcrProvider {
  return createHttpOcrProvider({
    baseUrl: config.functionUrl,
    token: config.secret,
    providerName: "edge",
    ocrPath: "",
    // Spread rather than assign: exactOptionalPropertyTypes is on, so passing
    // an explicit `undefined` is not the same as omitting the key.
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
}

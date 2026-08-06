import "server-only";

import { z } from "zod";

import { getServerEnv } from "@/lib/env";

// =============================================================================
// The Resend gateway. One module, one send, one contract.
// =============================================================================
//
// docs/30-modules/30-platform-core.md section 5.2 step 3 names Resend as the
// email channel and docs/30-modules/39-background-jobs.md's `notify.email`
// queue is what reaches it. Like src/lib/ai/llm.ts, the provider is reached
// with plain `fetch` against its REST API rather than an SDK: there is one
// endpoint, the request is four fields, and a dependency would buy nothing but
// a supply-chain surface on the path that talks to our users' inboxes.
//
// A second caller: src/lib/alerts/job-health.ts (task 2.5) calls this
// function directly, bypassing the notify.email queue entirely - its
// recipient is an operator address with no `profiles` row behind it, so the
// queue's `notifications`-table plumbing (addressed to a `profiles.id`) has
// nothing to attach to. See that module's own header for the full argument.
// Still exactly one Resend integration, one send, one contract - a second
// CALLER of this function, never a second implementation of "send an email".
//
// -----------------------------------------------------------------------------
// THE SENDER IS A PLACEHOLDER, AND THE CODE SAYS SO
// -----------------------------------------------------------------------------
// `DEFAULT_FROM` below is Resend's shared sandbox address. It is not Giya's, it
// is not on a domain this project controls, and mail from it will land in spam
// for a meaningful fraction of recipients. It is the default because it is the
// only address that can send at all today: no domain is verified on this
// account, and the API key in use is send-scoped - it authenticates POST /emails
// and is refused by /domains with `restricted_api_key`, so this code could not
// check the domain list even if it wanted to, and deliberately never tries.
//
// MEASURED LIVE, 2026-07-26, and it is the part that matters operationally:
// while the sender is the sandbox address, Resend delivers to the ACCOUNT
// OWNER'S ADDRESS AND NOBODY ELSE. Every other recipient is answered with
//
//   403  You can only send testing emails to your own email address. To send
//        emails to other recipients, please verify a domain at
//        resend.com/domains, and change the `from` address to an email using
//        this domain.
//
// So this channel is verifiably wired and structurally undeliverable to real
// consumers until a domain is verified. That is a deployment fact rather than a
// code path, and it needs no special handling here: the 403 is classified
// terminal below, which is exactly right - it marks the notification row failed
// with the provider's own explanation instead of retrying five times against a
// rule that will not change on its own, and an operator reading
// `notifications.error` sees the reason in Resend's words.
//
// Setting EMAIL_FROM to a verified sender is the whole of the fix. Nothing else
// in this file changes.
//
// -----------------------------------------------------------------------------
// THE CONTRACT: NEVER THROWS, AND THE CALLER IS TOLD WHETHER TO RETRY
// -----------------------------------------------------------------------------
// Every failure is a returned value, exactly as src/lib/ai/llm.ts returns null.
// The difference is that a failure here carries `retryable`, because the caller
// is a queue worker and doc 39's failure taxonomy turns on precisely that
// distinction: a 5xx or a 429 is "Resend transient", which means status='failed'
// and a 5xx to QStash, while a 422 on a malformed address is terminal and means
// status='dead' and a 200. Collapsing the two would either retry a bad address
// five times or give up on a blip.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const LOG_PREFIX = "[email/send]";

/**
 * Resend's shared sandbox sender. A PLACEHOLDER - see the module header. It
 * needs no domain verification, which is the only reason mail leaves this
 * codebase at all today.
 */
export const DEFAULT_FROM = "Giya <onboarding@resend.dev>";

/**
 * One send's wall clock. Generous relative to the API (which answers in a few
 * hundred milliseconds) and small relative to the queue's 60s budget, so a
 * wedged provider costs a job ten seconds rather than the whole worker.
 */
const SEND_TIMEOUT_MS = 10_000;

/** Resend answers a successful send with the id it assigned. Validated rather
 * than trusted, for the reason src/lib/ai/llm.ts states about its own provider:
 * an HTML error page served with a 200 must produce a clean failure, not
 * `undefined` two frames deeper. */
const sendResponseSchema = z.object({ id: z.string().min(1) });

/** The error body Resend returns. Every field optional: it is read only to make
 * the log line useful, and a missing field must never be the thing that turns a
 * send failure into an exception. */
const errorResponseSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
});

export interface SendEmailInput {
  /** A single recipient. Batching is Resend's `/emails/batch`, which this slice
   * does not use: doc 39's fan-out is one notification row per recipient, so a
   * batch here would be a second grouping with different failure semantics. */
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /** The plain-text part. REQUIRED, not optional: see render.ts. */
  readonly text: string;
  /** Overrides EMAIL_FROM and the default. Used by nothing in production. */
  readonly from?: string;
  /** Injected in tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export type SendEmailResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      /** Doc 39's taxonomy: true = retryable, false = terminal. */
      readonly retryable: boolean;
      /** OPERATOR VOCABULARY. Lands in `jobs.last_error` and
       * `notifications.error`, both of which are withheld from clients. */
      readonly reason: string;
    };

/**
 * Retry classification, deliberately narrow and the mirror of the one in
 * src/lib/ai/llm.ts.
 *
 * 429 and 5xx are "not now, ask again". 408 is the provider timing itself out,
 * same class. Everything else in the 4xx range is a bug in the request we just
 * built - a malformed address (422), a revoked key (401), a sender the account
 * may not use (403) - and re-sending an identical bad request cannot change the
 * answer. It would only burn four more attempts before landing in the DLQ with
 * the same message.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** The From header: the explicit override, then EMAIL_FROM, then the sandbox
 * placeholder. */
export function resolveFrom(override: string | undefined): string {
  if (override !== undefined && override.length > 0) return override;
  try {
    return getServerEnv().EMAIL_FROM ?? DEFAULT_FROM;
  } catch {
    // getServerEnv throws when any REQUIRED server key is missing, including
    // ones with nothing to do with email. That must not decide the sender.
    return DEFAULT_FROM;
  }
}

function resolveApiKey(): string | null {
  try {
    const key = getServerEnv().RESEND_API_KEY;
    return key === undefined || key.length === 0 ? null : key;
  } catch (error) {
    console.warn(`${LOG_PREFIX} server env is unreadable; not sending`, error);
    return null;
  }
}

/**
 * Send one email.
 *
 * NEVER THROWS. Returns `{ok: true, id}` or `{ok: false, retryable, reason}`
 * for every failure: no API key, network refused, timeout, 4xx, 5xx, a non-JSON
 * body, a body that does not carry an id.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = resolveApiKey();
  if (apiKey === null) {
    // The documented dormant state, identical in shape to the LLM's and the OCR
    // container's. TERMINAL rather than retryable: a credential does not appear
    // by retrying, and marking it retryable would have every queued email spend
    // five attempts and land in the DLQ, burying the real failures under a pile
    // of "not configured".
    console.warn(`${LOG_PREFIX} RESEND_API_KEY is not configured; nothing was sent`);
    return { ok: false, retryable: false, reason: "email is not configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, SEND_TIMEOUT_MS);

  try {
    const response = await (input.fetchImpl ?? globalThis.fetch)(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resolveFrom(input.from),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      const retryable = isRetryableStatus(response.status);
      console.error(
        `${LOG_PREFIX} Resend refused the send with status ${response.status} (retryable=${retryable}): ${detail}`,
      );
      return { ok: false, retryable, reason: `resend ${response.status}: ${detail}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A 2xx whose body cannot be read. The message may well have been
      // accepted, so this is treated as TERMINAL rather than retryable: the one
      // outcome worse than not knowing whether an email went out is sending it
      // again to find out.
      console.error(`${LOG_PREFIX} Resend returned a non-JSON body for an accepted send`);
      return { ok: false, retryable: false, reason: "resend returned an unreadable body" };
    }

    const parsed = sendResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.error(`${LOG_PREFIX} Resend returned an unexpected body shape for an accepted send`);
      return { ok: false, retryable: false, reason: "resend returned an unexpected body" };
    }

    return { ok: true, id: parsed.data.id };
  } catch (error) {
    // A timeout, or DNS/TLS/socket. "Not reachable right now" is the same
    // retryable class as a 503.
    console.error(`${LOG_PREFIX} could not reach Resend`, error);
    return { ok: false, retryable: true, reason: "resend was unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The provider's own words for the log, or a stand-in. Never throws, because
 * this runs on a path that is already failing. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const parsed = errorResponseSchema.safeParse(await response.json());
    if (!parsed.success) return "no detail";
    return parsed.data.message ?? parsed.data.name ?? "no detail";
  } catch {
    return "no detail";
  }
}

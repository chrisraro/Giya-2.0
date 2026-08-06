// @vitest-environment node
//
// The email worker, and the three properties that decide whether an email is
// safe to send at all:
//
//   1. IDEMPOTENCE BY ENTITY. A replayed batch re-sends nothing already sent,
//      because every send is gated on `status='pending'` in the query itself.
//      This is the guarantee the job claim cannot give: a worker that sends and
//      then dies leaves a job the reclaim path will legitimately hand to
//      another invocation, and only the row's own status stops the second send.
//   2. NO FRAUD INTERNALS. The words come from the row, which came from
//      receipt-copy.ts. Nothing here composes copy, and the test sweeps the
//      rendered output against doc 37's vocabulary to prove it.
//   3. PREFERENCES WIN AT SEND TIME. Doc 30 section 5.5: re-checked by the
//      worker, so an opt-out that arrives after fan-out is honoured.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SendEmailResult } from "@/lib/email/send";
import type { Database } from "@/lib/supabase/types";

import { emailCopy, runNotifyEmail } from "./email";

const ORIGIN = "https://giya.example";

interface Row {
  id: string;
  user_id: string;
  business_id: string | null;
  kind: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  data: unknown;
}

function rejectionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "n1",
    user_id: "u1",
    business_id: "biz-1",
    kind: "receipt_rejected",
    channel: "email",
    status: "pending",
    // Verbatim from receipt-copy.ts's `duplicate` branch, which is what the
    // receipts slice stores on the row.
    title: "Already scanned",
    body: "This receipt is already on your account. Each receipt can earn points once.",
    data: { route: "/scan/r1", params: { receipt_id: "r1", reject_reason: "duplicate" } },
    ...overrides,
  };
}

interface DoubleOptions {
  readonly rows?: Row[];
  readonly readError?: { message: string } | null;
  readonly profile?: { is_suspended: boolean; consumers: { email_enabled: boolean } | null } | null;
  readonly profileError?: { message: string } | null;
}

interface Recorded {
  readonly id: string;
  readonly patch: Record<string, unknown>;
}

function supabaseDouble(options: DoubleOptions = {}) {
  const updates: Recorded[] = [];
  const rows = options.rows ?? [rejectionRow()];

  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                options.profileError
                  ? { data: null, error: options.profileError }
                  : {
                      data:
                        options.profile === undefined
                          ? { is_suspended: false, consumers: { email_enabled: true } }
                          : options.profile,
                      error: null,
                    },
            }),
          }),
        };
      }

      return {
        select: () => {
          const chain = {
            in: () => chain,
            eq: () => chain,
            returns: async () =>
              options.readError
                ? { data: null, error: options.readError }
                : { data: rows, error: null },
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          let id = "";
          const chain = {
            eq(column: string, value: string) {
              if (column === "id") id = value;
              return chain;
            },
            then(resolve: (value: { error: null }) => unknown) {
              updates.push({ id, patch });
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { client, updates };
}

type Send = (input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<SendEmailResult>;

function sendDouble(result: SendEmailResult = { ok: true, id: "resend-1" }) {
  return vi.fn<Send>(async () => result);
}

const deps = (overrides: Record<string, unknown> = {}) => ({
  origin: ORIGIN,
  resolveAddress: async () => "consumer@example.com",
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runNotifyEmail", () => {
  it("sends a pending email row and records the outcome on it", async () => {
    const { client, updates } = supabaseDouble();
    const send = sendDouble();

    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );

    expect(result).toEqual({ sent: 1, skipped: 0, failedTerminal: 0, failedRetryable: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.patch).toMatchObject({ status: "sent", error: null });
    expect(updates[0]?.patch.sent_at).toEqual(expect.any(String));
  });

  // IDEMPOTENCE BY ENTITY. The batch query filters on `status='pending'`, so a
  // replay finds nothing and sends nothing. Doc 39: "a replayed batch re-sends
  // nothing already sent."
  it("re-sends nothing when the rows are already sent", async () => {
    const { client, updates } = supabaseDouble({ rows: [] });
    const send = sendDouble();

    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1", "n2"] },
      { supabase: client, send, ...deps() },
    );

    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result).toEqual({ sent: 0, skipped: 2, failedTerminal: 0, failedRetryable: 0 });
  });

  it("counts ids that did not come back as skipped, not as failures", async () => {
    const { client } = supabaseDouble({ rows: [rejectionRow()] });
    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1", "n2", "n3"] },
      { supabase: client, send: sendDouble(), ...deps() },
    );
    expect(result).toMatchObject({ sent: 1, skipped: 2 });
  });

  // The row is left PENDING on a retryable failure, on purpose: marking it
  // failed would take it out of the query and the next delivery would find
  // nothing to do, which is the message being dropped silently.
  it("leaves a row pending when the send fails in a way a retry could fix", async () => {
    const { client, updates } = supabaseDouble();
    const send = sendDouble({ ok: false, retryable: true, reason: "resend 429" });

    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );

    expect(result).toMatchObject({ failedRetryable: 1, sent: 0 });
    expect(updates).toHaveLength(0);
  });

  it("records a terminal failure on the row so it is not retried forever", async () => {
    const { client, updates } = supabaseDouble();
    const send = sendDouble({ ok: false, retryable: false, reason: "resend 422: bad address" });

    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );

    expect(result).toMatchObject({ failedTerminal: 1 });
    expect(updates[0]?.patch).toMatchObject({
      status: "failed",
      error: "resend 422: bad address",
      sent_at: null,
    });
  });

  it("treats an unreadable batch as retryable rather than as nothing to do", async () => {
    const { client } = supabaseDouble({ readError: { message: "connection reset" } });
    const send = sendDouble();
    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1", "n2"] },
      { supabase: client, send, ...deps() },
    );
    expect(result).toEqual({ sent: 0, skipped: 0, failedTerminal: 0, failedRetryable: 2 });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps going through the batch when one row throws", async () => {
    const { client } = supabaseDouble({
      rows: [rejectionRow({ id: "n1" }), rejectionRow({ id: "n2" })],
    });
    let call = 0;
    const send = vi.fn<Send>(async (): Promise<SendEmailResult> => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return { ok: true, id: "resend-2" };
    });

    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1", "n2"] },
      { supabase: client, send, ...deps() },
    );

    expect(result).toMatchObject({ sent: 1, failedRetryable: 1 });
  });
});

describe("preferences are re-checked at send time", () => {
  // Doc 30 section 5.5. The consumer's last word is the one that counts, so an
  // opt-out arriving after the row was written must still win.
  it("does not email a consumer who turned email off", async () => {
    const { client, updates } = supabaseDouble({
      profile: { is_suspended: false, consumers: { email_enabled: false } },
    });
    const send = sendDouble();

    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(updates[0]?.patch).toMatchObject({
      status: "failed",
      error: "recipient has email turned off",
    });
  });

  it("does not email a suspended recipient", async () => {
    const { client } = supabaseDouble({
      profile: { is_suspended: true, consumers: { email_enabled: true } },
    });
    const send = sendDouble();
    await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );
    expect(send).not.toHaveBeenCalled();
  });

  // FAIL CLOSED, which is the opposite of most reads in this codebase and the
  // right direction here: a message not sent can be sent later, and a message
  // sent to someone who opted out cannot be unsent.
  it("does not email when the preference row cannot be read", async () => {
    const { client } = supabaseDouble({ profileError: { message: "timeout" } });
    const send = sendDouble();
    await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("does not email a consumer-only kind sent to a profile with no consumers row", async () => {
    const { client } = supabaseDouble({ profile: { is_suspended: false, consumers: null } });
    const send = sendDouble();
    await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );
    expect(send).not.toHaveBeenCalled();
  });

  // Review fix (task 1.2, I4): campaign_budget_exhausted is addressed to a
  // business owner, who by definition has no `consumers` row - that must not
  // suppress it the way it correctly suppresses a MISMATCHED kind above.
  it("DOES email a staff-facing kind (campaign_budget_exhausted) sent to a profile with no consumers row", async () => {
    const { client, updates } = supabaseDouble({
      rows: [
        rejectionRow({
          kind: "campaign_budget_exhausted",
          title: "A campaign paused itself",
          body: "Capped Promo reached its points budget and has been paused automatically.",
          data: { route: "/business/campaigns", params: { campaign_id: "camp-1" } },
        }),
      ],
      profile: { is_suspended: false, consumers: null },
    });
    const send = sendDouble();

    const result = await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: 1 });
    expect(updates[0]?.patch).toMatchObject({ status: "sent" });
  });

  it("still suspends a staff-facing kind for a suspended owner", async () => {
    const { client } = supabaseDouble({
      rows: [rejectionRow({ kind: "campaign_budget_exhausted" })],
      profile: { is_suspended: true, consumers: null },
    });
    const send = sendDouble();
    await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("records a missing address rather than sending nowhere", async () => {
    const { client, updates } = supabaseDouble();
    const send = sendDouble();
    await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps({ resolveAddress: async () => null }) },
    );
    expect(send).not.toHaveBeenCalled();
    expect(updates[0]?.patch).toMatchObject({ error: "no email address on the account" });
  });
});

describe("the words are the row's", () => {
  it("sends the stored title and body verbatim", async () => {
    const { client } = supabaseDouble();
    const send = sendDouble();
    const row = rejectionRow();

    await runNotifyEmail(
      { job_id: "job-1", notification_ids: ["n1"] },
      { supabase: client, send, ...deps() },
    );

    const call = send.mock.calls[0]?.[0];
    expect(call?.subject).toBe(row.title);
    expect(call?.text).toContain(row.body);
  });

  // Doc 33's "never expose fraud signal internals", swept the same way
  // receipt-copy.test.ts and notify.test.ts sweep their own output. An email is
  // the worst place for this leak: it persists in an inbox and is indexed by a
  // mail provider.
  it("leaks no fraud vocabulary into either part of the message", async () => {
    const forbidden = [
      "fraud",
      "signal",
      "score",
      "confidence",
      "threshold",
      "velocity",
      "hash",
      "device",
      "suspicious",
      "blocked",
      "duplicate of",
      "matched",
    ];

    for (const reason of [
      "duplicate",
      "unreadable",
      "wrong_business",
      "too_old",
      "fraud_suspected",
      "manual",
    ]) {
      const { client } = supabaseDouble({
        rows: [
          rejectionRow({
            data: { route: "/scan/r1", params: { receipt_id: "r1", reject_reason: reason } },
          }),
        ],
      });
      const send = sendDouble();
      await runNotifyEmail(
        { job_id: "job-1", notification_ids: ["n1"] },
        { supabase: client, send, ...deps() },
      );

      const call = send.mock.calls[0]?.[0];
      const rendered = `${call?.subject} ${call?.text}`.toLowerCase();
      for (const word of forbidden) {
        expect(rendered, `reason=${reason} word=${word}`).not.toContain(word);
      }
    }
  });
});

describe("emailCopy", () => {
  // The action is looked up from receipt-copy.ts as a matched label-and-href
  // pair, so this file still authors no copy.
  it("takes the call to action from the rejection matrix", () => {
    const copy = emailCopy(rejectionRow(), ORIGIN);
    expect(copy.action).toEqual({ label: "See my receipts", href: "/receipts" });
  });

  it("uses the matrix's default branch for an unrecognised reason", () => {
    const copy = emailCopy(
      rejectionRow({ data: { params: { reject_reason: "something_new" } } }),
      ORIGIN,
    );
    expect(copy.action).toEqual({ label: "Take another photo", href: "/scan" });
  });

  // `fraud_suspected` is the one rejection with NO retake call to action:
  // inviting a retry after a fraud-family rejection turns the pipeline into a
  // feedback loop an abuser can iterate against. The email must not restore it.
  it("offers no retake after a fraud-family rejection", () => {
    const copy = emailCopy(
      rejectionRow({ data: { params: { reject_reason: "fraud_suspected" } } }),
      ORIGIN,
    );
    expect(copy.action?.href).not.toBe("/scan");
    expect(copy.action).toEqual({ label: "Back to wallet", href: "/wallet" });
  });

  it("drops the action entirely with no origin to resolve it against", () => {
    expect(emailCopy(rejectionRow(), null).action).toBeUndefined();
  });

  it("falls back to the stored deep link for a kind with no matrix entry", () => {
    const copy = emailCopy(rejectionRow({ kind: "points_awarded" }), ORIGIN);
    expect(copy.action).toEqual({ label: "Open Giya", href: "/scan/r1" });
  });
});

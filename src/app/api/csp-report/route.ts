import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requestLogger, resolveRequestId } from "@/lib/log";
import { checkRateLimit } from "@/lib/rate-limit";

// =============================================================================
// POST /api/csp-report - browser CSP violation telemetry (doc 15 "Transport & headers").
// =============================================================================
//
// WHY THIS ROUTE DOES NOT USE defineHandler: browsers send these reports anonymously and
// expect no envelope. defineHandler starts with a session lookup (a Supabase round trip per
// report) and answers with JSON nobody reads. This is fire-and-forget telemetry:
// unauthenticated, size-capped, rate limited per IP, always 204. the proxy/middleware matcher excludes this
// path from its matcher so a stray sb- cookie never adds an auth round trip either.
//
// WHAT IS LOGGED: only the directive, the blocked origin, the document PATH and the
// disposition. Full URLs routinely carry tokens (invite links, OAuth codes, signed storage
// URLs) and `script-sample` can carry page content, so neither query strings nor samples
// are ever copied into a log line.

/** A real report is well under 2 KB; 16 KB leaves room for long URLs and refuses abuse. */
export const MAX_REPORT_BYTES = 16 * 1024;
const MAX_REPORTS_PER_REQUEST = 10;
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60;

const str = z.string().optional();

// Lenient on purpose: browsers differ and add fields; `looseObject` keeps unknown keys.
const legacyEnvelope = z.looseObject({
  "csp-report": z.looseObject({
    "document-uri": str,
    "effective-directive": str,
    "violated-directive": str,
    "blocked-uri": str,
    disposition: str,
  }),
});

const reportingEntry = z.looseObject({
  type: z.string(),
  body: z.looseObject({
    documentURL: str,
    effectiveDirective: str,
    blockedURL: str,
    disposition: str,
  }),
});

interface Violation {
  directive: string;
  blocked: string;
  document: string;
  disposition: string;
}

const clip = (value: string | undefined, max = 100) => (value ?? "").slice(0, max);

/** Origin of a URL; keywords (`inline`, `eval`, `self`) kept; `data:`/`blob:` reduced to the scheme. */
function blockedOrigin(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return clip(url.origin === "null" ? `${url.protocol}//` : url.origin, 200);
    } catch {
      return "invalid";
    }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme) return `${scheme[1]!.toLowerCase()}:`;
  return /^[a-z-]{1,20}$/i.test(value) ? value : "other";
}

function documentPath(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return clip(new URL(raw).pathname, 200);
  } catch {
    return "";
  }
}

function extract(payload: unknown): Violation[] {
  const legacy = legacyEnvelope.safeParse(payload);
  if (legacy.success) {
    const r = legacy.data["csp-report"];
    return [
      {
        directive: clip(r["effective-directive"] ?? r["violated-directive"]),
        blocked: blockedOrigin(r["blocked-uri"]),
        document: documentPath(r["document-uri"]),
        disposition: clip(r.disposition, 20),
      },
    ];
  }
  if (!Array.isArray(payload)) return [];
  const out: Violation[] = [];
  for (const entry of payload.slice(0, MAX_REPORTS_PER_REQUEST)) {
    const parsed = reportingEntry.safeParse(entry);
    if (!parsed.success || parsed.data.type !== "csp-violation") continue;
    const b = parsed.data.body;
    out.push({
      directive: clip(b.effectiveDirective),
      blocked: blockedOrigin(b.blockedURL),
      document: documentPath(b.documentURL),
      disposition: clip(b.disposition, 20),
    });
  }
  return out;
}

function clientIp(request: NextRequest): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || "unknown";
}

const noContent = () => new NextResponse(null, { status: 204 });

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REPORT_BYTES) return noContent();

  // Fail open: a Redis outage must not turn telemetry into an error, and a lost report is cheap.
  try {
    const limit = await checkRateLimit({
      key: `csp-report:${clientIp(request)}`,
      limit: RATE_LIMIT,
      windowSeconds: RATE_WINDOW_SECONDS,
      failMode: "open",
    });
    if (!limit.ok) return noContent();
  } catch {
    // swallow: see above
  }

  // Content-Length can be absent or lie, so the cap is re-checked on the bytes actually read.
  const text = await request.text().catch(() => "");
  if (!text || text.length > MAX_REPORT_BYTES) return noContent();

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return noContent();
  }

  const log = requestLogger(resolveRequestId(request.headers.get("x-request-id")));
  for (const v of extract(payload)) {
    log.warn("[csp] violation", {
      directive: v.directive,
      blocked_origin: v.blocked,
      document_path: v.document,
      disposition: v.disposition,
    });
  }
  return noContent();
}

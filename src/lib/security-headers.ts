// Baseline response headers (doc 15 "Transport & headers"). Pure so the policy can be
// unit-tested without booting Next; next.config.ts only wires it to `headers()`.

export interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

export interface SecurityHeaderEnv {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string | undefined;
  readonly SENTRY_DSN?: string | undefined;
}

/** Host of a URL, or null when it does not parse (a bad env value must not break the build). */
function hostOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

/**
 * Content-Security-Policy value, built from what the app actually loads:
 *  - Supabase: REST/auth/storage over https, Realtime over wss, storage images.
 *  - Facebook: connect.facebook.net SDK + www/web.facebook.com page-plugin frames
 *    (features/integrations/meta/components/facebook-page-embed.tsx), fbcdn images.
 *  - hCaptcha: script, frame, connect and style (its widget injects a stylesheet).
 *  - MapTiler raster tiles as <img> (lib/maps/tile-source.ts).
 *  - Sentry ingest host, derived from SENTRY_DSN, only when configured.
 *  - blob:/data: for camera preview, captured receipts and QR images.
 *  Fonts are self-hosted (geist via next/font), so no font origins.
 *
 * NEXT STEP (doc 15 asks for nonce-based script-src): Next's inline bootstrap scripts need
 * 'unsafe-inline' until a per-request nonce is issued from middleware. It stays here, in
 * report-only, so enforcing later is a deliberate change and not an accident.
 */
export function buildCsp(env: SecurityHeaderEnv, opts: { dev?: boolean } = {}): string {
  const supabase = hostOf(env.NEXT_PUBLIC_SUPABASE_URL);
  // `URL.host` drops the DSN's public key (userinfo), leaving only the ingest host.
  const sentry = hostOf(env.SENTRY_DSN);
  const supabaseHttps = supabase ? [`https://${supabase}`] : [];
  const supabaseWss = supabase ? [`wss://${supabase}`] : [];
  const sentryHttps = sentry ? [`https://${sentry}`] : [];

  const directives: Record<string, readonly string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      ...(opts.dev ? ["'unsafe-eval'"] : []),
      "https://connect.facebook.net",
      "https://hcaptcha.com",
      "https://*.hcaptcha.com",
    ],
    "style-src": ["'self'", "'unsafe-inline'", "https://hcaptcha.com", "https://*.hcaptcha.com"],
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      ...supabaseHttps,
      "https://api.maptiler.com",
      "https://*.fbcdn.net",
      "https://www.facebook.com",
    ],
    "media-src": ["'self'", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      ...supabaseHttps,
      ...supabaseWss,
      ...sentryHttps,
      "https://hcaptcha.com",
      "https://*.hcaptcha.com",
      "https://www.facebook.com",
      "https://connect.facebook.net",
    ],
    "frame-src": [
      "'self'",
      "https://www.facebook.com",
      "https://web.facebook.com",
      "https://hcaptcha.com",
      "https://*.hcaptcha.com",
    ],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    // OAuth sign-in navigates via redirects, not form posts, so self is enough.
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  return [
    ...Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(" ")}`),
    "upgrade-insecure-requests",
  ].join("; ");
}

export function buildSecurityHeaders(
  env: SecurityHeaderEnv,
  opts: { dev?: boolean } = {},
): SecurityHeader[] {
  return [
    // Both the legacy header and frame-ancestors: the admin console, redemption scanner and
    // business portal must never be framed (clickjacking on destructive actions).
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // camera: receipt scanner + redemption QR scanner (getUserMedia). geolocation: the
    // business location picker's "use my location". Nothing uses microphone or Payment Request.
    {
      key: "Permissions-Policy",
      value: "camera=(self), geolocation=(self), microphone=(), payment=()",
    },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    // Report-only first (doc 15: two weeks before enforcing); an unvetted enforcing CSP could
    // break production. Swap the key to Content-Security-Policy to enforce.
    { key: "Content-Security-Policy-Report-Only", value: buildCsp(env, opts) },
  ];
}

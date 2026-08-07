// Email rendering: clean HTML + plain text generator.

export interface EmailCopy {
  readonly title: string;
  readonly body: string;
  readonly action?: { readonly label: string; readonly href: string };
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface RenderEmailInput {
  readonly copy: EmailCopy;
  readonly origin: string | null;
  readonly businessName?: string | null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function absoluteUrl(href: string, origin: string | null): string | null {
  if (origin === null) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
}

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const MAX_WIDTH = "36rem";

export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const { copy, origin } = input;
  const actionUrl = copy.action ? absoluteUrl(copy.action.href, origin) : null;
  const signature =
    input.businessName === undefined || input.businessName === null
      ? "Giya"
      : `${input.businessName}, through Giya`;

  const preheader = firstSentence(copy.body);

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(copy.title)}</title>`,
    "</head>",
    `<body style="margin:0;padding:1.5rem;font-family:${FONT_STACK};font-size:1rem;line-height:1.6;">`,
    `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>`,
    `<main style="max-width:${MAX_WIDTH};margin:0 auto;">`,
    `<h1 style="font-size:1.25rem;line-height:1.4;margin:0 0 1rem;">${escapeHtml(copy.title)}</h1>`,
    `<p style="margin:0 0 1.5rem;">${escapeHtml(copy.body)}</p>`,
    ...(copy.action && actionUrl !== null
      ? [
          `<p style="margin:0 0 1.5rem;"><a href="${escapeHtml(actionUrl)}">${escapeHtml(copy.action.label)}</a></p>`,
        ]
      : []),
    `<p style="margin:0;font-size:0.875rem;">${escapeHtml(signature)}</p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");

  const text = [
    copy.title,
    "",
    copy.body,
    ...(copy.action && actionUrl !== null ? ["", `${copy.action.label}: ${actionUrl}`] : []),
    "",
    signature,
    "",
  ].join("\n");

  return { subject: copy.title, html, text };
}

function firstSentence(body: string): string {
  const match = /^[^.!?]*[.!?]/.exec(body.trim());
  return (match?.[0] ?? body).trim();
}

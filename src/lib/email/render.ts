// Email rendering: one message, two parts, no dependencies.
//
// PURE. No React, no database, no network, no `server-only` - it is a function
// from a copy object to two strings, which is what makes the whole matrix
// testable without sending anything. Same shape and same reasoning as
// src/features/receipts/components/receipt-copy.ts, which is where the words
// themselves come from.
//
// -----------------------------------------------------------------------------
// THIS MODULE AUTHORS NO COPY
// -----------------------------------------------------------------------------
// Every string it renders is handed to it. The receipts slice composes its
// messages from receipt-copy.ts - the consumer-safe matrix that is swept, string
// by string, against doc 37's fraud vocabulary - and this module puts those
// strings into two envelopes. Writing a second set of words here would put them
// outside that sweep, and an email is the worst possible place for the leak that
// follows: it persists in an inbox, it is forwarded, and it is indexed by a
// mail provider. See src/workers/notify/email.ts for the composition, and
// src/features/receipts/server/notify.ts for the same discipline applied to the
// in-app channel.
//
// -----------------------------------------------------------------------------
// WHY THERE IS NO DESIGN IN HERE
// -----------------------------------------------------------------------------
// No colours, no logo, no background, no web font, no layout table. That is a
// decision, and it is not laziness:
//
//   * Colour. This app's design system is MD3 tokens resolved from CSS custom
//     properties (doc 16), and email clients support neither. The alternative is
//     hardcoded hex, which the repo's own lint rule bans in src/ for exactly the
//     reason it would be wrong here too: it is a second, unmaintained palette
//     that cannot follow the design system and cannot follow the reader. An
//     email with no colours inherits the mail client's own, so it is legible in
//     that client's light mode and in its dark mode without a media query that
//     half of them ignore.
//   * Layout tables. They exist to make a design survive Outlook. With no design
//     to survive, a table would only make the plain-text extraction worse for
//     screen readers.
//   * Images. A logo is a tracking-shaped request to a third party, blocked by
//     default in most clients, and this message must read identically whether or
//     not images load. The cheapest way to guarantee that is to have none.
//
// What IS here is the accessibility that actually matters in a mail client: a
// `lang` attribute, one `<h1>`, real paragraphs, a real `<a>` with text that
// says where it goes, a `max-width` so the line length is readable on a desktop
// client, and a plain-text part that is a complete message rather than a
// degraded one.

/** The shape this module renders. Structurally the receipts slice's
 * `ReceiptOutcomeCopy` minus the icon, which no email can show. */
export interface EmailCopy {
  readonly title: string;
  readonly body: string;
  /** The one next step, when there is an honest one. */
  readonly action?: { readonly label: string; readonly href: string };
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface RenderEmailInput {
  readonly copy: EmailCopy;
  /**
   * Absolute origin for the action link, e.g. `https://giya.example`. Copy
   * carries app-relative hrefs (`/scan/{id}`) because the in-app channel renders
   * them as router links; an email is read outside the app, so a relative href
   * would be dead. Null means the link is DROPPED rather than rendered
   * relative - a "Take another photo" button that goes nowhere is worse than a
   * message that simply tells the reader what happened.
   */
  readonly origin: string | null;
  /**
   * Who the message is from, in words rather than in a From header: "Kape
   * Diaria" or null for the platform. Appended to the signature so the reader
   * can tell which shop a receipt belonged to without the subject line having to
   * carry it.
   */
  readonly businessName?: string | null;
}

/**
 * HTML-escape. Applied to EVERY interpolated value without exception.
 *
 * Not paranoia: the strings passed in are composed from a business name, and a
 * business name is user-supplied text that a merchant types into a form. A shop
 * called `<img onerror=...>` would otherwise be an injection into an email body,
 * which is a place scripts do not run but images and links very much do. The
 * escape covers the five characters that can start something in HTML.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Absolute URL for an app-relative href, or null when it cannot be made one.
 *
 * The same shape check `notificationRoute` applies in the in-app channel, and
 * for a stricter version of the same reason. A path that is already absolute is
 * refused rather than passed through: this function's callers all hand it copy
 * hrefs, which are app routes by contract, and accepting an absolute URL here
 * would make "the link in a Giya email" a thing any future caller could point
 * anywhere. `//evil.example` is refused for the protocol-relative trick.
 */
export function absoluteUrl(href: string, origin: string | null): string | null {
  if (origin === null) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
}

/**
 * A system font stack. Named families only, so the message uses whatever the
 * reader's mail client already renders text in rather than requesting a web
 * font that most clients will not load and some will replace with a fallback
 * mid-paragraph.
 */
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Comfortable measure for a desktop mail client, in pixels. */
const MAX_WIDTH = "36rem";

export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const { copy, origin } = input;
  const actionUrl = copy.action ? absoluteUrl(copy.action.href, origin) : null;
  const signature =
    input.businessName === undefined || input.businessName === null
      ? "Giya"
      : `${input.businessName}, through Giya`;

  // The preheader: the line a mail client shows beside the subject in the
  // list. Left as the first sentence of the body rather than invented, so the
  // preview never says something the message does not.
  const preheader = firstSentence(copy.body);

  const html = [
    "<!doctype html>",
    // `lang` is the one accessibility attribute a screen reader in a mail
    // client genuinely acts on: without it the message is read in the reader's
    // default language, which mangles English in a Filipino locale and vice
    // versa.
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(copy.title)}</title>`,
    "</head>",
    `<body style="margin:0;padding:1.5rem;font-family:${FONT_STACK};font-size:1rem;line-height:1.6;">`,
    // The preheader, hidden from the rendered message but read by the client's
    // list preview. `display:none` alone is ignored by some clients, hence the
    // zero-size belt as well.
    `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>`,
    `<main style="max-width:${MAX_WIDTH};margin:0 auto;">`,
    // Exactly one h1, and it is the same sentence as the subject. A message
    // whose heading and subject disagree reads as a forward of something else.
    `<h1 style="font-size:1.25rem;line-height:1.4;margin:0 0 1rem;">${escapeHtml(copy.title)}</h1>`,
    `<p style="margin:0 0 1.5rem;">${escapeHtml(copy.body)}</p>`,
    ...(copy.action && actionUrl !== null
      ? [
          // A plain link rather than a button, because a "button" in email is a
          // padded anchor whose padding depends on colours we are not setting.
          // The link TEXT says where it goes, so it is meaningful read out of
          // context by a screen reader (never "click here").
          `<p style="margin:0 0 1.5rem;"><a href="${escapeHtml(actionUrl)}">${escapeHtml(copy.action.label)}</a></p>`,
        ]
      : []),
    `<p style="margin:0;font-size:0.875rem;">${escapeHtml(signature)}</p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");

  // The plain-text part is a COMPLETE message, not a stripped one. Some clients
  // are configured to prefer it, some readers prefer it, and a text part that
  // reads as debris ("View this email in your browser") is how a service teaches
  // people that its plain text is not worth reading.
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

/** First sentence, for the preview line. Falls back to the whole body. */
function firstSentence(body: string): string {
  const match = /^[^.!?]*[.!?]/.exec(body.trim());
  return (match?.[0] ?? body).trim();
}

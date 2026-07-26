// The renderer is pure, so this suite is the whole of its contract: escaping,
// link handling, and the plain-text part being a complete message rather than
// debris.
//
// The escaping tests are the ones that matter. Every string reaching this
// module has passed through a business name at some point, and a business name
// is text a merchant types into a form.

import { describe, expect, it } from "vitest";

import { absoluteUrl, escapeHtml, renderEmail } from "./render";

const ORIGIN = "https://giya.example";

const REJECTION = {
  title: "We could not read this photo",
  body: "Try again in brighter light with the whole receipt flat in the frame, and make sure the total and the date are in shot.",
  action: { label: "Take another photo", href: "/scan" },
};

describe("escapeHtml", () => {
  it("neutralises every character that can open a tag or an attribute", () => {
    expect(escapeHtml(`<img src="x" onerror='y'>&`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;",
    );
  });

  it("escapes the ampersand first so an escape cannot be double-encoded into an entity", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("absoluteUrl", () => {
  it("makes an app-relative href absolute", () => {
    expect(absoluteUrl("/scan/abc", ORIGIN)).toBe("https://giya.example/scan/abc");
  });

  // The protocol-relative trick: `//evil.example` is a URL, not a path, and it
  // is the same one notificationRoute refuses in the inbox.
  it("refuses a protocol-relative href", () => {
    expect(absoluteUrl("//evil.example/steal", ORIGIN)).toBeNull();
  });

  // Callers hand this function copy hrefs, which are app routes by contract.
  // Accepting an absolute URL would make "the link in a Giya email" something
  // any future caller could point anywhere.
  it("refuses an already-absolute href", () => {
    expect(absoluteUrl("https://evil.example", ORIGIN)).toBeNull();
  });

  it("returns null with no origin rather than a relative link", () => {
    expect(absoluteUrl("/scan", null)).toBeNull();
  });
});

describe("renderEmail", () => {
  it("uses the copy's title as the subject and as the one heading", () => {
    const rendered = renderEmail({ copy: REJECTION, origin: ORIGIN });
    expect(rendered.subject).toBe(REJECTION.title);
    expect(rendered.html).toContain(`<title>${REJECTION.title}</title>`);
    expect((rendered.html.match(/<h1/g) ?? []).length).toBe(1);
    expect(rendered.html).toContain(`>${REJECTION.title}</h1>`);
  });

  it("declares a language so a screen reader does not guess one", () => {
    expect(renderEmail({ copy: REJECTION, origin: ORIGIN }).html).toContain('<html lang="en">');
  });

  it("renders the action as a link whose text says where it goes", () => {
    const { html } = renderEmail({ copy: REJECTION, origin: ORIGIN });
    expect(html).toContain('<a href="https://giya.example/scan">Take another photo</a>');
    expect(html).not.toContain("click here");
  });

  // A button that goes nowhere is worse than a message that simply says what
  // happened, and a relative href in an email is exactly that.
  it("drops the action entirely when there is no origin to resolve it against", () => {
    const { html, text } = renderEmail({ copy: REJECTION, origin: null });
    expect(html).not.toContain("<a href");
    expect(text).not.toContain("Take another photo");
    // and the message still says the thing it was sent to say
    expect(text).toContain(REJECTION.body);
  });

  it("renders a message with no action at all", () => {
    const { html, text } = renderEmail({
      copy: { title: "Receipt received", body: "We have your photo." },
      origin: ORIGIN,
    });
    expect(html).not.toContain("<a href");
    expect(text).toContain("Receipt received");
  });

  // THE INJECTION TEST. A shop named `<img onerror=...>` reaches this module
  // through the notification body.
  it("escapes a hostile business name carried in the body", () => {
    const { html } = renderEmail({
      copy: {
        title: "Points added",
        body: `120 points are now in your <img src=x onerror="alert(1)"> wallet.`,
      },
      origin: ORIGIN,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes a hostile title and signature too", () => {
    const { html } = renderEmail({
      copy: { title: "</title><script>x</script>", body: "ok" },
      origin: ORIGIN,
      businessName: "<b>Shouty</b> Cafe",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Shouty</b>");
  });

  it("names the sending shop in the signature when there is one", () => {
    const { text } = renderEmail({
      copy: REJECTION,
      origin: ORIGIN,
      businessName: "Kape Diaria",
    });
    expect(text).toContain("Kape Diaria, through Giya");
  });

  it("signs as the platform when there is no shop", () => {
    expect(renderEmail({ copy: REJECTION, origin: ORIGIN, businessName: null }).text).toContain(
      "Giya",
    );
  });

  // The plain-text part is a complete message, not a stripped one: some clients
  // prefer it and some readers do.
  it("produces a plain-text part carrying the title, the body and the link", () => {
    const { text } = renderEmail({ copy: REJECTION, origin: ORIGIN });
    expect(text).toContain(REJECTION.title);
    expect(text).toContain(REJECTION.body);
    expect(text).toContain("Take another photo: https://giya.example/scan");
    // and none of the HTML leaks into it
    expect(text).not.toContain("<");
  });

  // The preheader is what a mail client shows beside the subject in the list.
  // It is the body's own first sentence rather than an invention, so the
  // preview never says something the message does not.
  it("hides a preheader drawn from the body's first sentence", () => {
    const { html } = renderEmail({
      copy: { title: "T", body: "First sentence. Second sentence." },
      origin: ORIGIN,
    });
    expect(html).toContain("display:none");
    expect(html).toContain("First sentence.");
  });

  // No colours at all: MD3 tokens are CSS custom properties that email clients
  // do not support, and a hardcoded palette would be a second, unmaintained one
  // that cannot follow the reader's light or dark mode.
  it("sets no colours, so the reader's own client decides them", () => {
    const { html } = renderEmail({ copy: REJECTION, origin: ORIGIN });
    expect(html).not.toMatch(/color\s*:/i);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  // An image is a blocked-by-default request to a third party, and this message
  // must read identically whether or not images load.
  it("embeds no images and no external requests", () => {
    const { html } = renderEmail({ copy: REJECTION, origin: ORIGIN });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
  });
});

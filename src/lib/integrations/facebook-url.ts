// Which URLs we will ask Meta to embed. Pure and client-safe.
//
// The URL is merchant-supplied (businesses.socials.facebook), so it is checked
// by PARSED hostname against an exact allowlist, never by `includes` or
// `endsWith("facebook.com")` - both accept `facebook.com.evil.com` or
// `evilfacebook.com`. Userinfo and non-default ports are refused too: neither
// has a legitimate use in a Page link, and both are classic disguises.

const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "web.facebook.com",
  "m.facebook.com",
  "fb.com",
  "www.fb.com",
]);

/** The normalized href of an https Facebook URL, or null for anything else. */
export function toFacebookPageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  // URL lowercases the hostname, so `WWW.FACEBOOK.COM` already matches here.
  if (!FACEBOOK_HOSTS.has(url.hostname)) return null;

  return url.href;
}

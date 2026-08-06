// A readable name for a browser, from the string the browser sends about
// itself.
//
// WHY THIS EXISTS AT ALL. /profile/devices asks somebody to decide whether to
// remove a device. Printing the raw `user_agent` at them - 120 characters of
// version numbers, three rendering-engine names and a claim to be Mozilla -
// does not help them make that decision, and two of their own devices would
// look the same at a glance. This turns the string into the two facts that
// distinguish devices for a person: what they were browsing with, and what they
// were browsing on.
//
// DELIBERATELY COARSE, AND DELIBERATELY VERSIONLESS. No version numbers reach
// the summary: "Chrome 126.0.6478.127 on Windows NT 10.0" is not more
// recognisable than "Chrome on Windows", it just changes every few weeks, so a
// device somebody has not signed in on for a month would read as a different
// device from the one they remember.
//
// THE ORDER OF THE CHECKS IS THE WHOLE ALGORITHM. Browser user agents are a
// pile of compatibility lies:
//
//   * Edge's UA contains BOTH `Chrome/126` and `Edg/126`.
//   * Samsung Internet's contains BOTH `Chrome/115` and `SamsungBrowser/23`.
//   * Chrome on iOS says `CriOS`, and Firefox on iOS says `FxiOS`, and both
//     also say `Safari`.
//   * Every iOS user agent contains the literal text `like Mac OS X`.
//   * Every Android user agent contains `Linux`.
//
// So the specific token is always tested BEFORE the general one it hides
// behind. Getting this backwards does not throw; it silently labels every Edge
// device "Chrome" and every iPhone "macOS", which is the failure mode that
// makes a device list useless.

/** Browser tokens, most specific first. Order is load-bearing - see header. */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg[A-Z]?\//, "Edge"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

/** Platform tokens, most specific first. Order is load-bearing - see header. */
const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux|X11/, "Linux"],
];

function firstMatch(
  table: readonly (readonly [RegExp, string])[],
  userAgent: string,
): string | null {
  for (const [pattern, name] of table) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}

/**
 * "Chrome on Windows", "Safari on iPhone", "Unknown device".
 *
 * The return value is always drawn from the fixed vocabulary above - never a
 * substring of the input - so nothing a client can put in a header reaches the
 * screen. That matters beyond tidiness: `user_agent` is attacker-controlled
 * text, and a device list is a place somebody else's header would be rendered.
 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  const browser = firstMatch(BROWSERS, userAgent);
  const platform = firstMatch(PLATFORMS, userAgent);

  if (browser !== null && platform !== null) return `${browser} on ${platform}`;
  if (browser !== null) return browser;
  // Naming the platform alone still tells somebody which of their machines this
  // is, which is the decision the list exists to support.
  if (platform !== null) return `A browser on ${platform}`;
  return "Unknown device";
}

import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminError from "@/app/(admin)/admin/error";
import AuthError from "@/app/(auth)/error";
import PortalError from "@/app/(business)/business/(portal)/error";
import BusinessError from "@/app/(business)/business/error";
import ConsumerError from "@/app/(consumer)/error";
import MarketingError from "@/app/(marketing)/error";
import GlobalError from "@/app/global-error";

// Every route group has its own shell, so each boundary must send people back
// to THAT group's home - a business owner bounced to /home would land in the
// consumer app.

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const cases = [
  ["consumer", ConsumerError, "/home"],
  ["business portal", PortalError, "/business/dashboard"],
  // Outer boundary catches a throwing (portal)/layout.tsx; it must NOT link to
  // the dashboard, which sits behind that same layout.
  ["business (outer)", BusinessError, "/business/login"],
  ["admin", AdminError, "/admin"],
  ["auth", AuthError, "/login"],
  ["marketing", MarketingError, "/"],
] as const;

describe.each(cases)("%s error boundary", (_name, Boundary, href) => {
  it(`links home to ${href}, retries, and hides the message`, () => {
    const reset = vi.fn();
    render(<Boundary error={new Error("boom")} reset={reset} />);
    const links = screen.getAllByRole("link");
    expect(links.some((l) => l.getAttribute("href") === href)).toBe(true);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });
});

describe("global error boundary", () => {
  it("renders its own document, offers retry, and hides the message", () => {
    // Static markup: a DOM container cannot hold a nested <html>/<body>.
    const html = renderToStaticMarkup(
      <GlobalError error={Object.assign(new Error("boom"), { digest: "d1" })} reset={() => {}} />,
    );
    expect(html).toMatch(/^<html[^>]*>(<head><\/head>)?<body/);
    expect(html).toContain("Try again");
    expect(html).toContain("Reference: d1");
    expect(html).not.toContain("boom");
  });
});

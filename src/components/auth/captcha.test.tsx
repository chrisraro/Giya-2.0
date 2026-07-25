import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";

const themeState = vi.hoisted(() => ({ resolvedTheme: "light" as string | undefined }));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: themeState.resolvedTheme, setTheme: vi.fn() }),
}));

interface MockHCaptchaProps {
  sitekey: string;
  theme?: string;
  onVerify?: (token: string) => void;
}

vi.mock("@hcaptcha/react-hcaptcha", () => {
  const HCaptchaMock = React.forwardRef<{ resetCaptcha: () => void }, MockHCaptchaProps>(
    function HCaptchaMock({ sitekey, theme, onVerify }, ref) {
      React.useImperativeHandle(ref, () => ({ resetCaptcha: vi.fn() }));
      return (
        <div data-testid="hcaptcha-widget" data-sitekey={sitekey} data-theme={theme}>
          <button type="button" onClick={() => onVerify?.("mock-token")}>
            Verify captcha
          </button>
        </div>
      );
    },
  );
  return { default: HCaptchaMock };
});

const envState = vi.hoisted(() => ({ key: undefined as string | undefined }));

vi.mock("@/lib/env", () => ({
  env: {
    get NEXT_PUBLIC_HCAPTCHA_SITE_KEY() {
      return envState.key;
    },
  },
}));

describe("Captcha", () => {
  beforeEach(() => {
    themeState.resolvedTheme = "light";
  });

  it("renders null when NEXT_PUBLIC_HCAPTCHA_SITE_KEY is unset", async () => {
    vi.resetModules();
    envState.key = undefined;
    const { Captcha, CAPTCHA_ENABLED } = await import("./captcha");

    expect(CAPTCHA_ENABLED).toBe(false);
    const { container } = render(<Captcha onVerify={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the widget when NEXT_PUBLIC_HCAPTCHA_SITE_KEY is set", async () => {
    vi.resetModules();
    envState.key = "test-site-key";
    const { Captcha, CAPTCHA_ENABLED } = await import("./captcha");

    expect(CAPTCHA_ENABLED).toBe(true);
    render(<Captcha onVerify={() => {}} />);

    const widget = screen.getByTestId("hcaptcha-widget");
    expect(widget).toBeInTheDocument();
    expect(widget).toHaveAttribute("data-sitekey", "test-site-key");
  });

  it("passes the dark theme through to the widget when resolvedTheme is dark", async () => {
    vi.resetModules();
    envState.key = "test-site-key";
    themeState.resolvedTheme = "dark";
    const { Captcha } = await import("./captcha");

    render(<Captcha onVerify={() => {}} />);

    expect(screen.getByTestId("hcaptcha-widget")).toHaveAttribute("data-theme", "dark");
  });

  it("calls onVerify with the token from the widget", async () => {
    vi.resetModules();
    envState.key = "test-site-key";
    const { Captcha } = await import("./captcha");
    const onVerify = vi.fn();

    render(<Captcha onVerify={onVerify} />);
    screen.getByRole("button", { name: "Verify captcha" }).click();

    expect(onVerify).toHaveBeenCalledWith("mock-token");
  });
});

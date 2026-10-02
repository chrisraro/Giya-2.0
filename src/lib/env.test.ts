import { afterEach, describe, expect, it, vi } from "vitest";

describe("env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws a readable error listing missing keys when env vars are absent", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    await expect(import("./env")).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    await expect(import("./env")).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it("throws when the URL is not a valid URL", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-url");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");

    await expect(import("./env")).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws when the anon key is too short", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "short");

    await expect(import("./env")).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it("parses and exports env when both vars are valid", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");

    const { env } = await import("./env");

    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://example.supabase.co");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("sb_publishable_abcdefghijklmnopqrstuvwxyz");
  });

  it("parses with NEXT_PUBLIC_HCAPTCHA_SITE_KEY unset (optional)", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("NEXT_PUBLIC_HCAPTCHA_SITE_KEY", undefined);

    const { env } = await import("./env");

    expect(env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY).toBeUndefined();
  });

  it("parses and exports NEXT_PUBLIC_HCAPTCHA_SITE_KEY when set", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("NEXT_PUBLIC_HCAPTCHA_SITE_KEY", "10000000-ffff-ffff-ffff-000000000001");

    const { env } = await import("./env");

    expect(env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY).toBe("10000000-ffff-ffff-ffff-000000000001");
  });
});

describe("getServerEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function stubClientEnv() {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
  }

  function stubRequiredServerEnv() {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("REDEMPTION_TOKEN_SECRET", "a".repeat(32));
  }

  it("is not evaluated at module scope (importing it does not throw even with no server env set)", async () => {
    vi.resetModules();
    stubClientEnv();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("REDEMPTION_TOKEN_SECRET", "");

    await expect(import("./env")).resolves.toBeDefined();
  });

  it("throws a readable error listing missing/invalid keys", async () => {
    vi.resetModules();
    stubClientEnv();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("REDEMPTION_TOKEN_SECRET", "");

    const { getServerEnv } = await import("./env");

    expect(() => getServerEnv()).toThrow(/UPSTASH_REDIS_REST_URL/);
    expect(() => getServerEnv()).toThrow(/UPSTASH_REDIS_REST_TOKEN/);
    expect(() => getServerEnv()).toThrow(/REDEMPTION_TOKEN_SECRET/);
  });

  it("throws when the token is too short", async () => {
    vi.resetModules();
    stubClientEnv();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "short");
    vi.stubEnv("REDEMPTION_TOKEN_SECRET", "a".repeat(32));

    const { getServerEnv } = await import("./env");

    expect(() => getServerEnv()).toThrow(/UPSTASH_REDIS_REST_TOKEN/);
  });

  it("throws when the redemption secret is too short", async () => {
    vi.resetModules();
    stubClientEnv();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("REDEMPTION_TOKEN_SECRET", "short");

    const { getServerEnv } = await import("./env");

    expect(() => getServerEnv()).toThrow(/REDEMPTION_TOKEN_SECRET/);
  });

  it("parses and returns the server env when all vars are valid", async () => {
    vi.resetModules();
    stubClientEnv();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("REDEMPTION_TOKEN_SECRET", "a".repeat(32));

    const { getServerEnv } = await import("./env");
    const result = getServerEnv();

    expect(result.UPSTASH_REDIS_REST_URL).toBe("https://example.upstash.io");
    expect(result.UPSTASH_REDIS_REST_TOKEN).toBe("a".repeat(20));
    expect(result.REDEMPTION_TOKEN_SECRET).toBe("a".repeat(32));
  });

  it("parses with OCR_SERVICE_URL / OCR_SERVICE_TOKEN unset (optional, stub provider path)", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("OCR_SERVICE_URL", undefined);
    vi.stubEnv("OCR_SERVICE_TOKEN", undefined);

    const { getServerEnv } = await import("./env");
    const result = getServerEnv();

    expect(result.OCR_SERVICE_URL).toBeUndefined();
    expect(result.OCR_SERVICE_TOKEN).toBeUndefined();
  });

  it("reads a blank OCR_SERVICE_URL as absent rather than as an invalid URL", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("OCR_SERVICE_URL", "   ");

    const { getServerEnv } = await import("./env");

    expect(getServerEnv().OCR_SERVICE_URL).toBeUndefined();
  });

  it("parses OCR_SERVICE_URL / OCR_SERVICE_TOKEN when both are set", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("OCR_SERVICE_URL", "https://ocr.example.dev");
    vi.stubEnv("OCR_SERVICE_TOKEN", "ocr-token-value");

    const { getServerEnv } = await import("./env");
    const result = getServerEnv();

    expect(result.OCR_SERVICE_URL).toBe("https://ocr.example.dev");
    expect(result.OCR_SERVICE_TOKEN).toBe("ocr-token-value");
  });

  it("degrades an OCR_SERVICE_URL that is not a URL to undefined with a warning, without throwing", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("OCR_SERVICE_URL", "ocr.example.dev");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { getServerEnv } = await import("./env");

    expect(getServerEnv().OCR_SERVICE_URL).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("OCR_SERVICE_URL");
    warn.mockRestore();
  });

  it("parses with SUPABASE_SERVICE_ROLE_KEY unset (optional until credentials land)", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);

    const { getServerEnv } = await import("./env");

    expect(getServerEnv().SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("parses with METRICS_TOKEN unset (optional; the route itself answers 404)", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("METRICS_TOKEN", undefined);

    const { getServerEnv } = await import("./env");

    expect(getServerEnv().METRICS_TOKEN).toBeUndefined();
  });

  it("reads a blank METRICS_TOKEN as absent rather than as an invalid value", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("METRICS_TOKEN", "   ");

    const { getServerEnv } = await import("./env");

    expect(getServerEnv().METRICS_TOKEN).toBeUndefined();
  });

  it("parses METRICS_TOKEN when set", async () => {
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("METRICS_TOKEN", "a".repeat(24));

    const { getServerEnv } = await import("./env");

    expect(getServerEnv().METRICS_TOKEN).toBe("a".repeat(24));
  });

  it("does NOT reject a short METRICS_TOKEN - the strength floor lives in the route, not this schema", async () => {
    // I1: a `.min()` here would make getServerEnv() throw for a truncated
    // METRICS_TOKEN, and getServerEnv() is called by unrelated code
    // (src/lib/redis.ts, src/lib/queue/publish.ts,
    // src/features/rewards/server/token.ts) that has nothing to do with
    // metrics. readMetricsToken() in
    // src/app/api/internal/metrics/route.ts.test.ts pins the actual floor.
    vi.resetModules();
    stubClientEnv();
    stubRequiredServerEnv();
    vi.stubEnv("METRICS_TOKEN", "short");

    const { getServerEnv } = await import("./env");

    expect(() => getServerEnv()).not.toThrow();
    expect(getServerEnv().METRICS_TOKEN).toBe("short");
  });

  it("memoizes: a second call returns the same object without re-parsing", async () => {
    vi.resetModules();
    stubClientEnv();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("REDEMPTION_TOKEN_SECRET", "a".repeat(32));

    const { getServerEnv } = await import("./env");
    const first = getServerEnv();

    // Mutate process.env after the first call; memoization means the second
    // call must NOT re-parse and must return the exact same object.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://changed.upstash.io");
    const second = getServerEnv();

    expect(second).toBe(first);
    expect(second.UPSTASH_REDIS_REST_URL).toBe("https://example.upstash.io");
  });

  describe("optional keys validate independently", () => {
    it("an invalid optional key goes undefined, warns once naming the key and never its value, and other keys stay intact", async () => {
      vi.resetModules();
      stubClientEnv();
      stubRequiredServerEnv();
      vi.stubEnv("GROQ_API_KEY", "truncated-secret"); // < 20 chars
      vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
      vi.stubEnv("HF_TOKEN", "hf_valid");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { getServerEnv } = await import("./env");
      const result = getServerEnv();

      expect(result.GROQ_API_KEY).toBeUndefined();
      expect(result.QSTASH_URL).toBe("https://qstash-us-east-1.upstash.io");
      expect(result.HF_TOKEN).toBe("hf_valid");
      expect(result.UPSTASH_REDIS_REST_URL).toBe("https://example.upstash.io");
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.map((c) => c.map(String).join(" ")).join("; ");
      expect(logged).toContain("GROQ_API_KEY");
      expect(logged).not.toContain("truncated-secret");
      warn.mockRestore();
    });

    it("warns once per bad key, and only once across memoized calls", async () => {
      vi.resetModules();
      stubClientEnv();
      stubRequiredServerEnv();
      vi.stubEnv("GROQ_API_KEY", "short");
      vi.stubEnv("QSTASH_URL", "not a url");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { getServerEnv } = await import("./env");
      getServerEnv();
      getServerEnv();

      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it("does not warn when every optional key is valid or absent", async () => {
      vi.resetModules();
      stubClientEnv();
      stubRequiredServerEnv();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { getServerEnv } = await import("./env");
      getServerEnv();

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("still throws for a required key even when an optional key is also invalid", async () => {
      vi.resetModules();
      stubClientEnv();
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
      vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "short");
      vi.stubEnv("REDEMPTION_TOKEN_SECRET", "a".repeat(32));
      vi.stubEnv("GROQ_API_KEY", "short");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { getServerEnv } = await import("./env");

      expect(() => getServerEnv()).toThrow(/UPSTASH_REDIS_REST_TOKEN/);
      expect(() => getServerEnv()).not.toThrow(/GROQ_API_KEY/);
      warn.mockRestore();
    });
  });
});

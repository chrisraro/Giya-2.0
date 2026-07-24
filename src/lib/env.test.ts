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
});

// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  getServerEnv: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: mocks.getServerEnv }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mocks.sendEmail }));

const { sendStaffInviteEmail, resolveOrigin } = await import("./notify");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerEnv.mockReturnValue({ APP_ORIGIN: "https://giya.example" });
  mocks.sendEmail.mockResolvedValue({ ok: true, id: "email-1" });
});

describe("resolveOrigin", () => {
  it("reads APP_ORIGIN", () => {
    expect(resolveOrigin()).toBe("https://giya.example");
  });

  it("falls back to QSTASH_CALLBACK_ORIGIN when APP_ORIGIN is unset", () => {
    mocks.getServerEnv.mockReturnValue({ QSTASH_CALLBACK_ORIGIN: "https://cb.example" });
    expect(resolveOrigin()).toBe("https://cb.example");
  });

  it("returns null rather than throwing when getServerEnv throws", () => {
    mocks.getServerEnv.mockImplementation(() => {
      throw new Error("missing env");
    });
    expect(resolveOrigin()).toBeNull();
  });
});

describe("sendStaffInviteEmail", () => {
  it("addresses the email to the literal invited address, not a resolved account", async () => {
    // Mutant: sending to some other field (e.g. a business email) instead of
    // `input.to` would still "send an email" and pass a truthiness check.
    await sendStaffInviteEmail({
      to: "invitee@example.com",
      businessName: "Kape Diaria",
      role: "manager",
      token: "tok_abc123",
      newAccountSetupLink: null,
    });

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "invitee@example.com" }),
    );
  });

  it("links to this app's own /invite/[token] route, made absolute against the origin", async () => {
    // Mutant: hardcoding a different path, or leaving the link relative, would
    // still call sendEmail with SOME html/text but the link inside would be
    // wrong or dead in a mail client.
    await sendStaffInviteEmail({
      to: "invitee@example.com",
      businessName: "Kape Diaria",
      role: "staff",
      token: "tok_abc123",
      newAccountSetupLink: null,
    });

    const call = mocks.sendEmail.mock.calls[0]?.[0];
    expect(call.html).toContain("https://giya.example/invite/tok_abc123");
    expect(call.text).toContain("https://giya.example/invite/tok_abc123");
  });

  it("names the inviting business and the role in the message", async () => {
    await sendStaffInviteEmail({
      to: "invitee@example.com",
      businessName: "Kape Diaria",
      role: "marketing",
      token: "tok_abc123",
      newAccountSetupLink: null,
    });

    const call = mocks.sendEmail.mock.calls[0]?.[0];
    expect(call.subject).toContain("Kape Diaria");
    expect(call.text).toContain("marketing");
  });

  it("includes the real setup link for a brand-new invitee, and omits it entirely otherwise", async () => {
    // Mutant: always emitting the same body regardless of newAccountSetupLink
    // (or emitting the "no account yet" copy without the actual clickable
    // URL) would leave half the recipients with no way to act on the email at
    // all - a courtesy line with no link behind it.
    await sendStaffInviteEmail({
      to: "invitee@example.com",
      businessName: "Kape Diaria",
      role: "staff",
      token: "tok_abc123",
      newAccountSetupLink: "https://giya.example/auth/confirm?x=1",
    });
    const noAccountCall = mocks.sendEmail.mock.calls[0]?.[0];
    expect(noAccountCall.text).toMatch(/no Giya account yet/i);
    expect(noAccountCall.text).toContain("https://giya.example/auth/confirm?x=1");

    mocks.sendEmail.mockClear();
    await sendStaffInviteEmail({
      to: "invitee@example.com",
      businessName: "Kape Diaria",
      role: "staff",
      token: "tok_abc123",
      newAccountSetupLink: null,
    });
    const existingAccountCall = mocks.sendEmail.mock.calls[0]?.[0];
    expect(existingAccountCall.text).not.toMatch(/no Giya account yet/i);
    expect(existingAccountCall.text).not.toContain("auth/confirm");
  });

  it("never throws when the send fails - it is a best-effort courtesy, not the source of truth", async () => {
    // Mutant: letting a rejection propagate would take down the invite action
    // that awaits this, even though the business_staff row already committed.
    mocks.sendEmail.mockResolvedValue({ ok: false, retryable: false, reason: "resend 422" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendStaffInviteEmail({
        to: "invitee@example.com",
        businessName: "Kape Diaria",
        role: "staff",
        token: "tok_abc123",
        newAccountSetupLink: null,
      }),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

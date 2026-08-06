import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GENERIC_FAILURE } from "../messages";

// The revoke control, and the copy around it.
//
// THE COPY IS PART OF THE FEATURE, NOT DECORATION. Deleting a `user_devices`
// row does NOT invalidate that browser's Supabase session - the refresh token
// lives in GoTrue, not in this table - so a screen that said "signed out
// everywhere" here would be stating a control the product does not have. That
// exact failure was a Critical on T3.2, where /suspended told people they could
// not redeem while redemption was ungated. These tests pin the honest wording
// as hard as they pin the behaviour.

const mocks = vi.hoisted(() => ({
  revokeDevice: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace, push: vi.fn() }),
}));

vi.mock("../actions", () => ({
  revokeDevice: mocks.revokeDevice,
}));

const { DeviceList } = await import("./device-list");

const DEVICES = [
  { id: "device-1", summary: "Chrome on Windows", lastSeen: "1 hour ago", isCurrent: true },
  { id: "device-2", summary: "Safari on iPhone", lastSeen: "2 days ago", isCurrent: false },
];

function renderList(devices = DEVICES) {
  return render(<DeviceList devices={devices} />);
}

/** The remove control on the row whose summary is given. */
function removeButtonFor(summary: string): HTMLElement {
  const row = screen.getByText(summary).closest("li");
  if (row === null) throw new Error(`no row for ${summary}`);
  const button = row.querySelector("button");
  if (button === null) throw new Error(`no remove control on the row for ${summary}`);
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revokeDevice.mockResolvedValue({ ok: true, signedOut: false });
});

describe("what a device row shows", () => {
  it("names the browser and platform in words a person recognises", async () => {
    renderList();

    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
  });

  it("says when it was last used", async () => {
    renderList();

    expect(screen.getByText(/1 hour ago/)).toBeInTheDocument();
    expect(screen.getByText(/2 days ago/)).toBeInTheDocument();
  });

  it("CRITICAL: marks the device the consumer is holding", async () => {
    // Without this, removing the current device is a surprise.
    renderList();

    const currentRow = screen.getByText("Chrome on Windows").closest("li");
    expect(currentRow?.textContent).toMatch(/This device/i);

    const otherRow = screen.getByText("Safari on iPhone").closest("li");
    expect(otherRow?.textContent).not.toMatch(/This device/i);
  });

  it("gives every row its own remove control, named for the device it removes", async () => {
    // "Remove" four times over is unusable with a screen reader.
    renderList();

    expect(removeButtonFor("Safari on iPhone")).toHaveAccessibleName(/Safari on iPhone/);
    expect(removeButtonFor("Chrome on Windows")).toHaveAccessibleName(/Chrome on Windows/);
  });

  it("CRITICAL: warns on the current row that removing it ends this session", async () => {
    renderList();

    expect(removeButtonFor("Chrome on Windows")).toHaveAccessibleName(/sign(s)? you out/i);
    expect(removeButtonFor("Safari on iPhone")).not.toHaveAccessibleName(/sign(s)? you out/i);
  });
});

describe("the honesty of the copy", () => {
  it("CRITICAL: never claims removing a device signs that browser out", async () => {
    // The refresh token is in GoTrue, not in user_devices. Claiming otherwise
    // is stating a control the product does not have.
    const { container } = renderList();

    expect(container.textContent).not.toMatch(/signed out everywhere/i);
    expect(container.textContent).not.toMatch(/log(s|ged)? out everywhere/i);
    // The lookbehind matters: the screen is REQUIRED to say "does not sign that
    // browser out" (asserted below). What must never appear is the same claim
    // made positively.
    expect(container.textContent).not.toMatch(/(?<!does not )signs? that (browser|device) out/i);
  });

  it("CRITICAL: says plainly what removing another device does NOT do", async () => {
    // Silence would be as misleading as a false claim: somebody removing a
    // device they do not recognise needs to know they are not done.
    const { container } = renderList();

    expect(container.textContent).toMatch(/does not sign that browser out/i);
  });

  it("points somewhere real for the case that brought them here", async () => {
    // "Someone else has my account" is the reason people open this screen. The
    // control that actually helps is a password change.
    renderList();

    expect(screen.getByRole("link", { name: /password/i })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });
});

describe("removing another device", () => {
  it("CRITICAL: revokes the row that was tapped, not the first one", async () => {
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    await waitFor(() => expect(mocks.revokeDevice).toHaveBeenCalledWith("device-2"));
  });

  it("takes the row off the list once it is gone", async () => {
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    await waitFor(() => {
      expect(screen.queryByText("Safari on iPhone")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
  });

  it("CRITICAL: does not navigate the consumer anywhere", async () => {
    // Removing somebody else's device must not end the session of the person
    // doing the removing.
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    await waitFor(() => expect(mocks.revokeDevice).toHaveBeenCalled());
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("shows the empty state's job to the page by removing the last row", async () => {
    renderList([DEVICES[1] as (typeof DEVICES)[number]]);

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    await waitFor(() => expect(screen.queryByRole("listitem")).not.toBeInTheDocument());
  });
});

describe("removing the device you are holding", () => {
  it("CRITICAL: sends the consumer to /login when the session really ended", async () => {
    // The action signs them out for real in this case. Leaving them on a device
    // list they are no longer entitled to would render an empty or broken page.
    mocks.revokeDevice.mockResolvedValue({ ok: true, signedOut: true });
    renderList();

    fireEvent.click(removeButtonFor("Chrome on Windows"));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
  });

  it("does not send anybody to /login when no session ended", async () => {
    mocks.revokeDevice.mockResolvedValue({ ok: true, signedOut: false });
    renderList();

    fireEvent.click(removeButtonFor("Chrome on Windows"));

    await waitFor(() => expect(mocks.revokeDevice).toHaveBeenCalled());
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

describe("a revoke that fails", () => {
  it("CRITICAL: keeps the row on the list rather than pretending it went", async () => {
    mocks.revokeDevice.mockResolvedValue({ ok: false, message: "Nope." });
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    await screen.findByRole("alert");
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
  });

  it("shows the specific message the action returned", async () => {
    mocks.revokeDevice.mockResolvedValue({ ok: false, message: "We could not remove that device." });
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not remove that device.");
  });

  it("CRITICAL: an empty-string message renders the generic copy, not a blank alert", async () => {
    // `message ?? FALLBACK` does not catch "": falsy but not nullish.
    mocks.revokeDevice.mockResolvedValue({ ok: false, message: "" });
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(alert).toHaveTextContent(GENERIC_FAILURE);
  });

  it("CRITICAL: a THROWN action still says something and keeps the row", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.revokeDevice.mockRejectedValue(new Error("Failed to fetch"));
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("Failed to fetch");
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("CRITICAL: lets the same row be retried after a failure", async () => {
    // The busy flag has to be cleared in `finally`. A throw that skipped it left
    // a dead control with nothing written on it - a live defect on the edit form.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.revokeDevice.mockRejectedValueOnce(new Error("Failed to fetch"));
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));
    await screen.findByRole("alert");

    mocks.revokeDevice.mockResolvedValue({ ok: true, signedOut: false });
    fireEvent.click(removeButtonFor("Safari on iPhone"));

    await waitFor(() => expect(screen.queryByText("Safari on iPhone")).not.toBeInTheDocument());
    consoleError.mockRestore();
  });

  it("ignores a second tap on the same row while its revoke is in flight", async () => {
    let release: (value: { ok: true; signedOut: boolean }) => void = () => {};
    mocks.revokeDevice.mockReturnValue(
      new Promise<{ ok: true; signedOut: boolean }>((resolve) => {
        release = resolve;
      }),
    );
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));
    fireEvent.click(removeButtonFor("Safari on iPhone"));

    expect(mocks.revokeDevice).toHaveBeenCalledTimes(1);
    release({ ok: true, signedOut: false });
  });
});

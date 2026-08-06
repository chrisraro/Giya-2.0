import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_REMOVE_FAILED, GENERIC_FAILURE } from "../messages";

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

/**
 * What a SIGHTED person reads on a control: its text with the visually hidden
 * parts taken out. `textContent` alone would count the `sr-only` span and let a
 * screen-reader-only warning pass as a visible one, which is the exact defect
 * these tests exist to catch.
 *
 * LIMIT, stated rather than hidden: hidden-ness is detected by CLASS NAME. That
 * is correct for this component under jsdom, which applies no CSS and where
 * `.sr-only` is the codebase's one hiding convention - but it is not a real
 * visibility check. Text hidden by `hidden`, `aria-hidden`, `display: none` in
 * an inline style, or a differently-named utility class would read as VISIBLE
 * here and could satisfy the visible-warning assertion while a sighted person
 * saw nothing. If another hiding mechanism ever appears in this component, this
 * helper has to learn about it; a genuine computed-style check is not available
 * in jsdom without a CSS engine.
 */
function visibleLabelOf(control: HTMLElement): string {
  const clone = control.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll(".sr-only")) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The remove control on the row whose summary is given. */
function removeButtonFor(summary: string): HTMLElement {
  const row = screen.getByText(summary).closest("li");
  if (row === null) throw new Error(`no row for ${summary}`);
  const button = row.querySelector("button");
  if (button === null) throw new Error(`no remove control on the row for ${summary}`);
  return button;
}

// THE CLAIM, NOT THE SENTENCE.
//
// The first version of this guard listed the exact phrasings the component
// happened to use, and a review broke it twice without turning a single test
// red: rewriting the current row's name to "This signs you out everywhere, on
// every device" matched none of them, and rewriting DEVICE_REMOVE_FAILED to
// "That device was signed out everywhere." matched none of them either. A guard
// that pins wording only fails for the mutation that keeps the wording.
//
// So this is a list of CLAIMS the product cannot keep, in whatever words. The
// one true claim on this screen - "signs you out HERE", about the current
// device - is not in it and must not be: deleting a row really does end THIS
// session, because revokeDevice calls auth.signOut() for it.
const OVERCLAIMS: readonly RegExp[] = [
  /everywhere/i,
  /every device/i,
  /all (of )?(your )?(other )?devices/i,
  /all (of )?(your )?(other )?sessions/i,
  /(?<!does not )signs? (that|the) (browser|device) out/i,
  /(?<!does not )logs? (that|the) (browser|device) out/i,
  /signs? (you )?out of (all|every)/i,
  /revokes? (all|every)/i,
];

function expectNoOverclaim(text: string): void {
  for (const claim of OVERCLAIMS) {
    expect(text).not.toMatch(claim);
  }
}

// AND THE ALLOWLIST, WHICH IS THE LAYER THAT ACTUALLY CLOSES THIS.
//
// The denylist above is incomplete by construction - a review proved it by
// writing three overclaims in wordings it does not enumerate ("also ends the
// session on that browser immediately", "and on your other browsers", "That
// browser has been logged off already") and all 343 tests stayed green. A
// denylist over prose can always be walked around.
//
// The prose on this screen is FIXED, not composed, so it can be pinned exactly.
// Any sentence added, removed or reworded fails these assertions - and that
// failure is the gate: it forces a person to read the new claim and decide
// whether the product can keep it before it ships. Same shape as this repo's
// SQL agreement tests, which pin the migration's own text rather than a pattern
// that might match it.
//
// The denylist stays underneath, for the parts that ARE composed: the device
// summaries, and any message an action returns at runtime.

/** The standing note under the list, exactly. */
const REMOVAL_NOTE =
  "Removing a device takes it off this list. " +
  "It does not sign that browser out on its own, so it stays signed in until its session " +
  "expires or somebody signs out on it. " +
  "Removing the device you are using now signs you out here. " +
  "If you think someone else is using your account, change your password.";

/** The sentence a failed revoke shows, exactly. */
const REMOVE_FAILED_SENTENCE = "We could not remove that device just now. Please try again.";

/** The two remove-button labels, exactly. */
const CURRENT_BUTTON_LABEL = "Remove and sign out";
const OTHER_BUTTON_LABEL = "Remove";

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
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

    expect(removeButtonFor("Chrome on Windows")).toHaveAccessibleName(/sign out/i);
    expect(removeButtonFor("Safari on iPhone")).not.toHaveAccessibleName(/sign out/i);
  });

  it("CRITICAL: the warning is VISIBLE, not only in the accessible name", async () => {
    // `aria-label` REPLACES the accessible name; it adds nothing to what a
    // sighted person reads. A button whose visible text says "Remove" and whose
    // hidden name says "this signs you out" warns exactly the users who were
    // not going to be surprised, and nobody else. `visibleLabelOf` strips the
    // sr-only span so this assertion cannot be satisfied by a hidden warning.
    renderList();

    expect(visibleLabelOf(removeButtonFor("Chrome on Windows"))).toMatch(/sign out/i);
    expect(visibleLabelOf(removeButtonFor("Safari on iPhone"))).not.toMatch(/sign out/i);
  });

  it("keeps the visible label inside the accessible name (WCAG 2.5.3)", async () => {
    // Voice-control users say what they see. If the accessible name does not
    // contain the visible words, "click remove and sign out" does nothing - and
    // an aria-label that REPLACES the label is the usual way that happens.
    renderList();

    for (const summary of ["Chrome on Windows", "Safari on iPhone"]) {
      const button = removeButtonFor(summary);
      const visible = visibleLabelOf(button);
      expect(visible.length).toBeGreaterThan(0);
      // Containment, not equality: the device name is appended for screen
      // readers, so the accessible name is a superset of the visible one.
      expect(button).toHaveAccessibleName(
        new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  });
});

describe("the honesty of the copy", () => {
  it("CRITICAL: makes no claim the product cannot keep, in any wording", async () => {
    // The refresh token is in GoTrue, not in user_devices. Removing a row for
    // ANOTHER device ends nothing.
    const { container } = renderList();

    expectNoOverclaim(container.textContent ?? "");
  });

  it("CRITICAL: the same holds when there is no current device on the list", async () => {
    // A different render path (no "This device" row at all) with the same rule.
    const { container } = renderList([DEVICES[1] as (typeof DEVICES)[number]]);

    expectNoOverclaim(container.textContent ?? "");
  });

  it("CRITICAL: the sentence a failed revoke really shows keeps no promise either", async () => {
    // DEVICE_REMOVE_FAILED is the one string a consumer sees when a revoke
    // fails, and until now nothing rendered it: this file supplied its own
    // fixture strings, and actions.test.ts compared the constant to itself, so
    // the constant could be rewritten to "That device was signed out
    // everywhere." with 333 tests still green. This test renders the REAL
    // constant and measures it against literals.
    mocks.revokeDevice.mockResolvedValue({ ok: false, message: DEVICE_REMOVE_FAILED });
    const { container } = renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(DEVICE_REMOVE_FAILED);
    // A literal, so the expected value does not come from the same place as the
    // actual one.
    expect(alert.textContent).toMatch(/could not remove that device/i);
    expectNoOverclaim(container.textContent ?? "");
  });

  it("CRITICAL: says plainly what removing another device does NOT do", async () => {
    // Silence would be as misleading as a false claim: somebody removing a
    // device they do not recognise needs to know they are not done.
    const { container } = renderList();

    expect(container.textContent).toMatch(/does not sign that browser out/i);
  });

  it("CRITICAL: the standing note is EXACTLY this, sentence for sentence", async () => {
    // The claim-complete assertion. A denylist cannot enumerate every way to
    // say "we ended that session"; an exact pin over fixed prose does not have
    // to - anything added or reworded fails here, and a person then has to read
    // it. All three sentences the review slipped past the denylist die on this
    // one line.
    const { container } = renderList();

    expect(normalize(container.querySelector("#device-removal-note")?.textContent)).toBe(
      REMOVAL_NOTE,
    );
  });

  it("CRITICAL: the failed-revoke sentence is EXACTLY this", async () => {
    mocks.revokeDevice.mockResolvedValue({ ok: false, message: DEVICE_REMOVE_FAILED });
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));

    expect(normalize((await screen.findByRole("alert")).textContent)).toBe(
      REMOVE_FAILED_SENTENCE,
    );
  });

  it("CRITICAL: the two remove-button labels are EXACTLY these", async () => {
    // The current row's label is the other piece of fixed prose that carries a
    // claim about what pressing it does.
    renderList();

    expect(visibleLabelOf(removeButtonFor("Chrome on Windows"))).toBe(CURRENT_BUTTON_LABEL);
    expect(visibleLabelOf(removeButtonFor("Safari on iPhone"))).toBe(OTHER_BUTTON_LABEL);
  });

  it("CRITICAL: qualifies that disclaimer for the one row it is false about", async () => {
    // "Removing does not sign that browser out" is true of every row EXCEPT the
    // current one, where revokeDevice calls auth.signOut() and the consumer is
    // signed out immediately. An unqualified disclaimer is T3.2's defect
    // inverted: there the product claimed a control it did not have, here it
    // would disclaim a consequence it does have, and the surprise lands on
    // somebody who just read that nothing would happen.
    const { container } = renderList();

    expect(container.textContent).toMatch(/device you are using now signs you out here/i);
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

  it("CRITICAL: the in-flight lock is PER ROW, not a lock on the whole list", async () => {
    // The comment on handleRemove claims exactly this ("a slow revoke on one
    // device has no business freezing the rest of the list"), and a global
    // `if (removing !== null) return` satisfies every other test in this file.
    // Two devices are two independent rows; one slow round trip must not make
    // the other unremovable.
    let release: (value: { ok: true; signedOut: boolean }) => void = () => {};
    mocks.revokeDevice.mockReturnValueOnce(
      new Promise<{ ok: true; signedOut: boolean }>((resolve) => {
        release = resolve;
      }),
    );
    renderList();

    fireEvent.click(removeButtonFor("Safari on iPhone"));
    fireEvent.click(removeButtonFor("Chrome on Windows"));

    await waitFor(() => expect(mocks.revokeDevice).toHaveBeenCalledTimes(2));
    expect(mocks.revokeDevice.mock.calls.map((call) => call[0])).toEqual(["device-2", "device-1"]);
    release({ ok: true, signedOut: false });
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

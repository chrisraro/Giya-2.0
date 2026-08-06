import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GENERIC_FAILURE } from "../messages";

// The four consents. `public.consumers` has carried marketing_opt_in,
// push_enabled, email_enabled and gps_fraud_opt_in since 0002 and 0021 granted
// `authenticated` UPDATE on all four with a header that says the reason - "the
// profile settings screen edits them". This is that screen; until now it did
// not exist and the columns had no UI at all.
//
// WHY THE COLUMN NAMES BELOW ARE WRITTEN OUT AS LITERALS.
//
// The four toggles are four instances of ONE mechanism. A test that flips a
// control and asserts "saveConsent was called" is green when all four are wired
// to the same column, and a test that imports the component's own row table to
// build its expected value cannot disagree with the component. So each
// assertion here spells the column out, and the action's own test spells the
// same four out against the update payload. Between them the chain
// label -> column -> UPDATE is pinned end to end.

const mocks = vi.hoisted(() => ({
  saveConsent: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));

vi.mock("../actions", () => ({
  saveConsent: mocks.saveConsent,
}));

const { ConsentSettings } = await import("./consent-settings");

/** Every consent off but the one named. Booleans cannot be told apart in a
 *  four-field fixture unless exactly one of them differs. */
function onlyOn(column: string) {
  return {
    marketing_opt_in: column === "marketing_opt_in",
    push_enabled: column === "push_enabled",
    email_enabled: column === "email_enabled",
    gps_fraud_opt_in: column === "gps_fraud_opt_in",
  };
}

const ALL_OFF = onlyOn("none");

const LABELS = {
  marketing_opt_in: "Marketing messages",
  push_enabled: "Push notifications",
  email_enabled: "Email notifications",
  gps_fraud_opt_in: "Share your location when you scan",
} as const;

function renderSettings(consents = ALL_OFF) {
  return render(<ConsentSettings consents={consents} />);
}

function toggle(label: string): HTMLElement {
  return screen.getByRole("switch", { name: label });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveConsent.mockResolvedValue({ ok: true });
});

describe("four separate controls", () => {
  it("CRITICAL: renders four switches, one per consent, each with its own label", async () => {
    // Not one bundled "notifications" switch and not a grouped opt-in: NPC
    // Circular 2023-04 requires consent to be specific and separate.
    renderSettings();

    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(toggle(LABELS.marketing_opt_in)).toBeInTheDocument();
    expect(toggle(LABELS.push_enabled)).toBeInTheDocument();
    expect(toggle(LABELS.email_enabled)).toBeInTheDocument();
    expect(toggle(LABELS.gps_fraud_opt_in)).toBeInTheDocument();
  });

  it("CRITICAL: keeps marketing structurally apart from the service toggles", async () => {
    // A marketing consent bundled with service notifications is not freely
    // given and separate. It gets its own labelled section.
    renderSettings();

    const marketingSection = toggle(LABELS.marketing_opt_in).closest("section");
    expect(marketingSection).not.toBeNull();
    expect(marketingSection).not.toContainElement(toggle(LABELS.push_enabled));
    expect(marketingSection).not.toContainElement(toggle(LABELS.email_enabled));
    expect(marketingSection).not.toContainElement(toggle(LABELS.gps_fraud_opt_in));
  });

  it("says plainly what the location consent does", async () => {
    // A consent nobody understands is not consent. The copy mirrors the privacy
    // page: no background tracking, GPS only at the moment of a scan.
    renderSettings();

    const section = toggle(LABELS.gps_fraud_opt_in).closest("section");
    expect(section?.textContent).toMatch(/never tracks you in the background/i);
    expect(section?.textContent).toMatch(/when you submit a receipt/i);
  });
});

describe("what the switches show", () => {
  it("CRITICAL: marketing renders un-ticked when the row says false", async () => {
    // The schema defaults it false and the UI must not undo that. A pre-ticked
    // marketing box is non-compliant, not a nicety.
    renderSettings(ALL_OFF);

    expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "false");
  });

  it("CRITICAL: a true marketing_opt_in ticks marketing and nothing else", async () => {
    renderSettings(onlyOn("marketing_opt_in"));

    expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "true");
    expect(toggle(LABELS.push_enabled)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.email_enabled)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.gps_fraud_opt_in)).toHaveAttribute("aria-checked", "false");
  });

  it("CRITICAL: a true push_enabled ticks push and nothing else", async () => {
    renderSettings(onlyOn("push_enabled"));

    expect(toggle(LABELS.push_enabled)).toHaveAttribute("aria-checked", "true");
    expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.email_enabled)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.gps_fraud_opt_in)).toHaveAttribute("aria-checked", "false");
  });

  it("CRITICAL: a true email_enabled ticks email and nothing else", async () => {
    renderSettings(onlyOn("email_enabled"));

    expect(toggle(LABELS.email_enabled)).toHaveAttribute("aria-checked", "true");
    expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.push_enabled)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.gps_fraud_opt_in)).toHaveAttribute("aria-checked", "false");
  });

  it("CRITICAL: a true gps_fraud_opt_in ticks location and nothing else", async () => {
    renderSettings(onlyOn("gps_fraud_opt_in"));

    expect(toggle(LABELS.gps_fraud_opt_in)).toHaveAttribute("aria-checked", "true");
    expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.push_enabled)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.email_enabled)).toHaveAttribute("aria-checked", "false");
  });
});

describe("which column each switch writes", () => {
  it("CRITICAL: flipping Marketing messages writes marketing_opt_in", async () => {
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));

    await waitFor(() => {
      expect(mocks.saveConsent).toHaveBeenCalledWith("marketing_opt_in", true);
    });
    expect(mocks.saveConsent).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: flipping Push notifications writes push_enabled", async () => {
    renderSettings(onlyOn("push_enabled"));

    fireEvent.click(toggle(LABELS.push_enabled));

    await waitFor(() => {
      expect(mocks.saveConsent).toHaveBeenCalledWith("push_enabled", false);
    });
    expect(mocks.saveConsent).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: flipping Email notifications writes email_enabled", async () => {
    renderSettings(onlyOn("email_enabled"));

    fireEvent.click(toggle(LABELS.email_enabled));

    await waitFor(() => {
      expect(mocks.saveConsent).toHaveBeenCalledWith("email_enabled", false);
    });
    expect(mocks.saveConsent).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: flipping the location switch writes gps_fraud_opt_in", async () => {
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.gps_fraud_opt_in));

    await waitFor(() => {
      expect(mocks.saveConsent).toHaveBeenCalledWith("gps_fraud_opt_in", true);
    });
    expect(mocks.saveConsent).toHaveBeenCalledTimes(1);
  });

  it("saves per toggle: flipping one does not write the other three", async () => {
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.push_enabled));

    await waitFor(() => expect(mocks.saveConsent).toHaveBeenCalledTimes(1));
    const written = mocks.saveConsent.mock.calls.map((call) => call[0]);
    expect(written).toEqual(["push_enabled"]);
  });
});

describe("a write that fails", () => {
  it("CRITICAL: reverts the control rather than leaving the UI lying", async () => {
    // The UI must never claim a state the database does not have.
    mocks.saveConsent.mockResolvedValue({ ok: false, message: "Nope." });
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));

    await waitFor(() => {
      expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "false");
    });
  });

  it("reverts a switch that was ON back to on", async () => {
    mocks.saveConsent.mockResolvedValue({ ok: false, message: "Nope." });
    renderSettings(onlyOn("push_enabled"));

    fireEvent.click(toggle(LABELS.push_enabled));

    await waitFor(() => {
      expect(toggle(LABELS.push_enabled)).toHaveAttribute("aria-checked", "true");
    });
  });

  it("shows the specific message the action returned", async () => {
    mocks.saveConsent.mockResolvedValue({ ok: false, message: "You need to be signed in to do that." });
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.email_enabled));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You need to be signed in to do that.",
    );
  });

  it("CRITICAL: an empty-string message renders the generic copy, not a blank alert", async () => {
    // `message ?? FALLBACK` does not catch "": it is falsy but not nullish, so
    // the alert renders an empty box. This regressed once already on this
    // branch. The length assertion is the one that cannot be satisfied by
    // agreeing with a constant.
    mocks.saveConsent.mockResolvedValue({ ok: false, message: "" });
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.email_enabled));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(alert).toHaveTextContent(GENERIC_FAILURE);
  });

  it("CRITICAL: a THROWN action reverts the control and still says something", async () => {
    // A server action can reject rather than return - a dropped connection, a
    // deploy mid-request. Before this was handled on the edit form the screen
    // sat there with nothing written on it.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.saveConsent.mockRejectedValue(new Error("Failed to fetch"));
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.gps_fraud_opt_in));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(toggle(LABELS.gps_fraud_opt_in)).toHaveAttribute("aria-checked", "false");
    consoleError.mockRestore();
  });

  it("CRITICAL: a thrown failure never renders the framework's own words", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.saveConsent.mockRejectedValue(new Error("ECONNRESET"));
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.push_enabled));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("ECONNRESET");
    // Lost from the screen, not from the log.
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("lets the same toggle be retried after a failure", async () => {
    mocks.saveConsent.mockResolvedValueOnce({ ok: false, message: "Nope." });
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));
    await waitFor(() =>
      expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "false"),
    );

    mocks.saveConsent.mockResolvedValue({ ok: true });
    fireEvent.click(toggle(LABELS.marketing_opt_in));

    await waitFor(() =>
      expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "true"),
    );
    expect(mocks.saveConsent).toHaveBeenCalledTimes(2);
  });

  it("CRITICAL: reverting one toggle does not undo a DIFFERENT one that succeeded", async () => {
    // The revert has to put back the value that column held a moment ago, not
    // the value the page was rendered with. Reverting to the initial props
    // would mean: turn marketing on (saved), then turn push off (fails), and
    // marketing silently springs back to off while the database holds `true` -
    // the UI claiming a state the database does not have, which is the exact
    // thing this component's header forbids. Nothing pinned it until now.
    mocks.saveConsent.mockResolvedValueOnce({ ok: true });
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));
    await waitFor(() =>
      expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "true"),
    );

    mocks.saveConsent.mockResolvedValue({ ok: false, message: "Nope." });
    fireEvent.click(toggle(LABELS.push_enabled));
    await screen.findByRole("alert");

    // The failed one is back where the database has it...
    expect(toggle(LABELS.push_enabled)).toHaveAttribute("aria-checked", "false");
    // ...and the successful one is untouched.
    expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "true");
    expect(toggle(LABELS.email_enabled)).toHaveAttribute("aria-checked", "false");
    expect(toggle(LABELS.gps_fraud_opt_in)).toHaveAttribute("aria-checked", "false");
  });

  it("clears a previous failure once a later save succeeds", async () => {
    mocks.saveConsent.mockResolvedValueOnce({ ok: false, message: "Nope." });
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));
    await screen.findByRole("alert");

    mocks.saveConsent.mockResolvedValue({ ok: true });
    fireEvent.click(toggle(LABELS.push_enabled));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("the optimistic flip", () => {
  it("moves the control immediately, before the write comes back", async () => {
    let release: (value: { ok: true }) => void = () => {};
    mocks.saveConsent.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));

    expect(toggle(LABELS.marketing_opt_in)).toHaveAttribute("aria-checked", "true");
    release({ ok: true });
  });

  it("CRITICAL: the in-flight lock is PER COLUMN, not a lock on the whole form", async () => {
    // handleToggle's comment claims exactly this ("Per COLUMN, not a global
    // busy flag: … a slow write on one has no business freezing the other
    // three"), and a global `if (saving !== null) return` passes every other
    // test in this file. The four consents are four independent decisions; one
    // slow round trip must not swallow a tap on another.
    let release: (value: { ok: true }) => void = () => {};
    mocks.saveConsent.mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));
    fireEvent.click(toggle(LABELS.email_enabled));

    await waitFor(() => expect(mocks.saveConsent).toHaveBeenCalledTimes(2));
    expect(mocks.saveConsent.mock.calls.map((call) => call[0])).toEqual([
      "marketing_opt_in",
      "email_enabled",
    ]);
    release({ ok: true });
  });

  it("CRITICAL: ignores a second tap on the SAME toggle while its write is in flight", async () => {
    // Two writes racing on one column can land out of order and leave the row
    // holding the value the consumer did not choose last.
    let release: (value: { ok: true }) => void = () => {};
    mocks.saveConsent.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );
    renderSettings(ALL_OFF);

    fireEvent.click(toggle(LABELS.marketing_opt_in));
    fireEvent.click(toggle(LABELS.marketing_opt_in));

    expect(mocks.saveConsent).toHaveBeenCalledTimes(1);
    release({ ok: true });
  });
});

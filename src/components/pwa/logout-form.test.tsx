import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { swMessageAction } from "@/lib/pwa/messages";

import { LogoutForm, logOutAction } from "./logout-form";

// LOGGING OUT ON A SHARED PHONE (doc 41 preamble rule 2, section 8).
//
// `giya-pages-*` holds RSC documents carrying the signed-in consumer's name and
// balance. Nothing purged it on logout, so the next person to sign in on the
// same phone could be served the previous one's /home from cache.
//
// The three properties pinned here are ORDERING and TWO KINDS OF SURVIVAL:
//
//   the purge is posted BEFORE the session ends, not after
//   a purge that cannot happen never stops the sign-out
//   the redirect inside signOut() is not swallowed by anything here
//
// `signOut` is a Server Action, so it is mocked - what is under test is the
// client wrapper's behaviour around it, and the action's own contract is
// asserted in src/features/identity/actions.test.ts.

/** Every side effect, in the order it happened. Ordering is the point. */
let trace: string[];
let signOutBehaviour: "resolve" | "redirect";

const signOut = vi.fn(async () => {
  trace.push("signOut");
  if (signOutBehaviour === "redirect") {
    // What `redirect("/login")` does: it signals by THROWING. A wrapper that
    // caught it would swallow the navigation and leave the consumer on a page
    // that still looks signed in.
    throw new Error("NEXT_REDIRECT;replace;/login");
  }
});

vi.mock("@/features/identity/actions", () => ({
  signOut: () => signOut(),
}));

class FakeController {
  postMessage(message: unknown): void {
    if (postThrows) throw new DOMException("redundant worker");
    trace.push(`post:${swMessageAction(message)}`);
  }
}

let postThrows = false;

function installServiceWorker(controller: FakeController | null | undefined): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: controller === undefined ? undefined : { controller },
  });
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
}

beforeEach(() => {
  trace = [];
  postThrows = false;
  signOutBehaviour = "resolve";
  signOut.mockClear();
  installServiceWorker(new FakeController());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderForm() {
  return render(
    <LogoutForm>
      <button type="submit">Log out</button>
    </LogoutForm>,
  );
}

describe("LogoutForm", () => {
  it("CRITICAL: purges the authenticated caches BEFORE the session ends", async () => {
    renderForm();

    submit();

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    // The order is the assertion. A purge posted after the action has resolved
    // races a page that is already navigating to /login, and the message can be
    // dropped with the document.
    expect(trace).toEqual(["post:purge-user-caches", "signOut"]);
  });

  it("posts a message the worker resolves to the purge action, not merely 'a message'", async () => {
    renderForm();

    submit();

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    // `swMessageAction` is the worker's own decision function. Posting
    // SKIP_WAITING, or a misspelled type, would be a silent no-op in production
    // and is a failure here.
    expect(trace[0]).toBe("post:purge-user-caches");
  });

  it("CRITICAL: signs out anyway when posting the purge throws", async () => {
    postThrows = true;
    renderForm();

    submit();

    // A logout that failed because a cache could not be cleared is worse than
    // the exposure being fixed.
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(trace).toEqual(["signOut"]);
  });

  it("CRITICAL: signs out anyway when no worker controls the page", async () => {
    installServiceWorker(null);
    renderForm();

    submit();

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(trace).toEqual(["signOut"]);
  });

  it("CRITICAL: signs out anyway on a browser with no service workers at all", async () => {
    installServiceWorker(undefined);
    renderForm();

    submit();

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(trace).toEqual(["signOut"]);
  });

  it("CRITICAL: does not swallow the redirect signOut throws", async () => {
    signOutBehaviour = "redirect";

    // Called DIRECTLY, not through the form. React's action machinery absorbs
    // whatever the action throws, so a `try/catch` around `signOut()` would look
    // identical through the DOM - and in production would have swallowed the
    // navigation, leaving the consumer on a page that still shows their name.
    // The action must REJECT.
    await expect(logOutAction()).rejects.toThrow(/NEXT_REDIRECT/);

    // And the purge still went first, before the throw.
    expect(trace).toEqual(["post:purge-user-caches", "signOut"]);
  });

  it("is the same function the form runs, so the assertion above is about the real path", () => {
    // The one thing the DOM cannot answer: React exposes no way to read back the
    // function it was given as a form action, so the link between the exported
    // `logOutAction` and the rendered `<form>` is asserted at the source. Both
    // halves are needed - this alone would be words on a page, and the direct
    // call alone could be testing a function nothing uses.
    const code = readFileSync(join(process.cwd(), "src", "components", "pwa", "logout-form.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(code).toContain("<form action={logOutAction}");
  });

  it("renders the caller's own control, so the three logout surfaces keep their styling", () => {
    render(
      <LogoutForm className="w-full">
        <button type="submit" className="text-error">
          Log out
        </button>
      </LogoutForm>,
    );

    const button = screen.getByRole("button", { name: "Log out" });
    expect(button).toHaveClass("text-error");
    expect(button.closest("form")).toHaveClass("w-full");
  });
});

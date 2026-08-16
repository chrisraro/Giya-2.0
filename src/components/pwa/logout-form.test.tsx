import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

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
  // A REAL IndexedDB, same seam as outbox.test.ts: the two storage claims this
  // file makes - the queue survives, the active user does not - are claims
  // about what is on the device, and a stand-in store would pass either way.
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("CRITICAL: does not delete the queued receipts, which were promised to be kept", async () => {
    // THE DECISION THIS PINS. Doc 41 section 8's logout purge covers the
    // IndexedDB snapshot - a cache of data the server already has. The outbox
    // is different in kind: it holds the only copy of a photo the consumer was
    // told was SAVED ("Saved on your phone. We will send it when you are back
    // online."). Deleting it here would make that sentence false, silently, on
    // a tap that was about ending a session. `user_id` is what closes the
    // cross-user exposure instead, so A's rows are invisible to B AND still
    // there when A signs back in on this phone.
    const { putOutboxItem, listOutboxItems } = await import("@/features/pwa/outbox");
    await putOutboxItem({
      id: "a-1",
      user_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      image: new NodeBlob(["jpeg"], { type: "image/jpeg" }) as unknown as Blob,
      client_sha256: null,
      business_id: null,
      captured_at: "2026-08-16T09:00:00.000Z",
      idempotency_key: "22222222-2222-4222-8222-222222222222",
      image_path: null,
      attempts: 0,
      last_error: null,
      status: "queued",
    });

    await logOutAction();

    expect(await listOutboxItems()).toHaveLength(1);
  });

  it("CRITICAL: forgets who was signed in, so a background drain stops", async () => {
    // The Background Sync replay runs with the app closed and reads this
    // record to decide whose rows it may touch. Leaving it set would let a
    // sync event fire against the departed consumer's rows under whatever
    // session comes next. See src/features/pwa/active-user.ts.
    const { rememberActiveUser, readActiveUser } = await import("@/features/pwa/active-user");
    await rememberActiveUser("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");

    await logOutAction();

    await waitFor(async () => expect(await readActiveUser()).toBeNull());
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

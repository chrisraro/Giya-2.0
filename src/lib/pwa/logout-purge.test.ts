import { describe, expect, it } from "vitest";

import { postUserCachePurge } from "./logout-purge";
import { swMessageAction } from "./messages";

// POSTING THE LOGOUT PURGE (doc 41 preamble rule 2, section 8).
//
// The assertions about WHAT was posted go through `swMessageAction` - the same
// function the worker uses to decide what an inbound message means - rather
// than comparing the posted object to the constant it came from. Comparing a
// constant to itself cannot disagree with the code: a mutant that posted
// SKIP_WAITING, or `{type: "PURGE_USER_CACHE"}`, would satisfy "an object was
// posted" and satisfy "it equals the thing we posted", while the worker ignored
// it and the previous consumer's /home stayed cached.

interface Posted {
  readonly messages: unknown[];
}

function fakeContainer(options?: {
  readonly controller?: "present" | "absent";
  readonly throwOnPost?: boolean;
}): { container: ServiceWorkerContainer; posted: Posted } {
  const posted: Posted = { messages: [] };
  const controller =
    options?.controller === "absent"
      ? null
      : {
          postMessage: (message: unknown) => {
            if (options?.throwOnPost === true) throw new DOMException("redundant worker");
            posted.messages.push(message);
          },
        };

  return { container: { controller } as unknown as ServiceWorkerContainer, posted };
}

describe("postUserCachePurge", () => {
  it("CRITICAL: posts a message the worker resolves to the purge action", () => {
    const { container, posted } = fakeContainer();

    expect(postUserCachePurge(container)).toBe(true);
    expect(posted.messages).toHaveLength(1);
    // Through the worker's own parser. This is the assertion that ties the two
    // halves of the protocol together.
    expect(swMessageAction(posted.messages[0])).toBe("purge-user-caches");
  });

  it("posts to the worker controlling this page, exactly once", () => {
    const { container, posted } = fakeContainer();

    postUserCachePurge(container);

    expect(posted.messages).toHaveLength(1);
  });

  it("CRITICAL: says no and posts nothing when the browser has no service workers", () => {
    // Insecure origins, some private windows, iOS below 16.4 outside an
    // installed app. Nothing was ever cached for this session there.
    expect(postUserCachePurge(undefined)).toBe(false);
    expect(postUserCachePurge(null)).toBe(false);
  });

  it("CRITICAL: says no when no worker controls this page yet", () => {
    const { container, posted } = fakeContainer({ controller: "absent" });

    expect(postUserCachePurge(container)).toBe(false);
    expect(posted.messages).toHaveLength(0);
  });

  it("CRITICAL: never throws, so a failed post cannot strand the consumer signed in", () => {
    const { container } = fakeContainer({ throwOnPost: true });

    expect(() => postUserCachePurge(container)).not.toThrow();
    expect(postUserCachePurge(container)).toBe(false);
  });

  it("CRITICAL: never throws on a container that throws when read", () => {
    // A hostile or half-torn-down `navigator.serviceWorker`. The sign-out that
    // follows this call is the thing that must not be lost.
    const hostile = {
      get controller(): ServiceWorker {
        throw new Error("storage blocked");
      },
    } as unknown as ServiceWorkerContainer;

    expect(() => postUserCachePurge(hostile)).not.toThrow();
    expect(postUserCachePurge(hostile)).toBe(false);
  });
});

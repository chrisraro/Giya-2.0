import "server-only";

import { randomBytes } from "node:crypto";

import { decryptToken, encryptToken } from "@/lib/crypto/token-cipher";
import { getDel, get, redisKey, setNx } from "@/lib/redis";

// =============================================================================
// The pending page selection: the handoff between the OAuth callback and the
// merchant choosing which Page to connect.
// =============================================================================
//
// docs/30-modules/42-integrations.md's connect flow has a step that cannot be
// completed inside the callback: "lists Pages, user picks Page(s) -> one
// integration_connections row per Page". The callback holds tokens the moment
// it returns from Meta, but it does not yet know which Page the merchant
// wants, and it must answer with a redirect rather than a page of UI.
//
// So the tokens have to survive one round trip through the merchant's browser.
// Three ways to do that, and only one of them is acceptable:
//
//   * IN THE URL or a cookie - never. That is the credential in a browser, in
//     the history, in the referrer header of the next request, and in every
//     log between here and the client.
//   * AS `integration_connections` ROWS FOR EVERY PAGE, deleting the unwanted
//     ones afterwards - this stores credentials the merchant never agreed to
//     store, and a merchant who abandons the flow leaves them stored.
//   * IN REDIS, ENCRYPTED, UNDER AN OPAQUE ID, SINGLE USE - this file.
//
// -----------------------------------------------------------------------------
// WHY THE PAYLOAD IS ENCRYPTED EVEN THOUGH REDIS IS PRIVATE
// -----------------------------------------------------------------------------
//
// It contains one page access token per Page the merchant administers. That is
// exactly the class of value migration 0032 refuses to let a client role read
// out of Postgres, and it would be incoherent to fence it in the database and
// then leave it in plaintext in a key-value store that has no column grants,
// no RLS, and a REST API reachable with a single bearer token.
//
// Reusing `token-cipher` rather than inventing something for this ten-minute
// window is deliberate: the envelope is already audited, already tested, and
// already rotates. A second, weaker scheme "because it is only temporary" is
// how the weaker scheme ends up being the one that leaks.
//
// The selection id is bound to the business and the user, and consumed with a
// single atomic GETDEL, for the same three reasons state.ts is.

/** Same ten minutes as the state nonce: this is the second half of one flow. */
export const SELECTION_TTL_SECONDS = 600;

/** Checked before the value is used to build a Redis key. See state.ts. */
const SELECTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const LOG_PREFIX = "[integrations/meta/selection]";

/** One Page offered to the merchant, with the credential that goes with it. */
export interface SelectablePage {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly accessToken: string;
}

export interface PendingSelection {
  readonly businessId: string;
  readonly userId: string;
  readonly pages: readonly SelectablePage[];
  /** The scopes Meta reported as ACTUALLY granted, not the ones requested. */
  readonly grantedScopes: readonly string[];
  /** When the long-lived user token expires, if Meta stated it. */
  readonly tokenExpiresAt: string | null;
}

/** What the picker screen may see. Note what is missing: every access token. */
export interface SelectablePageView {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
}

interface StoredEnvelope extends PendingSelection {
  readonly issuedAt: number;
}

function keyFor(selectionId: string): string {
  return redisKey("meta", "select", selectionId);
}

/**
 * Store the pages a merchant may choose from, and return the opaque id that
 * addresses them.
 *
 * The id is the ONLY thing that travels through the browser. It is a random
 * 16-byte value with no structure, so it names nothing and reveals nothing:
 * knowing it without a session for the same user and business is useless,
 * because `readSelection` checks both.
 */
export async function storePendingSelection(input: PendingSelection): Promise<string> {
  const selectionId = randomBytes(16).toString("base64url");
  const envelope: StoredEnvelope = { ...input, issuedAt: Date.now() };

  const ciphertext = encryptToken(JSON.stringify(envelope)).toString("base64");
  const stored = await setNx(keyFor(selectionId), ciphertext, SELECTION_TTL_SECONDS);
  if (!stored) {
    throw new Error("Could not prepare the Meta page list. Please try again.");
  }

  return selectionId;
}

type ReadMode = "peek" | "consume";

async function readSelection(
  selectionId: string,
  businessId: string,
  userId: string,
  mode: ReadMode,
): Promise<PendingSelection | null> {
  if (!SELECTION_ID_PATTERN.test(selectionId)) return null;

  let raw: string | null;
  try {
    raw = mode === "consume" ? await getDel(keyFor(selectionId)) : await get(keyFor(selectionId));
  } catch (error) {
    // Fail closed, same as state.ts: a store we cannot read tells us nothing.
    console.error(`${LOG_PREFIX} could not read the selection store; refusing`, error);
    return null;
  }
  if (raw === null) return null;

  let envelope: StoredEnvelope;
  try {
    envelope = JSON.parse(decryptToken(Buffer.from(raw, "base64"))) as StoredEnvelope;
  } catch {
    // A decrypt failure here means the key rotated mid-flow or the value was
    // tampered with. Either way there is nothing to salvage, and the error is
    // swallowed rather than propagated because it would carry ciphertext.
    console.error(`${LOG_PREFIX} a stored selection could not be opened`);
    return null;
  }

  // The binding checks. A selection id alone is not authority.
  if (envelope.businessId !== businessId || envelope.userId !== userId) return null;

  return envelope;
}

/**
 * The page list for the picker UI, WITHOUT the tokens.
 *
 * A peek, not a consume: rendering the screen must not spend the selection,
 * or a refresh would empty it. It is the confirm action that consumes.
 */
export async function peekSelectablePages(input: {
  readonly selectionId: string;
  readonly businessId: string;
  readonly userId: string;
}): Promise<readonly SelectablePageView[] | null> {
  const selection = await readSelection(
    input.selectionId,
    input.businessId,
    input.userId,
    "peek",
  );
  if (selection === null) return null;

  // The mapping is explicit rather than a spread with `accessToken` deleted:
  // a spread is how a credential reaches a client component the day someone
  // adds a field to SelectablePage.
  return selection.pages.map((page) => ({
    id: page.id,
    name: page.name,
    category: page.category,
  }));
}

/**
 * Consume the selection to write the connection rows. Single use, atomically,
 * so a double-submitted form cannot connect twice.
 */
export async function consumeSelection(input: {
  readonly selectionId: string;
  readonly businessId: string;
  readonly userId: string;
}): Promise<PendingSelection | null> {
  return readSelection(input.selectionId, input.businessId, input.userId, "consume");
}

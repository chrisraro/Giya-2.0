import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

// =============================================================================
// AES-256-GCM for the `integration_connections` token columns.
// =============================================================================
//
// docs/10-architecture/15-security.md: "App-level encryption (AES-256-GCM ...)
// for high-sensitivity columns", the pattern the TIN and government-ID columns
// use. docs/30-modules/42-integrations.md: tokens are "encrypted AES-256-GCM
// app-layer like TINs, never logged, never in claims, never selected by
// client-reachable query paths", and its env registry specifies the key as
// "key-id-prefixed".
//
// This module is the ONLY place in the codebase that sees a decrypted OAuth
// token as bytes. Everything downstream of it either holds ciphertext (the
// database, whose column grant hides even that from clients - see migration
// 0032) or holds the plaintext for the duration of exactly one outbound call
// to the provider.
//
// -----------------------------------------------------------------------------
// THE ENVELOPE FORMAT. THIS IS PERMANENT.
// -----------------------------------------------------------------------------
//
// Once a single row exists, this layout can never be changed - only extended
// behind a new version byte, with the old branch kept forever. So it is
// written down here in full, and migration 0032 asserts the first byte of it
// at the database layer (which is also what makes bumping the version a
// deliberate, migration-shaped act rather than an edit).
//
//   offset  bytes  meaning
//   ------  -----  ---------------------------------------------------------
//        0      1  version. 0x01 today. A reader that does not recognise the
//                  value refuses; it never guesses.
//        1      1  keyIdLen, 1..32. Length-prefixed rather than delimiter-
//                  separated because a delimiter has to be escaped and an
//                  escape has to be got right; a length cannot be ambiguous.
//        2      n  keyId, ASCII [a-z0-9_-]. WHICH KEY ENCRYPTED THIS ROW.
//      2+n     12  IV, 12 cryptographically random bytes, fresh per call.
//     14+n     16  GCM authentication tag.
//     30+n    ...  ciphertext, same length as the plaintext.
//
// AAD is the header - bytes 0 .. 2+n, i.e. version + keyIdLen + keyId. The key
// id therefore cannot be edited at rest without the tag failing: an attacker
// who could rewrite the id to point at a weaker or attacker-known key would
// otherwise be handed a downgrade attack, and "the tag would fail anyway
// because the key differs" is an argument that stops being true the moment two
// keys ever coexist for a rotation, which is the whole reason the field is
// there.
//
// -----------------------------------------------------------------------------
// WHY THE KEY ID IS IN THE ROW AND NOT IN A CONFIG SOMEWHERE
// -----------------------------------------------------------------------------
//
// A rotation without it is an all-or-nothing migration: every row has to be
// re-encrypted inside the same deploy that swaps the key, or every row becomes
// unreadable. That is a big, scary, unrehearsable operation, which in practice
// means the key never gets rotated at all.
//
// With the id in the row, rotation is boring. Put the new key FIRST in
// INTEGRATION_TOKEN_AES_KEY and leave the old one after it: new writes use the
// new key, old rows keep decrypting with the old one, and rows migrate
// naturally as tokens refresh (doc 42's refresh-on-read re-encrypts whatever
// it re-exchanges). The old key is dropped from the variable once no row
// carries its id. Nothing has to happen atomically, and nothing has to happen
// at 3am.
//
// -----------------------------------------------------------------------------
// WHAT THIS MODULE REFUSES TO DO
// -----------------------------------------------------------------------------
//
// It never puts a token, a key, or a fragment of either into an Error message,
// a log line, or a thrown value. Every failure below is a code plus a fixed
// sentence. That is not decoration: an exception message is the single most
// likely place for a credential to escape a server, because it travels to the
// error reporter, into a log aggregator, and sometimes into a response body.
// `TokenCipherError` exists so callers can branch on the reason without anyone
// ever being tempted to interpolate the value that caused it.
//
// It also never returns unauthenticated plaintext. GCM's tag is verified by
// `decipher.final()`, and a tampered ciphertext, a tampered tag, a tampered
// header or the wrong key all end in the same place: a throw. There is no
// "best effort" decrypt.

/** The one version byte written today. See the layout above. */
export const TOKEN_ENVELOPE_VERSION = 1;

/** GCM's standard IV size. 96 bits is the size the mode is specified for. */
const IV_BYTES = 12;

/** GCM's full-length tag. Truncated tags are a weakening, not an optimisation. */
const TAG_BYTES = 16;

/** AES-256. The key material must be exactly this long after decoding. */
const KEY_BYTES = 32;

const MAX_KEY_ID_BYTES = 32;

/**
 * Key ids are opaque labels, but they live in every row forever, so they are
 * constrained to something that can be typed, grepped, and read aloud during
 * an incident.
 */
const KEY_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** The id assigned when the env var carries bare key material with no label. */
const DEFAULT_KEY_ID = "k1";

export type TokenCipherErrorCode =
  /** INTEGRATION_TOKEN_AES_KEY is unset or empty. */
  | "TOKEN_CIPHER_NOT_CONFIGURED"
  /** The variable is set but unparseable, or a key is not 32 bytes. */
  | "TOKEN_CIPHER_KEY_INVALID"
  /** The stored bytes are not a well-formed envelope. */
  | "TOKEN_CIPHER_MALFORMED"
  /** The envelope names a version this build does not implement. */
  | "TOKEN_CIPHER_VERSION_UNSUPPORTED"
  /** The envelope names a key id that is not in the current registry. */
  | "TOKEN_CIPHER_KEY_UNKNOWN"
  /** The tag did not verify: wrong key, or the bytes were altered. */
  | "TOKEN_CIPHER_AUTH_FAILED";

/**
 * A failure from the cipher boundary.
 *
 * The message is a FIXED sentence chosen per code. Nothing derived from the
 * ciphertext, the plaintext or the key is interpolated into it, and no `cause`
 * is attached: Node's own GCM failure carries no secret, but attaching it
 * would establish a pattern where the next `cause` might.
 */
export class TokenCipherError extends Error {
  readonly code: TokenCipherErrorCode;

  constructor(code: TokenCipherErrorCode, message: string) {
    super(message);
    this.name = "TokenCipherError";
    this.code = code;
  }
}

interface CipherKey {
  readonly id: string;
  readonly material: Buffer;
}

interface KeyRegistry {
  /** Used for every encryption. The first entry of the env variable. */
  readonly active: CipherKey;
  /** Every key that may appear in a stored envelope, by id. */
  readonly byId: ReadonlyMap<string, CipherKey>;
}

/**
 * Decode 32 bytes of key material.
 *
 * base64 and base64url are both accepted because a key generated with
 * `openssl rand -base64 32` and one generated with Node's `base64url` look
 * different and are equally correct, and a deployment that fails because a `+`
 * became a `-` is a deployment that fails at the worst possible moment for the
 * least interesting possible reason. Hex is accepted for the same pragmatism.
 *
 * The LENGTH is not negotiable: base64 silently ignores trailing garbage and
 * happily decodes a truncated string into fewer bytes, so a typo'd key would
 * otherwise become a 24-byte key and `createCipheriv` would fail somewhere far
 * from here with a message about IV lengths.
 */
function decodeKeyMaterial(raw: string): Buffer | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]+$/.test(value) && value.length === KEY_BYTES * 2) {
    candidates.push(Buffer.from(value, "hex"));
  }
  candidates.push(Buffer.from(value, "base64"));
  candidates.push(Buffer.from(value, "base64url"));

  return candidates.find((buffer) => buffer.length === KEY_BYTES) ?? null;
}

/**
 * Parse INTEGRATION_TOKEN_AES_KEY.
 *
 * Accepted forms, in increasing order of explicitness:
 *
 *   <base64>                       -> one key, id "k1"
 *   k2:<base64>                    -> one key, id "k2"
 *   k2:<base64>,k1:<base64>        -> k2 is ACTIVE, k1 still decrypts
 *
 * The FIRST entry is always the active one. Order is the rotation control and
 * it is the only one, deliberately: a separate "which key is active" variable
 * is a second thing to get right, and getting it wrong writes rows nobody can
 * read.
 *
 * A bare (unlabelled) key is only legal as the sole entry. In a list, every
 * entry must name itself - otherwise two unlabelled keys would both claim
 * `k1`, and the collision check below would be the only thing standing between
 * a rotation and permanently unreadable rows.
 */
function parseRegistry(raw: string): KeyRegistry {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new TokenCipherError(
      "TOKEN_CIPHER_NOT_CONFIGURED",
      "INTEGRATION_TOKEN_AES_KEY is not configured.",
    );
  }

  const keys: CipherKey[] = [];
  const byId = new Map<string, CipherKey>();

  for (const entry of entries) {
    const separator = entry.indexOf(":");
    const labelled = separator > 0;

    if (!labelled && entries.length > 1) {
      throw new TokenCipherError(
        "TOKEN_CIPHER_KEY_INVALID",
        "INTEGRATION_TOKEN_AES_KEY lists more than one key, so every entry must be written as keyId:material.",
      );
    }

    const id = labelled ? entry.slice(0, separator).trim() : DEFAULT_KEY_ID;
    const material = decodeKeyMaterial(labelled ? entry.slice(separator + 1) : entry);

    if (!KEY_ID_PATTERN.test(id)) {
      throw new TokenCipherError(
        "TOKEN_CIPHER_KEY_INVALID",
        "An INTEGRATION_TOKEN_AES_KEY key id must be 1 to 32 characters of a-z, 0-9, underscore or hyphen.",
      );
    }
    if (material === null) {
      throw new TokenCipherError(
        "TOKEN_CIPHER_KEY_INVALID",
        "An INTEGRATION_TOKEN_AES_KEY entry did not decode to 32 bytes of key material (base64, base64url or hex).",
      );
    }
    if (byId.has(id)) {
      // Two keys under one id means one of them decrypts nothing and the rows
      // written under the other are lost. Refuse at startup of the first
      // encryption rather than discover it during the rotation.
      throw new TokenCipherError(
        "TOKEN_CIPHER_KEY_INVALID",
        "INTEGRATION_TOKEN_AES_KEY names the same key id twice.",
      );
    }

    const key: CipherKey = { id, material };
    keys.push(key);
    byId.set(id, key);
  }

  const active = keys[0];
  if (active === undefined) {
    throw new TokenCipherError(
      "TOKEN_CIPHER_NOT_CONFIGURED",
      "INTEGRATION_TOKEN_AES_KEY is not configured.",
    );
  }

  return { active, byId };
}

/**
 * Memoized per raw value rather than per process.
 *
 * Keying the cache on the raw string is what lets a test set a different key
 * and get a different registry without an explicit reset hook, while a real
 * process - whose environment does not change - still parses exactly once.
 */
let cachedRaw: string | undefined;
let cachedRegistry: KeyRegistry | undefined;

function readRawKey(): string {
  // Read straight from process.env rather than through getServerEnv(), for the
  // reason src/lib/supabase/service.ts gives at length: that schema validates
  // as a unit and throws naming every missing key, so an unrelated absent
  // variable would surface here as a token-encryption failure. The validation
  // that matters for this value is done above, thoroughly, by parseRegistry.
  return process.env.INTEGRATION_TOKEN_AES_KEY ?? "";
}

function getRegistry(): KeyRegistry {
  const raw = readRawKey();
  if (raw.trim().length === 0) {
    throw new TokenCipherError(
      "TOKEN_CIPHER_NOT_CONFIGURED",
      "INTEGRATION_TOKEN_AES_KEY is not configured.",
    );
  }
  if (cachedRegistry !== undefined && cachedRaw === raw) {
    return cachedRegistry;
  }

  const registry = parseRegistry(raw);
  cachedRaw = raw;
  cachedRegistry = registry;
  return registry;
}

/**
 * Whether a usable key is configured, without throwing.
 *
 * The connect flow calls this before offering to store anything, so a
 * deployment missing the key refuses the CONNECT with an honest message rather
 * than completing an OAuth round trip with Meta and then failing at the
 * insert, having already obtained a real token it now has nowhere safe to put.
 */
export function isTokenCipherConfigured(): boolean {
  try {
    getRegistry();
    return true;
  } catch {
    return false;
  }
}

/** The id of the key new envelopes are written under. For diagnostics only. */
export function activeKeyId(): string {
  return getRegistry().active.id;
}

/**
 * Encrypt one token into a storable envelope.
 *
 * A FRESH RANDOM IV PER CALL, from `randomBytes`, and never anything derived
 * from the plaintext or a counter. IV reuse under GCM with the same key is not
 * a partial weakening: it leaks the XOR of the two plaintexts and, worse,
 * leaks the authentication subkey, which lets an attacker forge tags for that
 * key from then on. There is exactly one line in this codebase where that
 * could go wrong and it is the next one.
 */
export function encryptToken(plaintext: string): Buffer {
  if (plaintext.length === 0) {
    // An empty token is never a real token; storing one produces a row that
    // looks connected and fails on first use, which is the worst of both.
    throw new TokenCipherError(
      "TOKEN_CIPHER_MALFORMED",
      "Refusing to encrypt an empty token.",
    );
  }

  const { active } = getRegistry();
  const keyIdBytes = Buffer.from(active.id, "ascii");
  const header = Buffer.concat([
    Buffer.from([TOKEN_ENVELOPE_VERSION, keyIdBytes.length]),
    keyIdBytes,
  ]);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", active.material, iv);
  cipher.setAAD(header);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([header, iv, tag, ciphertext]);
}

interface ParsedEnvelope {
  readonly header: Buffer;
  readonly keyId: string;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Split an envelope without trusting any of it.
 *
 * Every length is checked against the remaining bytes before it is used to
 * slice, because `Buffer.subarray` silently returns a short buffer rather than
 * throwing - which is how a truncated row becomes a confusing GCM error
 * instead of a clear "this is not an envelope".
 */
function parseEnvelope(envelope: Buffer): ParsedEnvelope {
  if (envelope.length < 2) {
    throw new TokenCipherError("TOKEN_CIPHER_MALFORMED", "Stored token envelope is truncated.");
  }

  const version = envelope[0];
  if (version !== TOKEN_ENVELOPE_VERSION) {
    // Refuse, never guess. A future version 2 adds a branch here; until it
    // exists, an unrecognised version is a row this build must not touch.
    throw new TokenCipherError(
      "TOKEN_CIPHER_VERSION_UNSUPPORTED",
      "Stored token envelope names an unsupported format version.",
    );
  }

  const keyIdLength = envelope[1] ?? 0;
  if (keyIdLength === 0 || keyIdLength > MAX_KEY_ID_BYTES) {
    throw new TokenCipherError("TOKEN_CIPHER_MALFORMED", "Stored token envelope has no usable key id.");
  }

  const headerLength = 2 + keyIdLength;
  // At least one byte of ciphertext: a zero-length one would decrypt to the
  // empty string, which `encryptToken` refuses to produce.
  if (envelope.length <= headerLength + IV_BYTES + TAG_BYTES) {
    throw new TokenCipherError("TOKEN_CIPHER_MALFORMED", "Stored token envelope is truncated.");
  }

  const header = envelope.subarray(0, headerLength);
  const keyId = header.subarray(2).toString("ascii");
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new TokenCipherError("TOKEN_CIPHER_MALFORMED", "Stored token envelope has an invalid key id.");
  }

  return {
    header,
    keyId,
    iv: envelope.subarray(headerLength, headerLength + IV_BYTES),
    tag: envelope.subarray(headerLength + IV_BYTES, headerLength + IV_BYTES + TAG_BYTES),
    ciphertext: envelope.subarray(headerLength + IV_BYTES + TAG_BYTES),
  };
}

/**
 * Decrypt one stored envelope back to the token.
 *
 * Throws on ANY failure. In particular a tampered ciphertext, a tampered tag,
 * a tampered header and the wrong key are indistinguishable to the caller and
 * all end as `TOKEN_CIPHER_AUTH_FAILED` - deliberately, because telling them
 * apart is exactly the oracle that makes chosen-ciphertext attacks practical,
 * and because no caller has a different course of action for any of them.
 */
export function decryptToken(envelope: Buffer): string {
  const parsed = parseEnvelope(envelope);
  const registry = getRegistry();
  const key = registry.byId.get(parsed.keyId);

  if (key === undefined) {
    // Distinguished from AUTH_FAILED on purpose, and it is not an oracle: the
    // key id is public metadata sitting in plaintext at the front of the
    // envelope, so an attacker already knows it. It is the difference between
    // "someone dropped a key that rows still reference" (an operations
    // mistake, fixable by restoring it to the variable) and "these bytes are
    // not what we wrote" (an integrity event). Collapsing them would make the
    // first one undiagnosable.
    throw new TokenCipherError(
      "TOKEN_CIPHER_KEY_UNKNOWN",
      "Stored token was encrypted with a key id that is not configured.",
    );
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key.material, parsed.iv);
    decipher.setAAD(parsed.header);
    decipher.setAuthTag(parsed.tag);
    // `final()` is what verifies the tag. It is not optional and its result is
    // not merely "the last chunk": omitting it returns unauthenticated
    // plaintext, which is the classic way GCM gets misused.
    const plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    // The underlying error is swallowed rather than chained. It carries no
    // secret today, but the rule in this file is that nothing from the crypto
    // path is ever re-thrown outward, and a `cause` is the crack that rule
    // would leak through first.
    throw new TokenCipherError(
      "TOKEN_CIPHER_AUTH_FAILED",
      "Stored token failed authentication and was not decrypted.",
    );
  }
}

/**
 * Constant-time equality for two secrets of the same kind.
 *
 * Exported from here rather than reimplemented at each call site because the
 * webhook signature check and the state-nonce check both need it, and the
 * length guard in front of `timingSafeEqual` (which throws on a length
 * mismatch) is the part people forget.
 *
 * The length comparison itself is NOT constant time and does not need to be:
 * the length of an HMAC digest or a nonce is fixed and public.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

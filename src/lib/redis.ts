import { getServerEnv } from "./env";

// Minimal fetch-based Upstash Redis REST client. No SDK dependency: Upstash's
// REST API accepts a JSON command array POSTed to the base URL and returns
// `{ result: ... }`. Kept intentionally tiny; this file is the only place
// that talks to Redis over HTTP.

async function sendCommand(command: readonly string[]): Promise<unknown> {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = getServerEnv();

  const response = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    // Fail closed: a Redis outage must never be treated as "key absent" or
    // "write succeeded" since either would allow a redemption token replay.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Upstash Redis request failed (${response.status}): ${detail || "no response body"}`,
    );
  }

  const body = (await response.json()) as { result: unknown };
  return body.result;
}

// Namespaces a redis key by NODE_ENV so dev/test/production traffic never
// collides in the same Upstash database.
export function redisKey(...parts: string[]): string {
  return `${process.env.NODE_ENV}:${parts.join(":")}`;
}

// SET key value NX EX ttlSeconds. Returns true only when the key was
// actually set (Upstash returns "OK"); returns false when the key already
// existed (Upstash returns null), meaning the caller lost the race.
export async function setNx(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await sendCommand([
    "SET",
    key,
    value,
    "NX",
    "EX",
    String(ttlSeconds),
  ]);

  return result === "OK";
}

// GETDEL key: atomically reads and deletes the key in one round trip. This
// MUST stay a single command. A GET followed by a separate DEL would open a
// race between two concurrent consumers of the same single-use token: both
// could read the value before either deletes it.
export async function getDel(key: string): Promise<string | null> {
  const result = await sendCommand(["GETDEL", key]);
  return (result as string | null) ?? null;
}

// GET key: plain read, no side effect. Used where the caller needs to look
// at a value (e.g. a pointer key) without consuming it - unlike getDel,
// which must be used for anything single-use.
export async function get(key: string): Promise<string | null> {
  const result = await sendCommand(["GET", key]);
  return (result as string | null) ?? null;
}

// SET key value EX ttlSeconds: unconditional write (no NX), always
// overwrites any existing value. Returns true when Upstash acknowledges the
// write ("OK"). Unlike setNx, this is for keys where "last write wins" is
// exactly the desired behavior (e.g. a pointer key that should always track
// the most recent value).
export async function set(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await sendCommand(["SET", key, value, "EX", String(ttlSeconds)]);
  return result === "OK";
}

// DEL key: deletes a key regardless of its value. Returns the number of
// keys actually removed (0 or 1 for a single key), so callers can tell
// "there was nothing to delete" from "deleted it".
export async function del(key: string): Promise<number> {
  const result = await sendCommand(["DEL", key]);
  return Number(result);
}

// INCR key: atomically increments the integer stored at key (creating it at
// 1 if absent) and returns the new value. The building block for the fixed-
// window rate limiter in src/lib/rate-limit.ts.
export async function incr(key: string): Promise<number> {
  const result = await sendCommand(["INCR", key]);
  return Number(result);
}

// EXPIRE key seconds: sets a TTL on an existing key. Returns true when the
// TTL was set, false when the key does not exist. Combined with incr(), the
// caller sets the TTL only on the first increment of a window so later
// increments do not keep pushing the window out.
export async function expire(key: string, seconds: number): Promise<boolean> {
  const result = await sendCommand(["EXPIRE", key, String(seconds)]);
  return result === 1;
}

// EXPIRE key seconds NX: sets a TTL only if the key currently has none.
// Self-healing complement to incr() in the rate limiter - safe (and cheap)
// to call on EVERY request rather than only the first increment of a
// window, because it is a no-op whenever a TTL already exists. That is what
// lets it repair a key that somehow lost its TTL (a crash or Redis blip
// between a previous INCR and its EXPIRE): the very next call sets one,
// instead of the key counting up forever with no expiry. Returns true when
// the TTL was actually (re-)set (Upstash returns 1), false when the key
// already had a TTL or does not exist (Upstash returns 0).
export async function expireNx(key: string, seconds: number): Promise<boolean> {
  const result = await sendCommand(["EXPIRE", key, String(seconds), "NX"]);
  return result === 1;
}

// TTL key: seconds remaining before the key expires. Upstash returns -1 for
// a key with no expiry and -2 for a key that does not exist; both are
// surfaced as-is so callers decide how to treat "no real TTL" rather than
// this helper silently coercing them into 0 or throwing.
export async function ttl(key: string): Promise<number> {
  const result = await sendCommand(["TTL", key]);
  return Number(result);
}

// SET key value EX ttlSeconds GET: atomically overwrites the key AND
// returns whatever value it held immediately before, in a single round
// trip. This is what makes the redemption-code pointer swap in
// src/features/rewards/server/token.ts race-free: a separate GET-then-SET
// would let two concurrent mints both read the same "previous" value and
// each delete the other's freshly-written key. Returns the previous value,
// or null if the key did not exist before this call.
export async function setGet(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<string | null> {
  const result = await sendCommand([
    "SET",
    key,
    value,
    "EX",
    String(ttlSeconds),
    "GET",
  ]);
  return (result as string | null) ?? null;
}

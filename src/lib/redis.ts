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

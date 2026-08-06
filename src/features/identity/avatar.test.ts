import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";

import {
  AVATARS_BUCKET,
  AVATAR_ACCEPTED_MIME_TYPES,
  AVATAR_ACTION_BODY_LIMIT_BYTES,
  AVATAR_BUCKET_MAX_BYTES,
  AVATAR_CANONICAL_EXTENSION,
  AVATAR_CANONICAL_MIME_TYPE,
  AVATAR_FOLDER_DEPTH,
  AVATAR_MAX_UPLOAD_BYTES,
  AVATAR_OWNER_SEGMENT_INDEX,
  newAvatarObjectPath,
  objectPathFromPublicUrl,
} from "./avatar";

// THE AGREEMENT TEST (brief constraint 3).
//
// The upload path and the storage policy have to agree on one convention:
// `{user_id}/{uuid}.jpg`, owner in segment 1, exactly one folder level. Two
// files hold half of that each - src/features/identity/avatar.ts builds the
// name, supabase/migrations/0064_avatars_storage.sql fences on it - and a test
// that checks each side against a remembered convention passes right up until
// they drift apart from each other.
//
// This file therefore parses the predicates OUT OF THE MIGRATION and measures
// the TypeScript builder against them. If the policy moves to segment 2, or the
// builder starts writing `avatars/{uid}/...`, or the bucket is renamed on one
// side only, these assertions fail - and they fail for the right reason, which
// is that the two halves no longer describe the same object name.

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0064_avatars_storage.sql"),
  "utf8",
);

/** The statement a `create policy <name>` line starts, up to its terminating `;`. */
function policyBody(name: string): string {
  const start = MIGRATION.indexOf(`create policy ${name} on storage.objects`);
  if (start === -1) throw new Error(`0064 has no policy named ${name}`);
  const end = MIGRATION.indexOf(";", start);
  if (end === -1) throw new Error(`policy ${name} is not terminated`);
  return MIGRATION.slice(start, end);
}

/** The 1-based index the given policy treats as the owner segment. */
function ownerSegmentIndexOf(policy: string): number {
  const match = policyBody(policy).match(
    /\(storage\.foldername\(name\)\)\[(\d+)\]\s*=\s*\(\s*select\s+auth\.uid\(\)\s*\)::text/,
  );
  if (!match) throw new Error(`policy ${policy} does not fence on a foldername segment at all`);
  return Number(match[1]);
}

/** The folder depth the given policy pins, or null when it pins none. */
function folderDepthOf(policy: string): number | null {
  const match = policyBody(policy).match(
    /array_length\(\s*storage\.foldername\(name\)\s*,\s*1\s*\)\s*=\s*(\d+)/,
  );
  return match ? Number(match[1]) : null;
}

/** The bucket the given policy is scoped to. */
function bucketIdOf(policy: string): string | null {
  const match = policyBody(policy).match(/bucket_id\s*=\s*'([^']+)'/);
  return match ? match[1] ?? null : null;
}

/**
 * `for <verb> to <roles>` off the given policy.
 *
 * The AUDIENCE is parsed here and not only in pgTAP because it is the
 * highest-severity thing in the migration and pgTAP does not run in CI today.
 * `to authenticated` -> `to public` turns a public avatars bucket into an open
 * file host that anon can write to, and it changes nothing about the bucket id,
 * the owner segment or the folder depth - so every other assertion in this file
 * stays green through it.
 */
function audienceOf(policy: string): { verb: string; roles: string[] } {
  const match = policyBody(policy).match(/for\s+(insert|select|update|delete)\s+to\s+([^\n]+)/i);
  if (!match) throw new Error(`policy ${policy} has no parsable "for <verb> to <roles>" clause`);
  return {
    verb: (match[1] as string).toLowerCase(),
    roles: (match[2] as string)
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  };
}

const bucketRow = (() => {
  const match = MIGRATION.match(
    /insert into storage\.buckets[\s\S]*?values\s*\(\s*'([^']+)',\s*'([^']+)',\s*(true|false),\s*(\d+),\s*array\[([^\]]*)\]/,
  );
  if (!match) throw new Error("0064 does not insert a bucket row in the expected shape");
  return {
    id: match[1] as string,
    name: match[2] as string,
    isPublic: match[3] === "true",
    fileSizeLimit: Number(match[4]),
    mimeTypes: (match[5] as string)
      .split(",")
      .map((entry) => entry.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  };
})();

const WRITE_POLICIES = ["avatars_objects_owner_insert", "avatars_objects_owner_update"] as const;
const ALL_POLICIES = [
  "avatars_objects_owner_insert",
  "avatars_objects_owner_select",
  "avatars_objects_owner_update",
  "avatars_objects_owner_delete",
] as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER = "3f1b0f1e-2c3d-4a5b-8c9d-0e1f2a3b4c5d";

describe("the object path the app writes satisfies the policy the database enforces", () => {
  it("CRITICAL: the owner uid lands in exactly the segment the insert policy reads", () => {
    const path = newAvatarObjectPath(OWNER);
    const segments = path.split("/");
    const index = ownerSegmentIndexOf("avatars_objects_owner_insert");

    // 1-based in SQL, 0-based in JS. This is the whole agreement in one line.
    expect(segments[index - 1]).toBe(OWNER);
  });

  it("CRITICAL: the path has exactly the folder depth the insert policy pins", () => {
    const depth = folderDepthOf("avatars_objects_owner_insert");
    expect(depth).not.toBeNull();

    // foldername() drops the filename, so folder depth is segments minus one.
    expect(newAvatarObjectPath(OWNER).split("/").length - 1).toBe(depth);
  });

  it("CRITICAL: the update policy fences on the same segment as the insert policy", () => {
    // A replace that could be written one level deeper than an upload can be is
    // a namespace that drifts under its own fence.
    expect(ownerSegmentIndexOf("avatars_objects_owner_update")).toBe(
      ownerSegmentIndexOf("avatars_objects_owner_insert"),
    );
    expect(folderDepthOf("avatars_objects_owner_update")).toBe(
      folderDepthOf("avatars_objects_owner_insert"),
    );
  });

  it("every policy in 0064 fences on the same owner segment", () => {
    for (const policy of ALL_POLICIES) {
      expect(ownerSegmentIndexOf(policy)).toBe(AVATAR_OWNER_SEGMENT_INDEX);
    }
  });

  it("both WRITE policies pin the folder depth; the read and delete halves deliberately do not", () => {
    for (const policy of WRITE_POLICIES) {
      expect(folderDepthOf(policy)).toBe(AVATAR_FOLDER_DEPTH);
    }
    // Read and delete must be able to see and remove anything that ever landed,
    // including an object written before a depth rule existed.
    expect(folderDepthOf("avatars_objects_owner_select")).toBeNull();
    expect(folderDepthOf("avatars_objects_owner_delete")).toBeNull();
  });

  it("CRITICAL: the bucket the app uploads to is the bucket every policy is scoped to", () => {
    expect(AVATARS_BUCKET).toBe(bucketRow.id);
    for (const policy of ALL_POLICIES) {
      expect(bucketIdOf(policy)).toBe(AVATARS_BUCKET);
    }
  });

  it("CRITICAL: every policy is granted to `authenticated` only, never anon or public", () => {
    // The single highest-severity mutation available in 0064: `to public` lets
    // an unauthenticated caller write into a PUBLIC bucket on the project's own
    // storage origin. pgTAP asserts this too (A7), but pgTAP does not run in CI
    // today and this file does.
    for (const policy of ALL_POLICIES) {
      expect(audienceOf(policy).roles).toEqual(["authenticated"]);
    }
  });

  it("covers all four verbs, exactly once each", () => {
    // A missing DELETE policy is a "remove photo" that silently removes nothing;
    // a missing SELECT policy makes the bucket unlistable even to its owner.
    expect(ALL_POLICIES.map((policy) => audienceOf(policy).verb).sort()).toEqual([
      "delete",
      "insert",
      "select",
      "update",
    ]);
  });

  it("a bare filename with no owner segment can never be produced by the builder", () => {
    // The policy denies it (foldername('bare.jpg') is {}, so [1] is NULL and a
    // NULL predicate is not true). This asserts the builder never asks it to.
    expect(newAvatarObjectPath(OWNER)).toContain("/");
    expect(newAvatarObjectPath(OWNER).startsWith("/")).toBe(false);
  });
});

describe("what the app stores is what the bucket accepts", () => {
  it("CRITICAL: the canonical content type is on the bucket's allowlist", () => {
    // Every upload is re-encoded to one format before it is stored. If that
    // format is not in allowed_mime_types, every upload 400s at the Storage API
    // and nothing in TypeScript would have said so.
    expect(bucketRow.mimeTypes).toContain(AVATAR_CANONICAL_MIME_TYPE);
  });

  it("the formats the form accepts are exactly the formats the bucket allows", () => {
    expect([...AVATAR_ACCEPTED_MIME_TYPES].sort()).toEqual([...bucketRow.mimeTypes].sort());
  });

  it("CRITICAL: the size ceiling the app believes in is the bucket's own number", () => {
    expect(AVATAR_BUCKET_MAX_BYTES).toBe(bucketRow.fileSizeLimit);
  });

  it("records the reviewed bucket settings, so widening them is a visible change", () => {
    expect(bucketRow).toMatchObject({
      id: "avatars",
      name: "avatars",
      isPublic: true,
      fileSizeLimit: 2 * 1024 * 1024,
    });
    expect(bucketRow.mimeTypes).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it("does not allow SVG, which would be a script-bearing document on a public origin", () => {
    expect(bucketRow.mimeTypes).not.toContain("image/svg+xml");
    expect(AVATAR_ACCEPTED_MIME_TYPES).not.toContain("image/svg+xml");
  });
});

// THE THIRD AGREEMENT, and the one that was missing.
//
// Next.js caps a Server Action's request body at 1 MB by default
// (`defaultActionBodySizeLimit = '1 MB'` in
// node_modules/next/dist/build/templates/app-page.js) and answers anything
// larger with a 413 BEFORE the action function is entered. The avatar upload
// goes through a Server Action carrying a File, so every photo between 1 MB and
// AVATAR_MAX_UPLOAD_BYTES was killed by the framework and the action's own size
// check - and its "larger than 8 MB" copy - could never be reached. A constant
// in avatar.ts and a limit in next.config.ts are two files that have to agree,
// so they are asserted against each other rather than each on its own.
describe("the configured Server Action body limit admits the file the app accepts", () => {
  const configured = nextConfig.experimental?.serverActions?.bodySizeLimit;

  it("CRITICAL: next.config.ts raises the limit at all", () => {
    // Without this the framework's 1 MB default applies and a normal phone
    // photo 413s before saveConsumerAvatar runs.
    expect(configured).toBeDefined();
  });

  it("CRITICAL: the configured limit is at least the largest file the action accepts", () => {
    expect(typeof configured).toBe("number");
    expect(configured as number).toBeGreaterThanOrEqual(AVATAR_MAX_UPLOAD_BYTES);
  });

  it("uses the constant rather than a number that merely happens to match today", () => {
    expect(configured).toBe(AVATAR_ACTION_BODY_LIMIT_BYTES);
  });

  it("leaves envelope headroom above the file itself", () => {
    // The body is a multipart action payload, not the raw bytes: boundaries,
    // headers and the action id ride along. A limit set exactly at the file size
    // would 413 a file that is exactly at the file size.
    expect(AVATAR_ACTION_BODY_LIMIT_BYTES).toBeGreaterThan(AVATAR_MAX_UPLOAD_BYTES);
  });

  it("CRITICAL: is comfortably above the 4-6MB phone photo the comment promises", () => {
    // avatar.ts justifies AVATAR_MAX_UPLOAD_BYTES by saying a photo straight off
    // a phone camera is routinely 4-6MB. This asserts the promise is keepable.
    expect(AVATAR_MAX_UPLOAD_BYTES).toBeGreaterThanOrEqual(6 * 1024 * 1024);
    expect(configured as number).toBeGreaterThanOrEqual(6 * 1024 * 1024);
  });
});

describe("newAvatarObjectPath", () => {
  it("names the object with a fresh uuid, never with anything the consumer supplied", () => {
    const filename = newAvatarObjectPath(OWNER).split("/")[1] ?? "";
    const stem = filename.replace(`.${AVATAR_CANONICAL_EXTENSION}`, "");

    expect(filename.endsWith(`.${AVATAR_CANONICAL_EXTENSION}`)).toBe(true);
    expect(stem).toMatch(UUID_V4);
  });

  it("CRITICAL: a replace gets a NEW name, so no CDN edge can serve the old face", () => {
    expect(newAvatarObjectPath(OWNER)).not.toBe(newAvatarObjectPath(OWNER));
  });
});

describe("objectPathFromPublicUrl", () => {
  const BASE = "https://zlfxfzlnklqhajacngxf.supabase.co/storage/v1/object/public/avatars";

  it("recovers the object path from the stored public URL", () => {
    // This is what makes "replace" and "remove" able to delete the PREVIOUS
    // object rather than orphaning it: profiles.avatar_url holds a URL, and the
    // storage delete call needs the path inside the bucket.
    expect(objectPathFromPublicUrl(`${BASE}/${OWNER}/abc.jpg`)).toBe(`${OWNER}/abc.jpg`);
  });

  it("drops a cache-busting query string", () => {
    expect(objectPathFromPublicUrl(`${BASE}/${OWNER}/abc.jpg?t=123`)).toBe(`${OWNER}/abc.jpg`);
  });

  it("returns null for a URL that is not in this bucket, so nothing else is ever deleted", () => {
    expect(
      objectPathFromPublicUrl(
        "https://zlfxfzlnklqhajacngxf.supabase.co/storage/v1/object/public/receipts/x/y.jpg",
      ),
    ).toBeNull();
    expect(objectPathFromPublicUrl("https://lh3.googleusercontent.com/a/photo.jpg")).toBeNull();
    expect(objectPathFromPublicUrl(null)).toBeNull();
    expect(objectPathFromPublicUrl("")).toBeNull();
  });

  it("returns null when the URL points at the bucket root with no object", () => {
    expect(objectPathFromPublicUrl(`${BASE}/`)).toBeNull();
    expect(objectPathFromPublicUrl(BASE)).toBeNull();
  });
});

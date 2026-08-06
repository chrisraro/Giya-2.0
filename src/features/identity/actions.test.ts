import { describe, it, expect, vi, beforeEach } from "vitest";

import { oversizePhotoMessage } from "./avatar";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  citiesSelect: vi.fn(),
  citiesIlike: vi.fn(),
  citiesMaybeSingle: vi.fn(),
  consumersUpdate: vi.fn(),
  consumersEq: vi.fn(),
  profilesUpdate: vi.fn(),
  profilesEq: vi.fn(),
  profilesSelect: vi.fn(),
  profilesSelectEq: vi.fn(),
  profilesMaybeSingle: vi.fn(),
  storageFrom: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  getPublicUrl: vi.fn(),
  revalidatePath: vi.fn(),
  canonicalizeAvatarImage: vi.fn(),
  sniffImageFormat: vi.fn(),
  registerDevice: vi.fn(),
  deleteDevice: vi.fn(),
  signOutFn: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser, signOut: mocks.signOutFn },
    from: mocks.from,
    rpc: mocks.rpc,
    storage: { from: mocks.storageFrom },
  })),
}));

// The device module's own SQL and identity rule are covered in
// server/devices.test.ts. Here it is a seam, so the actions' product behaviour
// on top of it - what a revoke does to the SESSION - is what gets asserted.
vi.mock("./server/devices", () => ({
  registerDevice: mocks.registerDevice,
  deleteDevice: mocks.deleteDevice,
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

// The sharp re-encode is faked here so this file never loads a native module.
// Its own behaviour - and the EXIF strip the public bucket depends on - is
// covered against real bytes in server/avatar-image.test.ts.
vi.mock("./server/avatar-image", () => ({
  canonicalizeAvatarImage: mocks.canonicalizeAvatarImage,
  sniffImageFormat: mocks.sniffImageFormat,
}));

const {
  CONSENT_SAVE_FAILED,
  DEVICE_REMOVE_FAILED,
  PHOTO_REMOVE_FAILED,
  PHOTO_SAVE_FAILED,
  PROFILE_SAVE_FAILED,
} = await import("./messages");

const {
  completeConsumerOnboarding,
  registerBusiness,
  registerCurrentDevice,
  removeConsumerAvatar,
  revokeDevice,
  saveConsent,
  saveConsumerAvatar,
  saveConsumerProfile,
} = await import("./actions");

/**
 * The infrastructure failures below are logged on purpose, so the console is
 * silenced and inspected rather than left to spray Postgres text through the
 * test output. Two assertions read `consoleError.mock.calls` directly: mapping
 * the copy must not mean losing the diagnosis.
 */
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

const AUTH_USER = { id: "user-1" };

const PUBLIC_BASE = "https://proj.supabase.co/storage/v1/object/public/avatars";
const OLD_AVATAR_URL = `${PUBLIC_BASE}/user-1/old-object.jpg`;
const NEW_PUBLIC_URL = `${PUBLIC_BASE}/user-1/new-object.jpg`;

const ORIGINAL_BYTES = new Uint8Array([1, 2, 3, 4]);
const CANONICAL_BYTES = new Uint8Array([9, 9, 9]);

function mockAuthed() {
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });
}

function mockUnauthenticated() {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
}

/**
 * A FormData carrying one picked file, the way the edit form submits it.
 *
 * The declared type defaults to **image/png**, deliberately. It used to default
 * to image/jpeg, which is the same string as AVATAR_CANONICAL_MIME_TYPE - so
 * "the upload is tagged with the canonical type" was green for
 * `contentType: file.type` too, and the assertion could not tell "we set the
 * canonical type" from "we echo whatever the browser claimed". A png fixture
 * separates them. The re-encode makes it a JPEG either way, which is the point.
 */
function avatarForm(
  bytes: Uint8Array = ORIGINAL_BYTES,
  { type = "image/png", name = "me.png" } = {},
): FormData {
  const form = new FormData();
  form.set("avatar", new File([bytes as unknown as BlobPart], name, { type }));
  return form;
}

/** The object path the action asked storage to write. */
function uploadedPath(): string {
  return mocks.upload.mock.calls[0]?.[0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.citiesMaybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.citiesIlike.mockReturnValue({ maybeSingle: mocks.citiesMaybeSingle });
  mocks.citiesSelect.mockReturnValue({ ilike: mocks.citiesIlike });

  mocks.consumersEq.mockResolvedValue({ error: null });
  mocks.consumersUpdate.mockReturnValue({ eq: mocks.consumersEq });

  mocks.profilesEq.mockResolvedValue({ error: null });
  mocks.profilesUpdate.mockReturnValue({ eq: mocks.profilesEq });

  mocks.profilesMaybeSingle.mockResolvedValue({ data: { avatar_url: null }, error: null });
  mocks.profilesSelectEq.mockReturnValue({ maybeSingle: mocks.profilesMaybeSingle });
  mocks.profilesSelect.mockReturnValue({ eq: mocks.profilesSelectEq });

  mocks.upload.mockResolvedValue({ data: { path: "x" }, error: null });
  mocks.remove.mockResolvedValue({ data: [], error: null });
  mocks.getPublicUrl.mockReturnValue({ data: { publicUrl: NEW_PUBLIC_URL } });
  mocks.storageFrom.mockReturnValue({
    upload: mocks.upload,
    remove: mocks.remove,
    getPublicUrl: mocks.getPublicUrl,
  });

  mocks.canonicalizeAvatarImage.mockResolvedValue(CANONICAL_BYTES);
  mocks.sniffImageFormat.mockReturnValue("jpeg");

  mocks.rpc.mockResolvedValue({ data: "business-1", error: null });

  mocks.registerDevice.mockResolvedValue(undefined);
  mocks.deleteDevice.mockResolvedValue({ ok: true, wasCurrent: false });
  mocks.signOutFn.mockResolvedValue({ error: null });

  mocks.from.mockImplementation((table: string) => {
    if (table === "ref_cities") return { select: mocks.citiesSelect };
    if (table === "consumers") return { update: mocks.consumersUpdate };
    if (table === "profiles") return { update: mocks.profilesUpdate, select: mocks.profilesSelect };
    throw new Error(`unexpected table: ${table}`);
  });
});

describe("completeConsumerOnboarding", () => {
  it("resolves city_id by name and updates the consumer + profile rows", async () => {
    mockAuthed();
    mocks.citiesMaybeSingle.mockResolvedValue({ data: { id: "city-1" }, error: null });

    const result = await completeConsumerOnboarding({ cityName: "Cebu", pushEnabled: true });

    expect(result).toEqual({ ok: true });
    expect(mocks.citiesSelect).toHaveBeenCalledWith("id");
    expect(mocks.citiesIlike).toHaveBeenCalledWith("name", "Cebu");
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ city_id: "city-1", push_enabled: true });
    expect(mocks.consumersEq).toHaveBeenCalledWith("id", "user-1");
    expect(mocks.profilesUpdate).toHaveBeenCalledWith({ onboarded_at: expect.any(String) });
    expect(mocks.profilesEq).toHaveBeenCalledWith("id", "user-1");
  });

  it("resolves an unknown city name to a null city_id but still succeeds", async () => {
    mockAuthed();
    mocks.citiesMaybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await completeConsumerOnboarding({
      cityName: "Nowhereville",
      pushEnabled: false,
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ city_id: null, push_enabled: false });
  });

  it("skips the city lookup entirely when no city was chosen", async () => {
    mockAuthed();

    const result = await completeConsumerOnboarding({ cityName: null, pushEnabled: false });

    expect(result).toEqual({ ok: true });
    expect(mocks.citiesSelect).not.toHaveBeenCalled();
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ city_id: null, push_enabled: false });
  });

  it("returns ok:false without touching any table when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await completeConsumerOnboarding({ cityName: "Cebu", pushEnabled: true });

    expect(result.ok).toBe(false);
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
  });

  it("returns ok:false with the db message when the consumers update fails", async () => {
    mockAuthed();
    mocks.consumersEq.mockResolvedValue({ error: { message: "update failed" } });

    const result = await completeConsumerOnboarding({ cityName: null, pushEnabled: true });

    expect(result).toEqual({ ok: false, message: "update failed" });
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
  });
});

describe("registerBusiness", () => {
  it("calls the register_business rpc with the mapped args", async () => {
    mockAuthed();

    const result = await registerBusiness({
      name: "Kape Diaria",
      type: "Cafe",
      city: "Cebu",
      address: "123 Mango Ave",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith("register_business", {
      p_name: "Kape Diaria",
      p_type: "Cafe",
      p_city: "Cebu",
      p_address: "123 Mango Ave",
    });
  });

  it("returns ok:false without calling the rpc when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await registerBusiness({
      name: "Kape Diaria",
      type: "Cafe",
      city: "Cebu",
      address: "123 Mango Ave",
    });

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns ok:false with the db message when the rpc errors", async () => {
    mockAuthed();
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "duplicate business" } });

    const result = await registerBusiness({
      name: "Kape Diaria",
      type: "Cafe",
      city: "Cebu",
      address: "123 Mango Ave",
    });

    expect(result).toEqual({ ok: false, message: "duplicate business" });
  });
});

// ===========================================================================
// T3.4a: the profile edit surface. /profile has been read-only since it was
// built - it renders the display name, email and city and offers no way to
// change any of them - and profiles.avatar_url has existed since 0002 with zero
// writers and no bucket to write into.
// ===========================================================================

describe("saveConsumerProfile", () => {
  it("writes the name and resolves the city name to a city_id", async () => {
    mockAuthed();
    mocks.citiesMaybeSingle.mockResolvedValue({ data: { id: "city-1" }, error: null });

    const result = await saveConsumerProfile({ displayName: "Ana Cruz", cityName: "Cebu City" });

    expect(result).toEqual({ ok: true });
    expect(mocks.profilesUpdate).toHaveBeenCalledWith({ display_name: "Ana Cruz" });
    expect(mocks.profilesEq).toHaveBeenCalledWith("id", "user-1");
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ city_id: "city-1" });
    expect(mocks.consumersEq).toHaveBeenCalledWith("id", "user-1");
  });

  it("CRITICAL: writes only the two columns 0021 already grants, and no others", async () => {
    // 0021 deliberately withheld scan_blocked_until, last_scan_at,
    // lifetime_points_earned, referral_code, referred_by and is_suspended.
    // Widening this payload is a money-path defect, not a convenience.
    mockAuthed();
    mocks.citiesMaybeSingle.mockResolvedValue({ data: { id: "city-1" }, error: null });

    await saveConsumerProfile({ displayName: "Ana", cityName: "Cebu City" });

    expect(Object.keys(mocks.profilesUpdate.mock.calls[0]?.[0] ?? {})).toEqual(["display_name"]);
    expect(Object.keys(mocks.consumersUpdate.mock.calls[0]?.[0] ?? {})).toEqual(["city_id"]);
  });

  it("trims the name before it reaches the column", async () => {
    mockAuthed();

    await saveConsumerProfile({ displayName: "   Ana Cruz  ", cityName: null });

    expect(mocks.profilesUpdate).toHaveBeenCalledWith({ display_name: "Ana Cruz" });
  });

  it("refuses a name past the database bound WITHOUT spending a round trip", async () => {
    mockAuthed();

    const result = await saveConsumerProfile({ displayName: "a".repeat(81), cityName: null });

    expect(result.ok).toBe(false);
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("refuses an empty name with a message that does not accuse anyone", async () => {
    mockAuthed();

    const result = await saveConsumerProfile({ displayName: "  ", cityName: null });

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.message;
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toMatch(/invalid|you failed/i);
  });

  it("skips the city lookup entirely when there is no city", async () => {
    mockAuthed();

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: null });

    expect(result).toEqual({ ok: true });
    expect(mocks.citiesSelect).not.toHaveBeenCalled();
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ city_id: null });
  });

  it("CRITICAL: refuses rather than quietly saving 'no city' over the one just picked", async () => {
    // completeConsumerOnboarding tolerates an unknown city and stores null,
    // because onboarding must never be blocked. This surface is the opposite:
    // the consumer is here to CHANGE something, and a save that reports success
    // while dropping their answer is worse than one that says it failed.
    mockAuthed();
    mocks.citiesMaybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: "Atlantis" });

    expect(result.ok).toBe(false);
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("does not touch consumers when the profiles write fails", async () => {
    mockAuthed();
    mocks.profilesEq.mockResolvedValue({ error: { message: "profiles is unhappy" } });

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: null });

    expect(result).toEqual({ ok: false, message: PROFILE_SAVE_FAILED });
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("reports a failed city write too", async () => {
    mockAuthed();
    mocks.consumersEq.mockResolvedValue({ error: { message: "consumers is unhappy" } });

    expect(await saveConsumerProfile({ displayName: "Ana", cityName: null })).toEqual({
      ok: false,
      message: PROFILE_SAVE_FAILED,
    });
  });

  it("CRITICAL: never renders raw Postgres text at the consumer", async () => {
    // `toErrorMessage(dbError)` passes the database's own message through
    // verbatim, so a real RLS refusal rendered
    //   new row violates row-level security policy for table "objects"
    // and a check violation rendered the constraint name. That leaks schema and
    // it is not a sentence anybody can act on.
    mockAuthed();
    mocks.profilesEq.mockResolvedValue({
      error: {
        message: 'new row violates row-level security policy for table "objects"',
        code: "42501",
      },
    });

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: null });

    const message = result.ok ? "" : result.message;
    expect(message).toBe(PROFILE_SAVE_FAILED);
    expect(message).not.toMatch(/row-level security|constraint|policy|table "/i);
  });

  it("CRITICAL: keeps the raw detail in the server log, where it is useful", async () => {
    // Mapping the copy must not mean losing the diagnosis.
    mockAuthed();
    const raw = { message: 'violates check constraint "profiles_display_name_check"' };
    mocks.profilesEq.mockResolvedValue({ error: raw });

    await saveConsumerProfile({ displayName: "Ana", cityName: null });

    expect(consoleError).toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).toContain("profiles_display_name_check");
  });

  it("CRITICAL: an EMPTY server message becomes real copy, never a blank alert", async () => {
    // The live bug toErrorMessage exists for. `message ?? FALLBACK` does not
    // catch "" - `??` only catches null and undefined - so the alert node
    // renders nothing at all and the screen looks like it did nothing. Now
    // closed by construction: the copy is a constant, so no server string
    // reaches the alert at all.
    mockAuthed();
    mocks.profilesEq.mockResolvedValue({ error: { message: "" } });

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: null });

    expect(result).toEqual({ ok: false, message: PROFILE_SAVE_FAILED });
    expect(PROFILE_SAVE_FAILED.length).toBeGreaterThan(0);
  });

  it("reports a failed city LOOKUP without leaking the query error", async () => {
    mockAuthed();
    mocks.citiesMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'relation "ref_cities" does not exist' },
    });

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: "Cebu City" });

    expect(result).toEqual({ ok: false, message: PROFILE_SAVE_FAILED });
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
  });

  it("returns ok:false without touching any table when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: "Cebu City" });

    expect(result.ok).toBe(false);
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("revalidates the profile surfaces on success and not on failure", async () => {
    mockAuthed();
    await saveConsumerProfile({ displayName: "Ana", cityName: null });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/profile");

    mocks.revalidatePath.mockClear();
    mocks.profilesEq.mockResolvedValue({ error: { message: "nope" } });
    await saveConsumerProfile({ displayName: "Ana", cityName: null });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("saveConsumerAvatar", () => {
  it("uploads and points profiles.avatar_url at the public URL", async () => {
    mockAuthed();

    const result = await saveConsumerAvatar(avatarForm());

    expect(result).toEqual({ ok: true, avatarUrl: NEW_PUBLIC_URL });
    expect(mocks.storageFrom).toHaveBeenCalledWith("avatars");
    expect(mocks.profilesUpdate).toHaveBeenCalledWith({ avatar_url: NEW_PUBLIC_URL });
  });

  it("CRITICAL: writes under the caller's OWN uid segment, one level deep", async () => {
    // This is the client half of the agreement 0064's insert policy enforces:
    // `(storage.foldername(name))[1] = auth.uid()` and
    // `array_length(foldername(name), 1) = 1`. avatar.test.ts asserts the
    // builder against the migration's predicates; this asserts the ACTION uses
    // the builder rather than assembling a path of its own.
    mockAuthed();

    await saveConsumerAvatar(avatarForm());

    const segments = uploadedPath().split("/");
    expect(segments[0]).toBe(AUTH_USER.id);
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatch(/^[0-9a-f-]{36}\.jpg$/i);
  });

  it("CRITICAL: stores the RE-ENCODED bytes, never the ones the consumer picked", async () => {
    // The public bucket rests on this: the original may carry an EXIF GPS tag.
    mockAuthed();

    await saveConsumerAvatar(avatarForm());

    expect(mocks.canonicalizeAvatarImage).toHaveBeenCalled();
    expect(mocks.upload.mock.calls[0]?.[1]).toBe(CANONICAL_BYTES);
    expect(mocks.upload.mock.calls[0]?.[1]).not.toBe(ORIGINAL_BYTES);
  });

  it("CRITICAL: tags the object with the CANONICAL type, not the browser's claim", async () => {
    // The fixture declares image/png and the stored object is always a JPEG. If
    // the action echoed `file.type` the object would be served as image/png
    // while holding JPEG bytes - and, worse, the assertion would pass for a
    // jpeg-declaring fixture, which is exactly how this one was green before.
    mockAuthed();

    await saveConsumerAvatar(avatarForm(ORIGINAL_BYTES, { type: "image/png" }));

    expect(mocks.upload.mock.calls[0]?.[2]).toMatchObject({ contentType: "image/jpeg" });
  });

  it("decides the format by sniffing bytes, not by trusting the declared type", async () => {
    // The Content-Type on the multipart part is whatever the browser sent.
    mockAuthed();
    mocks.sniffImageFormat.mockReturnValue(null);

    const result = await saveConsumerAvatar(avatarForm(ORIGINAL_BYTES, { type: "image/jpeg" }));

    expect(result.ok).toBe(false);
    expect(mocks.canonicalizeAvatarImage).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("refuses a file past the upload ceiling without reading it", async () => {
    mockAuthed();
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);

    const result = await saveConsumerAvatar(avatarForm(huge));

    expect(result.ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
    // THE AGREEMENT, not each side. `oversizePhotoMessage()` exists so the
    // form's check and this backstop quote the same sentence and the same
    // number; asserting only `ok === false` here leaves the action free to
    // invent its own copy while the helper sits there unused. The form's twin
    // of this assertion is in profile-edit-form.test.tsx, against the same
    // helper - between them, both call sites are pinned to it.
    expect(result.ok ? "" : result.message).toBe(oversizePhotoMessage());
  });

  it("says so when no file was picked", async () => {
    mockAuthed();

    const result = await saveConsumerAvatar(new FormData());

    expect(result.ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("turns an undecodable photo into a sentence rather than a crash", async () => {
    mockAuthed();
    mocks.canonicalizeAvatarImage.mockRejectedValue(new Error("VipsJpeg: premature end"));

    const result = await saveConsumerAvatar(avatarForm());

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toMatch(/could not read that photo/i);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("CRITICAL: a replace deletes the object it replaced, so nothing is orphaned", async () => {
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { avatar_url: OLD_AVATAR_URL },
      error: null,
    });

    await saveConsumerAvatar(avatarForm());

    expect(mocks.remove).toHaveBeenCalledWith(["user-1/old-object.jpg"]);
  });

  it("CRITICAL: repoints the row BEFORE deleting the old object", async () => {
    // Order is the whole safety property: a failure between the two leaves an
    // orphaned object (costs storage) rather than a profile pointing at a hole
    // (a broken avatar on somebody's own page).
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { avatar_url: OLD_AVATAR_URL },
      error: null,
    });

    await saveConsumerAvatar(avatarForm());

    const updatedAt = mocks.profilesUpdate.mock.invocationCallOrder[0] ?? Infinity;
    const removedAt = mocks.remove.mock.invocationCallOrder[0] ?? -Infinity;
    expect(updatedAt).toBeLessThan(removedAt);
  });

  it("CRITICAL: reads the OLD url BEFORE anything is written", async () => {
    // The other half of the ordering rule, and the one that was unasserted.
    // Moving the read to just before the cleanup keeps every other assertion
    // green - the fake returns the same url whenever it is called - while in
    // production it would read the url that was just written and delete the
    // object it just uploaded, leaving profiles.avatar_url pointing at a hole on
    // EVERY upload. The fake cannot notice; the call order can.
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { avatar_url: OLD_AVATAR_URL },
      error: null,
    });

    await saveConsumerAvatar(avatarForm());

    const readAt = mocks.profilesSelect.mock.invocationCallOrder[0] ?? Infinity;
    const uploadedAt = mocks.upload.mock.invocationCallOrder[0] ?? -Infinity;
    const updatedAt = mocks.profilesUpdate.mock.invocationCallOrder[0] ?? -Infinity;

    expect(readAt).toBeLessThan(uploadedAt);
    expect(readAt).toBeLessThan(updatedAt);
  });

  it("deletes nothing when this is the consumer's first avatar", async () => {
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({ data: { avatar_url: null }, error: null });

    await saveConsumerAvatar(avatarForm());

    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("never deletes an object that is not ours, even if avatar_url points elsewhere", async () => {
    // An OAuth provider's avatar URL, or anything else that is not in this
    // bucket, resolves to no path and is left alone.
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { avatar_url: "https://lh3.googleusercontent.com/a/photo.jpg" },
      error: null,
    });

    await saveConsumerAvatar(avatarForm());

    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("CRITICAL: cleans up the NEW object when the row write fails", async () => {
    // Otherwise a failed save leaves a public, unreferenced copy of the photo.
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { avatar_url: OLD_AVATAR_URL },
      error: null,
    });
    mocks.profilesEq.mockResolvedValue({ error: { message: "row write failed" } });

    const result = await saveConsumerAvatar(avatarForm());

    expect(result).toEqual({ ok: false, message: PHOTO_SAVE_FAILED });
    expect(mocks.remove).toHaveBeenCalledWith(["user-1/new-object.jpg"]);
    expect(mocks.remove).not.toHaveBeenCalledWith(["user-1/old-object.jpg"]);
  });

  it("does not touch the row when the upload itself fails", async () => {
    mockAuthed();
    mocks.upload.mockResolvedValue({ data: null, error: { message: "bucket said no" } });

    const result = await saveConsumerAvatar(avatarForm());

    expect(result).toEqual({ ok: false, message: PHOTO_SAVE_FAILED });
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
  });

  it("CRITICAL: never renders raw Storage text at the consumer", async () => {
    // The storage layer's refusals are the worst strings in the set: an RLS
    // denial on `storage.objects` names the schema, the table and the policy.
    mockAuthed();
    mocks.upload.mockResolvedValue({
      data: null,
      error: { message: 'new row violates row-level security policy for table "objects"' },
    });

    const result = await saveConsumerAvatar(avatarForm());

    const message = result.ok ? "" : result.message;
    expect(message).toBe(PHOTO_SAVE_FAILED);
    expect(message).not.toMatch(/row-level security|storage|objects|policy/i);
    expect(JSON.stringify(consoleError.mock.calls)).toContain("row-level security");
  });

  it("renders real copy for an EMPTY storage error message", async () => {
    mockAuthed();
    mocks.upload.mockResolvedValue({ data: null, error: { message: "" } });

    expect(await saveConsumerAvatar(avatarForm())).toEqual({
      ok: false,
      message: PHOTO_SAVE_FAILED,
    });
  });

  it("uploads nothing when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await saveConsumerAvatar(avatarForm());

    expect(result.ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe("removeConsumerAvatar", () => {
  it("CRITICAL: clears the column AND deletes the public object", async () => {
    // The bucket is public and CDN-served. Clearing the row without deleting
    // leaves a permanently-fetchable copy of a face somebody just took down, so
    // "remove" would not mean removed.
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { avatar_url: OLD_AVATAR_URL },
      error: null,
    });

    const result = await removeConsumerAvatar();

    expect(result).toEqual({ ok: true, avatarUrl: null });
    expect(mocks.profilesUpdate).toHaveBeenCalledWith({ avatar_url: null });
    expect(mocks.remove).toHaveBeenCalledWith(["user-1/old-object.jpg"]);
  });

  it("is idempotent: removing an avatar that is not there writes nothing", async () => {
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({ data: { avatar_url: null }, error: null });

    expect(await removeConsumerAvatar()).toEqual({ ok: true, avatarUrl: null });
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("keeps the object when the row could not be cleared", async () => {
    // Deleting first would leave the row pointing at a hole.
    mockAuthed();
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { avatar_url: OLD_AVATAR_URL },
      error: null,
    });
    mocks.profilesEq.mockResolvedValue({ error: { message: "could not clear" } });

    const result = await removeConsumerAvatar();

    expect(result).toEqual({ ok: false, message: PHOTO_REMOVE_FAILED });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes nothing when unauthenticated", async () => {
    mockUnauthenticated();

    expect((await removeConsumerAvatar()).ok).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// saveConsent - one toggle, one column.
//
// THE ASSERTION THAT MATTERS IS THE RELATIONSHIP, not either side of it. A
// test that flips a control and checks "the action was called" stays green when
// all four toggles are wired to the same column. So every column name below is
// written as a LITERAL and matched against the update payload the action
// actually builds; the component test does the other half of the chain (label
// -> column name) with the same four literals.
//
// Four columns, four assertions. Copying one correct assertion's code without
// its three siblings is the exact shape that has shipped broken here before.
// ===========================================================================
describe("saveConsent", () => {
  it("CRITICAL: marketing_opt_in writes marketing_opt_in and no other column", async () => {
    mockAuthed();

    const result = await saveConsent("marketing_opt_in", true);

    expect(result).toEqual({ ok: true });
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ marketing_opt_in: true });
    expect(mocks.consumersEq).toHaveBeenCalledWith("id", "user-1");
  });

  it("CRITICAL: push_enabled writes push_enabled and no other column", async () => {
    mockAuthed();

    const result = await saveConsent("push_enabled", false);

    expect(result).toEqual({ ok: true });
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ push_enabled: false });
  });

  it("CRITICAL: email_enabled writes email_enabled and no other column", async () => {
    mockAuthed();

    const result = await saveConsent("email_enabled", false);

    expect(result).toEqual({ ok: true });
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ email_enabled: false });
  });

  it("CRITICAL: gps_fraud_opt_in writes gps_fraud_opt_in and no other column", async () => {
    mockAuthed();

    const result = await saveConsent("gps_fraud_opt_in", true);

    expect(result).toEqual({ ok: true });
    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ gps_fraud_opt_in: true });
  });

  it("writes the value it was given, in both directions", async () => {
    mockAuthed();

    await saveConsent("marketing_opt_in", false);

    expect(mocks.consumersUpdate).toHaveBeenCalledWith({ marketing_opt_in: false });
  });

  it("CRITICAL: refuses a column outside 0021's fence without writing anything", async () => {
    // A server action is a public endpoint, and this one builds its payload
    // from a caller-supplied key. `scan_blocked_until` is the column 0021
    // exists to keep a consumer's hands off - doc 37's ladder step 2.
    mockAuthed();

    const result = await saveConsent("scan_blocked_until", false);

    expect(result.ok).toBe(false);
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("refuses is_suspended too, and every other name that is not one of the four", async () => {
    mockAuthed();

    for (const column of ["is_suspended", "city_id", "lifetime_points_earned", ""]) {
      expect((await saveConsent(column, true)).ok).toBe(false);
    }
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("CRITICAL: a database refusal becomes our sentence, never Postgres's", async () => {
    mockAuthed();
    mocks.consumersEq.mockResolvedValue({
      error: { message: 'permission denied for column "marketing_opt_in" of relation consumers' },
    });

    const result = await saveConsent("marketing_opt_in", true);

    expect(result).toEqual({ ok: false, message: CONSENT_SAVE_FAILED });
    // The detail is not lost - it goes where somebody can act on it.
    expect(consoleError.mock.calls.flat().join(" ")).toContain("permission denied for column");
  });

  it("writes nothing when unauthenticated", async () => {
    mockUnauthenticated();

    expect((await saveConsent("push_enabled", false)).ok).toBe(false);
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("revalidates the settings screen so a later render is not stale", async () => {
    mockAuthed();

    await saveConsent("email_enabled", false);

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/profile/settings");
  });
});

// ===========================================================================
// The device actions. The identity rule and the SQL they issue are covered in
// server/devices.test.ts; what is pinned here is the product behaviour the
// actions own on top of it.
// ===========================================================================
describe("registerCurrentDevice", () => {
  it("registers the device of whoever is signing in", async () => {
    await registerCurrentDevice();

    expect(mocks.registerDevice).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: never throws, because it runs on the sign-in path", async () => {
    // A device row that could not be written is not a reason to fail a login,
    // and there is nothing the person signing in could do about it anyway.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.registerDevice.mockRejectedValue(new Error("ECONNRESET"));

    await expect(registerCurrentDevice()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("revokeDevice", () => {
  it("removes another device and reports that no session ended", async () => {
    mocks.deleteDevice.mockResolvedValue({ ok: true, wasCurrent: false });

    expect(await revokeDevice("device-2")).toEqual({ ok: true, signedOut: false });
    expect(mocks.deleteDevice).toHaveBeenCalledWith("device-2");
  });

  it("CRITICAL: removing ANOTHER device does not sign the caller out", async () => {
    // Deleting a user_devices row does not invalidate that browser's session -
    // the refresh token lives in GoTrue, not this table. Signing the caller out
    // of their OWN session for it would be the wrong session entirely.
    mocks.deleteDevice.mockResolvedValue({ ok: true, wasCurrent: false });

    await revokeDevice("device-2");

    expect(mocks.signOutFn).not.toHaveBeenCalled();
  });

  it("CRITICAL: removing THIS device really ends this session", async () => {
    // Revoking the device you are holding is a foreseeable tap, and it is the
    // one case where the app CAN make "revoked" mean something to the session
    // as well as to the row. It does, rather than leaving a browser signed in
    // against a device row it no longer has.
    mocks.deleteDevice.mockResolvedValue({ ok: true, wasCurrent: true });

    expect(await revokeDevice("device-1")).toEqual({ ok: true, signedOut: true });
    expect(mocks.signOutFn).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: a failed delete says so and signs nobody out", async () => {
    mocks.deleteDevice.mockResolvedValue({ ok: false });

    expect(await revokeDevice("device-2")).toEqual({
      ok: false,
      message: DEVICE_REMOVE_FAILED,
    });
    expect(mocks.signOutFn).not.toHaveBeenCalled();
  });

  it("revalidates the device list so the removed row does not linger", async () => {
    mocks.deleteDevice.mockResolvedValue({ ok: true, wasCurrent: false });

    await revokeDevice("device-2");

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/profile/devices");
  });

  it("does not revalidate a list it failed to change", async () => {
    mocks.deleteDevice.mockResolvedValue({ ok: false });

    await revokeDevice("device-2");

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
    rpc: mocks.rpc,
    storage: { from: mocks.storageFrom },
  })),
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
  completeConsumerOnboarding,
  registerBusiness,
  removeConsumerAvatar,
  saveConsumerAvatar,
  saveConsumerProfile,
} = await import("./actions");

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

/** A FormData carrying one picked file, the way the edit form submits it. */
function avatarForm(
  bytes: Uint8Array = ORIGINAL_BYTES,
  { type = "image/jpeg", name = "me.jpg" } = {},
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

    expect(result).toEqual({ ok: false, message: "profiles is unhappy" });
    expect(mocks.consumersUpdate).not.toHaveBeenCalled();
  });

  it("surfaces a failed city write specifically", async () => {
    mockAuthed();
    mocks.consumersEq.mockResolvedValue({ error: { message: "consumers is unhappy" } });

    expect(await saveConsumerProfile({ displayName: "Ana", cityName: null })).toEqual({
      ok: false,
      message: "consumers is unhappy",
    });
  });

  it("CRITICAL: an EMPTY server message becomes real copy, never a blank alert", async () => {
    // The live bug toErrorMessage exists for. `message ?? FALLBACK` does not
    // catch "" - `??` only catches null and undefined - so the alert node
    // renders nothing at all and the screen looks like it did nothing.
    mockAuthed();
    mocks.profilesEq.mockResolvedValue({ error: { message: "" } });

    const result = await saveConsumerProfile({ displayName: "Ana", cityName: null });

    expect(result).toEqual({ ok: false, message: "Something went wrong. Please try again." });
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

    expect(result).toEqual({ ok: false, message: "row write failed" });
    expect(mocks.remove).toHaveBeenCalledWith(["user-1/new-object.jpg"]);
    expect(mocks.remove).not.toHaveBeenCalledWith(["user-1/old-object.jpg"]);
  });

  it("does not touch the row when the upload itself fails", async () => {
    mockAuthed();
    mocks.upload.mockResolvedValue({ data: null, error: { message: "bucket said no" } });

    const result = await saveConsumerAvatar(avatarForm());

    expect(result).toEqual({ ok: false, message: "bucket said no" });
    expect(mocks.profilesUpdate).not.toHaveBeenCalled();
  });

  it("renders the generic copy for an EMPTY storage error message", async () => {
    mockAuthed();
    mocks.upload.mockResolvedValue({ data: null, error: { message: "" } });

    expect(await saveConsumerAvatar(avatarForm())).toEqual({
      ok: false,
      message: "Something went wrong. Please try again.",
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

    expect(result).toEqual({ ok: false, message: "could not clear" });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes nothing when unauthenticated", async () => {
    mockUnauthenticated();

    expect((await removeConsumerAvatar()).ok).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

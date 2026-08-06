import { beforeEach, describe, expect, it, vi } from "vitest";

// getMyConsumerProfile is the read behind both /home's greeting and /profile.
// The distinction it has to get right is "nobody is signed in" (null, which the
// pages turn into a redirect) versus "signed in but the profile row is
// missing" (a DTO with an empty display name, which renders the real name-less
// page). Conflating them would either hide a real session or show an anonymous
// visitor something shaped like an account.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  profilesMaybeSingle: vi.fn(),
  consumersMaybeSingle: vi.fn(),
  citiesMaybeSingle: vi.fn(),
  profilesEq: vi.fn(),
  consumersSelect: vi.fn(),
  consumersEq: vi.fn(),
  citiesEq: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

const { getMyConsents, getMyConsumerProfile } = await import("./repo");

const USER = { id: "user-1", email: "ana@example.com" };

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getUser.mockResolvedValue({ data: { user: USER } });

  mocks.profilesMaybeSingle.mockResolvedValue({
    data: { display_name: "Ana Cruz", avatar_url: null },
    error: null,
  });
  mocks.consumersMaybeSingle.mockResolvedValue({ data: { city_id: "city-1" }, error: null });
  mocks.citiesMaybeSingle.mockResolvedValue({ data: { name: "Davao City" }, error: null });

  mocks.profilesEq.mockReturnValue({ maybeSingle: mocks.profilesMaybeSingle });
  mocks.consumersEq.mockReturnValue({ maybeSingle: mocks.consumersMaybeSingle });
  mocks.consumersSelect.mockReturnValue({ eq: mocks.consumersEq });
  mocks.citiesEq.mockReturnValue({ maybeSingle: mocks.citiesMaybeSingle });

  mocks.from.mockImplementation((table: string) => {
    if (table === "profiles") return { select: () => ({ eq: mocks.profilesEq }) };
    if (table === "consumers") return { select: mocks.consumersSelect };
    if (table === "ref_cities") return { select: () => ({ eq: mocks.citiesEq }) };
    throw new Error(`unexpected table: ${table}`);
  });
});

describe("getMyConsumerProfile", () => {
  it("returns the display name, session email and resolved city name", async () => {
    const profile = await getMyConsumerProfile();

    expect(profile).toEqual({
      userId: "user-1",
      displayName: "Ana Cruz",
      email: "ana@example.com",
      cityName: "Davao City",
      avatarUrl: null,
    });
  });

  it("carries the avatar URL when there is one", async () => {
    const url = "https://proj.supabase.co/storage/v1/object/public/avatars/user-1/a.jpg";
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { display_name: "Ana Cruz", avatar_url: url },
      error: null,
    });

    expect((await getMyConsumerProfile())?.avatarUrl).toBe(url);
  });

  it("CRITICAL: reads avatar_url in the SAME statement as display_name", async () => {
    // A second round trip for one nullable column on a force-dynamic page is a
    // second sequential wait on a Philippine mobile connection, and the column
    // is on the same row.
    const select = vi.fn().mockReturnValue({ eq: mocks.profilesEq });
    mocks.from.mockImplementation((table: string) => {
      if (table === "profiles") return { select };
      if (table === "consumers") return { select: () => ({ eq: mocks.consumersEq }) };
      if (table === "ref_cities") return { select: () => ({ eq: mocks.citiesEq }) };
      throw new Error(`unexpected table: ${table}`);
    });

    await getMyConsumerProfile();

    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]?.[0]).toMatch(/display_name/);
    expect(select.mock.calls[0]?.[0]).toMatch(/avatar_url/);
  });

  it("treats an empty avatar_url as no avatar, not as a URL", async () => {
    // `?? null` would let "" through and point an <img> at the current page.
    mocks.profilesMaybeSingle.mockResolvedValue({
      data: { display_name: "Ana Cruz", avatar_url: "" },
      error: null,
    });

    expect((await getMyConsumerProfile())?.avatarUrl).toBeNull();
  });

  it("returns a null avatar when the profile row is missing entirely", async () => {
    mocks.profilesMaybeSingle.mockResolvedValue({ data: null, error: null });

    expect((await getMyConsumerProfile())?.avatarUrl).toBeNull();
  });

  it("CRITICAL: returns null with no session, which is what the pages gate on", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    expect(await getMyConsumerProfile()).toBeNull();
  });

  it("reads no table at all when there is no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    await getMyConsumerProfile();

    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("scopes both self-reads to the caller's own id", async () => {
    await getMyConsumerProfile();

    expect(mocks.profilesEq).toHaveBeenCalledWith("id", "user-1");
    expect(mocks.consumersEq).toHaveBeenCalledWith("id", "user-1");
  });

  it("returns a DTO with an empty display name when the profile row is missing", async () => {
    // Not null: there IS a session, so /home must render its name-less self
    // rather than bouncing a signed-in consumer to /login.
    mocks.profilesMaybeSingle.mockResolvedValue({ data: null, error: null });

    const profile = await getMyConsumerProfile();

    expect(profile).not.toBeNull();
    expect(profile?.displayName).toBe("");
  });

  it("returns a null city when the consumer has not set one", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({ data: { city_id: null }, error: null });

    const profile = await getMyConsumerProfile();

    expect(profile?.cityName).toBeNull();
    expect(mocks.from).not.toHaveBeenCalledWith("ref_cities");
  });

  it("returns a null city when the city id no longer resolves", async () => {
    mocks.citiesMaybeSingle.mockResolvedValue({ data: null, error: null });

    expect((await getMyConsumerProfile())?.cityName).toBeNull();
  });

  it("returns an empty email for a session that carries none", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    expect((await getMyConsumerProfile())?.email).toBe("");
  });
});

// ===========================================================================
// getMyConsents - the read behind /profile/settings.
//
// EMPTY IS NOT FAILED. This has been a real defect twice on this codebase
// (getMyBalances, the metrics loader), and here it would be worse than a blank
// screen: rendering a failed read as four un-ticked switches tells a consumer
// their consents are all off, and the next thing they do is flip one, which
// writes a value nobody asked for over the value the database actually holds.
// So there is no "all off" fallback in this function at all - a failed or
// missing read returns { ok: false } and the page renders an error, never a
// form.
//
// THE COLUMN-TO-FIELD MAPPING IS ASSERTED ONE COLUMN AT A TIME. Four booleans
// cannot be told apart pairwise inside a single fixture, so each test below
// sets exactly ONE column true. Two fields wired to one column fail at least
// two of them.
// ===========================================================================

/** A consumers row with exactly one consent on. */
function consentRow(on: string) {
  return {
    marketing_opt_in: on === "marketing_opt_in",
    push_enabled: on === "push_enabled",
    email_enabled: on === "email_enabled",
    gps_fraud_opt_in: on === "gps_fraud_opt_in",
  };
}

describe("getMyConsents", () => {
  it("reads all four consent columns in one statement", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({ data: consentRow("push_enabled"), error: null });

    await getMyConsents();

    const columns = mocks.consumersSelect.mock.calls[0]?.[0] as string;
    expect(columns).toMatch(/marketing_opt_in/);
    expect(columns).toMatch(/push_enabled/);
    expect(columns).toMatch(/email_enabled/);
    expect(columns).toMatch(/gps_fraud_opt_in/);
  });

  it("scopes the read to the caller's own row", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({ data: consentRow("push_enabled"), error: null });

    await getMyConsents();

    expect(mocks.consumersEq).toHaveBeenCalledWith("id", "user-1");
  });

  it("CRITICAL: marketing_opt_in true reaches the DTO as marketing_opt_in and nothing else", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({
      data: consentRow("marketing_opt_in"),
      error: null,
    });

    expect(await getMyConsents()).toEqual({
      ok: true,
      consents: {
        marketing_opt_in: true,
        push_enabled: false,
        email_enabled: false,
        gps_fraud_opt_in: false,
      },
    });
  });

  it("CRITICAL: push_enabled true reaches the DTO as push_enabled and nothing else", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({ data: consentRow("push_enabled"), error: null });

    expect(await getMyConsents()).toEqual({
      ok: true,
      consents: {
        marketing_opt_in: false,
        push_enabled: true,
        email_enabled: false,
        gps_fraud_opt_in: false,
      },
    });
  });

  it("CRITICAL: email_enabled true reaches the DTO as email_enabled and nothing else", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({ data: consentRow("email_enabled"), error: null });

    expect(await getMyConsents()).toEqual({
      ok: true,
      consents: {
        marketing_opt_in: false,
        push_enabled: false,
        email_enabled: true,
        gps_fraud_opt_in: false,
      },
    });
  });

  it("CRITICAL: gps_fraud_opt_in true reaches the DTO as gps_fraud_opt_in and nothing else", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({
      data: consentRow("gps_fraud_opt_in"),
      error: null,
    });

    expect(await getMyConsents()).toEqual({
      ok: true,
      consents: {
        marketing_opt_in: false,
        push_enabled: false,
        email_enabled: false,
        gps_fraud_opt_in: true,
      },
    });
  });

  it("CRITICAL: a failed query is ok:false, NOT four consents that are all off", async () => {
    mocks.consumersMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "canceling statement due to statement timeout" },
    });

    expect(await getMyConsents()).toEqual({ ok: false });
  });

  it("CRITICAL: a missing consumers row is ok:false too", async () => {
    // Everybody gets a consumers row at signup (private.handle_new_user), so no
    // row means something is wrong - not that this person consented to nothing.
    mocks.consumersMaybeSingle.mockResolvedValue({ data: null, error: null });

    expect(await getMyConsents()).toEqual({ ok: false });
  });

  it("returns ok:false and reads nothing when there is no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    expect(await getMyConsents()).toEqual({ ok: false });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

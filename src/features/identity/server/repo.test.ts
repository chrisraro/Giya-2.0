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
  consumersEq: vi.fn(),
  citiesEq: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

const { getMyConsumerProfile } = await import("./repo");

const USER = { id: "user-1", email: "ana@example.com" };

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getUser.mockResolvedValue({ data: { user: USER } });

  mocks.profilesMaybeSingle.mockResolvedValue({ data: { display_name: "Ana Cruz" }, error: null });
  mocks.consumersMaybeSingle.mockResolvedValue({ data: { city_id: "city-1" }, error: null });
  mocks.citiesMaybeSingle.mockResolvedValue({ data: { name: "Davao City" }, error: null });

  mocks.profilesEq.mockReturnValue({ maybeSingle: mocks.profilesMaybeSingle });
  mocks.consumersEq.mockReturnValue({ maybeSingle: mocks.consumersMaybeSingle });
  mocks.citiesEq.mockReturnValue({ maybeSingle: mocks.citiesMaybeSingle });

  mocks.from.mockImplementation((table: string) => {
    if (table === "profiles") return { select: () => ({ eq: mocks.profilesEq }) };
    if (table === "consumers") return { select: () => ({ eq: mocks.consumersEq }) };
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
    });
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

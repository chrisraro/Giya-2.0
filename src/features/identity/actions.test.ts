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
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
    rpc: mocks.rpc,
  })),
}));

const { completeConsumerOnboarding, registerBusiness } = await import("./actions");

const AUTH_USER = { id: "user-1" };

function mockAuthed() {
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });
}

function mockUnauthenticated() {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
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

  mocks.rpc.mockResolvedValue({ data: "business-1", error: null });

  mocks.from.mockImplementation((table: string) => {
    if (table === "ref_cities") return { select: mocks.citiesSelect };
    if (table === "consumers") return { update: mocks.consumersUpdate };
    if (table === "profiles") return { update: mocks.profilesUpdate };
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

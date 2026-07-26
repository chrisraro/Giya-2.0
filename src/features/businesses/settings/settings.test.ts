import { describe, it, expect, vi, beforeEach } from "vitest";

// Query-builder fake, same shape as src/features/campaigns/campaigns.test.ts.
const mocks = vi.hoisted(() => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      __result: { data: null, error: null } as { data: unknown; error: unknown },
    };
    for (const method of ["select", "insert", "update", "delete", "eq", "in", "is", "order", "limit"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.single = vi.fn(async () => builder.__result);
    builder.maybeSingle = vi.fn(async () => builder.__result);
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(builder.__result).then(resolve, reject);
    return builder;
  }

  return { makeBuilder, getUser: vi.fn(), from: vi.fn() };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const actions = await import("./actions");
const { BUSINESS_SETTINGS_ROLES } = await import("./roles");
const repo = await import("./server/repo");
const service = await import("./server/service");
const { businessProfileSchema } = await import("./schemas");
const { revalidatePath } = await import("next/cache");

type Builder = ReturnType<typeof mocks.makeBuilder>;

const AUTH_USER = { id: "user-1" };
const OWN_BUSINESS = "biz-1";
const OTHER_BUSINESS = "biz-2";

function businessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OWN_BUSINESS,
    slug: "kape-diaria",
    name: "Kape Diaria",
    status: "active",
    description: "Neighbourhood coffee",
    logo_url: null,
    cover_url: null,
    gallery: [],
    phone: "+63 900 000 0000",
    email: "hello@kapediaria.ph",
    website: "https://kapediaria.ph",
    socials: { facebook: "https://facebook.com/kapediaria" },
    address_line: "12 Real Street",
    barangay: "San Jose",
    city_id: null,
    postal_code: "5000",
    lat: null,
    lng: null,
    google_place_id: null,
    opening_hours: [{ day: 1, open: "08:00", close: "20:00", closed: false }],
    plan: "free",
    plan_limits: {},
    verified_at: "2026-06-01T00:00:00.000Z",
    suspended_reason: null,
    deleted_at: null,
    ...overrides,
  };
}

function sevenDays() {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    open: "09:00",
    close: "21:00",
    closed: day === 7,
  }));
}

const VALID_INPUT = {
  name: "Kape Diaria",
  description: "Neighbourhood coffee",
  phone: "+63 900 000 0000",
  email: "hello@kapediaria.ph",
  website: "https://kapediaria.ph",
  facebook: "https://facebook.com/kapediaria",
  instagram: "",
  tiktok: "",
  addressLine: "12 Real Street",
  barangay: "San Jose",
  postalCode: "5000",
  openingHours: sevenDays(),
};

let builders: Record<string, Builder>;

/**
 * The fake builder stores its methods as `unknown`, so reading a recorded call
 * argument needs one narrowing step. Kept in a helper so the assertions below
 * stay about the patch, not about the mock's typing.
 */
function firstCallArg(builder: Builder, method: string): Record<string, unknown> {
  const fn = builder[method] as { mock: { calls: unknown[][] } };
  return (fn.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

function table(name: string): Builder {
  const b = builders[name];
  if (!b) throw new Error(`no mock builder registered for table "${name}"`);
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();

  builders = {
    business_staff: mocks.makeBuilder(),
    businesses: mocks.makeBuilder(),
  };
  table("business_staff").__result = { data: { business_id: OWN_BUSINESS, role: "owner" }, error: null };
  table("businesses").__result = { data: businessRow(), error: null };

  mocks.from.mockImplementation((name: string) => table(name));
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });
});

// ===========================================================================
// THE EXCLUDED COLUMNS
// supabase/README.md "Known limitations": owner updates could touch
// businesses.status / verified_at / plan, and the column-level grant that
// would fence them is an owed migration. Until it lands, these tests ARE the
// fence's proof.
// ===========================================================================

describe("the settings form cannot submit status, verified_at or plan", () => {
  it.each(["status", "verified_at", "plan"])(
    "refuses a payload that carries %s outright, rather than silently dropping it",
    async (column) => {
      const result = await actions.saveBusinessProfile({ ...VALID_INPUT, [column]: "active" });

      expect(result.ok).toBe(false);
      expect(table("businesses").update).not.toHaveBeenCalled();
    },
  );

  it.each([
    "plan_limits",
    "suspended_reason",
    "slug",
    "google_place_id",
    "city_id",
    "logo_url",
    "gallery",
    "deleted_at",
  ])("also refuses a payload that carries %s", async (column) => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, [column]: "x" });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it("the strict schema itself rejects the three, so no caller can bypass the action", () => {
    for (const column of ["status", "verified_at", "plan"]) {
      expect(businessProfileSchema.safeParse({ ...VALID_INPUT, [column]: "x" }).success).toBe(false);
    }
  });

  it.each(repo.FORBIDDEN_BUSINESS_COLUMNS)(
    "the repo refuses a hand-built patch naming %s, even one that never saw the schema",
    (column) => {
      expect(() => repo.assertEditableColumns({ name: "Kape", [column]: "x" })).toThrow(column);
    },
  );

  it("the allowlist is exactly the presentation columns", () => {
    expect([...repo.EDITABLE_BUSINESS_COLUMNS]).toEqual([
      "name",
      "description",
      "phone",
      "email",
      "website",
      "socials",
      "address_line",
      "barangay",
      "postal_code",
      "lat",
      "lng",
      "opening_hours",
    ]);
  });

  it("still cannot write google_place_id, the one location column with no picker behind it", () => {
    expect([...repo.EDITABLE_BUSINESS_COLUMNS]).not.toContain("google_place_id");
    expect([...repo.FORBIDDEN_BUSINESS_COLUMNS]).toContain("google_place_id");
  });

  it("the built patch never names a column outside the allowlist", () => {
    const parsed = businessProfileSchema.parse(VALID_INPUT);
    const patch = service.buildProfilePatch(parsed);

    const allowed: readonly string[] = repo.EDITABLE_BUSINESS_COLUMNS;
    expect(Object.keys(patch).every((key) => allowed.includes(key))).toBe(true);
    for (const forbidden of repo.FORBIDDEN_BUSINESS_COLUMNS) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });
});

// ------------------------------------------------------------- role gating

describe("actions: role gating", () => {
  it("refuses a caller with no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const result = await actions.saveBusinessProfile(VALID_INPUT);

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it("asks the database for owner and manager only", async () => {
    await actions.saveBusinessProfile(VALID_INPUT);

    expect(table("business_staff").in).toHaveBeenCalledWith("role", ["owner", "manager"]);
    expect(BUSINESS_SETTINGS_ROLES).toEqual(["owner", "manager"]);
  });

  it("refuses a marketing member, whose membership row the role filter excludes", async () => {
    table("business_staff").__result = { data: null, error: null };

    const result = await actions.saveBusinessProfile(VALID_INPUT);

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------- tenancy

describe("tenancy", () => {
  it("updates only the business resolved from business_staff", async () => {
    await actions.saveBusinessProfile(VALID_INPUT);

    expect(table("businesses").eq).toHaveBeenCalledWith("id", OWN_BUSINESS);
    expect(table("businesses").eq).not.toHaveBeenCalledWith("id", OTHER_BUSINESS);
  });

  it("has no key for a business id, so one cannot be smuggled in with the payload", async () => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, businessId: OTHER_BUSINESS });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it("reads the profile scoped to the resolved business", async () => {
    await service.loadProfile(OWN_BUSINESS);

    expect(table("businesses").eq).toHaveBeenCalledWith("id", OWN_BUSINESS);
  });
});

// ------------------------------------------------------------------- saves

describe("saving", () => {
  it("writes the presentation columns and revalidates the settings route", async () => {
    const result = await actions.saveBusinessProfile(VALID_INPUT);

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table("businesses"), "update");
    expect(patch.name).toBe("Kape Diaria");
    expect(patch.address_line).toBe("12 Real Street");
    expect(patch.socials).toEqual({ facebook: "https://facebook.com/kapediaria" });
    expect(revalidatePath).toHaveBeenCalledWith("/business/settings");
  });

  it("stores blank optional fields as null rather than empty strings", async () => {
    await actions.saveBusinessProfile({ ...VALID_INPUT, phone: "", website: "" });

    const patch = firstCallArg(table("businesses"), "update");
    expect(patch.phone).toBeNull();
    expect(patch.website).toBeNull();
  });

  it("drops empty social links from the jsonb rather than storing empty keys", async () => {
    await actions.saveBusinessProfile({ ...VALID_INPUT, facebook: "", instagram: "", tiktok: "" });

    const patch = firstCallArg(table("businesses"), "update");
    expect(patch.socials).toEqual({});
  });

  it("refuses a link that is not an http(s) url", async () => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, website: "kapediaria.ph" });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it("refuses an invalid email address", async () => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, email: "not-an-email" });

    expect(result.ok).toBe(false);
  });

  it("refuses a name shorter than the businesses check constraint allows", async () => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, name: "K" });

    expect(result.ok).toBe(false);
  });

  it("refuses an opening time that is not HH:MM", async () => {
    const hours = sevenDays();
    hours[0] = { day: 1, open: "9am", close: "21:00", closed: false };

    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, openingHours: hours });

    expect(result.ok).toBe(false);
  });

  it("accepts an overnight window, which is legal per doc 32 section 4", async () => {
    const hours = sevenDays();
    hours[0] = { day: 1, open: "18:00", close: "02:00", closed: false };

    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, openingHours: hours });

    expect(result.ok).toBe(true);
  });

  it("refuses two rows for the same weekday", async () => {
    const hours = sevenDays();
    hours[1] = { day: 1, open: "09:00", close: "21:00", closed: false };

    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, openingHours: hours });

    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// THE MAP PIN
//
// `lat`/`lng` are the first columns to move from the forbidden list to the
// allowlist since this screen was built. These tests are the proof that the
// move widened the fence by exactly two columns and did not open a hole: the
// picker's numbers are re-validated from scratch server-side, and everything
// that was refused before is still refused.
// ===========================================================================

describe("the map pin", () => {
  const CEBU = { lat: 10.3156, lng: 123.8854 };

  it("writes both coordinates when the picker supplies them", async () => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, ...CEBU });

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table("businesses"), "update");
    expect(patch.lat).toBe(10.3156);
    expect(patch.lng).toBe(123.8854);
  });

  it("stores null for a business that has never set a pin", async () => {
    // VALID_INPUT predates the picker and names neither key, which is exactly
    // what an older client sends. Absent must mean "no pin", not a parse error.
    const result = await actions.saveBusinessProfile(VALID_INPUT);

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table("businesses"), "update");
    expect(patch.lat).toBeNull();
    expect(patch.lng).toBeNull();
  });

  it("clears the pin when the merchant removes it", async () => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, lat: null, lng: null });

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table("businesses"), "update");
    expect(patch.lat).toBeNull();
    expect(patch.lng).toBeNull();
  });

  it("rounds to six decimals rather than storing the float noise a map click produces", async () => {
    await actions.saveBusinessProfile({
      ...VALID_INPUT,
      lat: 10.315612345678901,
      lng: 123.885498765432,
    });

    const patch = firstCallArg(table("businesses"), "update");
    expect(patch.lat).toBe(10.315612);
    expect(patch.lng).toBe(123.885499);
  });

  it.each([
    ["latitude above 90", { lat: 90.1, lng: 120 }],
    ["latitude below -90", { lat: -90.1, lng: 120 }],
    ["longitude above 180", { lat: 10, lng: 180.1 }],
    ["longitude below -180", { lat: 10, lng: -180.1 }],
  ])("refuses %s", async (_label, coordinates) => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, ...coordinates });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it.each([
    ["not-a-number", "10.3156"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
  ])("refuses a latitude that is %s", async (_label, lat) => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, lat, lng: 123.8854 });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it("refuses a transposed pair, which is the mistake a range check actually catches", async () => {
    // Cebu with lat and lng the wrong way round. Every Philippine longitude
    // exceeds 116, so the swap always presents a latitude outside [-90, 90] -
    // which is why no country bounding box is needed to catch this one.
    const result = await actions.saveBusinessProfile({
      ...VALID_INPUT,
      lat: CEBU.lng,
      lng: CEBU.lat,
    });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it.each([
    ["a latitude with no longitude", { lat: 10.3156 }],
    ["a longitude with no latitude", { lng: 123.8854 }],
    ["a latitude and an explicitly null longitude", { lat: 10.3156, lng: null }],
  ])("refuses %s, because half a pin is a corrupt row and not a partial one", async (_l, half) => {
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, ...half });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it("saves a pin outside the Philippines, and says so in the log rather than refusing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Singapore. Valid coordinates, surprising for this market. A bounding box
    // is a market assumption, not a data-integrity rule, and a merchant who
    // cannot save their own address has no workaround at all.
    const result = await actions.saveBusinessProfile({ ...VALID_INPUT, lat: 1.3521, lng: 103.8198 });

    expect(result.ok).toBe(true);
    expect(firstCallArg(table("businesses"), "update").lat).toBe(1.3521);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("outside the Philippines"));

    warn.mockRestore();
  });

  it("says nothing about the market when the pin is inside it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await actions.saveBusinessProfile({ ...VALID_INPUT, ...CEBU });

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("outside the Philippines"));
    warn.mockRestore();
  });

  it("a patch carrying a pin still names nothing outside the allowlist", () => {
    const parsed = businessProfileSchema.parse({ ...VALID_INPUT, ...CEBU });
    const patch = service.buildProfilePatch(parsed);

    const allowed: readonly string[] = repo.EDITABLE_BUSINESS_COLUMNS;
    expect(Object.keys(patch).every((key) => allowed.includes(key))).toBe(true);
    for (const forbidden of repo.FORBIDDEN_BUSINESS_COLUMNS) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });

  it("a payload that pairs a pin with status is still refused outright", async () => {
    const result = await actions.saveBusinessProfile({
      ...VALID_INPUT,
      ...CEBU,
      status: "active",
    });

    expect(result.ok).toBe(false);
    expect(table("businesses").update).not.toHaveBeenCalled();
  });

  it("reads a stored pin back as a pair, and a half pair as no pin", async () => {
    table("businesses").__result = { data: businessRow({ lat: 10.3156, lng: 123.8854 }), error: null };
    const withPin = await service.loadProfile(OWN_BUSINESS);
    expect(withPin.ok && withPin.data?.coordinates).toEqual({ lat: 10.3156, lng: 123.8854 });

    table("businesses").__result = { data: businessRow({ lat: 10.3156, lng: null }), error: null };
    const halfPin = await service.loadProfile(OWN_BUSINESS);
    expect(halfPin.ok && halfPin.data?.coordinates).toBeNull();
  });
});

// -------------------------------------------------------------------- read

describe("loadProfile", () => {
  it("reports a read failure rather than a blank business", async () => {
    table("businesses").__result = { data: null, error: { message: "boom" } };

    const result = await service.loadProfile(OWN_BUSINESS);

    expect(result.ok).toBe(false);
  });

  it("reports a missing row rather than rendering an empty form", async () => {
    table("businesses").__result = { data: null, error: null };

    const result = await service.loadProfile(OWN_BUSINESS);

    expect(result.ok).toBe(false);
  });

  it("exposes status, verified_at and plan read-only, separate from the editable fields", async () => {
    const result = await service.loadProfile(OWN_BUSINESS);

    expect(result.ok && result.data?.readOnly).toEqual({
      slug: "kape-diaria",
      status: "active",
      verifiedAt: "2026-06-01T00:00:00.000Z",
      plan: "free",
    });
  });
});

// ------------------------------------------------------- defensive parsing

describe("parseOpeningHours", () => {
  it("always returns seven rows, Monday through Sunday", () => {
    expect(service.parseOpeningHours([]).map((entry) => entry.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("treats a day the stored value does not cover as closed", () => {
    const parsed = service.parseOpeningHours([{ day: 1, open: "08:00", close: "20:00", closed: false }]);

    expect(parsed[0]).toEqual({ day: 1, open: "08:00", close: "20:00", closed: false });
    expect(parsed[1]?.closed).toBe(true);
  });

  it("degrades malformed times to the defaults rather than throwing", () => {
    const parsed = service.parseOpeningHours([{ day: 3, open: "nope", close: 42, closed: false }]);

    expect(parsed[2]).toEqual({
      day: 3,
      open: service.DEFAULT_OPEN,
      close: service.DEFAULT_CLOSE,
      closed: false,
    });
  });

  it("ignores anything that is not an array, and entries outside day 1-7", () => {
    expect(service.parseOpeningHours("closed forever")).toHaveLength(7);
    expect(service.parseOpeningHours([{ day: 9, open: "08:00", close: "20:00" }])).toHaveLength(7);
  });

  it("keeps the first row for a duplicated day", () => {
    const parsed = service.parseOpeningHours([
      { day: 1, open: "08:00", close: "20:00", closed: false },
      { day: 1, open: "10:00", close: "22:00", closed: false },
    ]);

    expect(parsed[0]?.open).toBe("08:00");
  });
});

describe("parseSocials", () => {
  it("reads the three known handles and ignores everything else", () => {
    expect(
      service.parseSocials({ facebook: "https://fb", twitter: "https://x", instagram: "" }),
    ).toEqual({ facebook: "https://fb", instagram: null, tiktok: null });
  });

  it("degrades a non-object to three nulls", () => {
    expect(service.parseSocials(["nope"])).toEqual({
      facebook: null,
      instagram: null,
      tiktok: null,
    });
  });
});

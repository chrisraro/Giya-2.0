import { describe, it, expect } from "vitest";

import {
  canTransition,
  nextStatus,
  activationGates,
  isCampaignLive,
  CampaignTransitionError,
} from "./lifecycle";
import type {
  Business,
  Campaign,
  CampaignAction,
  CampaignStatus,
  CampaignType,
  PayloadPresence,
} from "./types";

const ALL_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "scheduled",
  "active",
  "paused",
  "ended",
  "archived",
];

// The exact edge set of doc 34 section 2 (T1-T8; T9 duplicate is not a
// transition of the source row).
const ALLOWED_EDGES: ReadonlyArray<readonly [CampaignStatus, CampaignStatus]> =
  [
    ["draft", "scheduled"], // T1
    ["draft", "active"], // T2
    ["scheduled", "active"], // T3
    ["scheduled", "draft"], // T4
    ["active", "paused"], // T5
    ["paused", "active"], // T6
    ["active", "ended"], // T7
    ["paused", "ended"], // T7
    ["draft", "archived"], // T8
    ["ended", "archived"], // T8
  ];

const isAllowed = (from: CampaignStatus, to: CampaignStatus): boolean =>
  ALLOWED_EDGES.some(([f, t]) => f === from && t === to);

const NOW = new Date("2026-07-25T04:00:00.000Z"); // 12:00 Manila
const FUTURE_START = new Date("2026-08-01T02:00:00.000Z");
const FUTURE_END = new Date("2026-08-31T15:59:00.000Z");
const PAST = new Date("2026-07-01T04:00:00.000Z");

const makeCampaign = (overrides: Partial<Campaign> = {}): Campaign => ({
  type: "promotion",
  status: "draft",
  startsAt: FUTURE_START,
  endsAt: FUTURE_END,
  timezone: "Asia/Manila",
  budget: {},
  ...overrides,
});

// Payload presence with every payload family satisfied, so per-type G2
// tests can knock out exactly the rows that type requires.
const fullPayload = (
  overrides: Partial<PayloadPresence> = {},
): PayloadPresence => ({
  hasPromotion: true,
  rewardCount: 1,
  hasLoyaltyProgram: true,
  hasLoyaltyPrize: true,
  pointsRuleCount: 1,
  ...overrides,
});

const emptyPayload = (): PayloadPresence => ({
  hasPromotion: false,
  rewardCount: 0,
  hasLoyaltyProgram: false,
  hasLoyaltyPrize: false,
  pointsRuleCount: 0,
});

const activeBusiness: Business = { status: "active" };

const codesOf = (campaign: Campaign, payload: PayloadPresence, business: Business) =>
  activationGates(campaign, payload, business, NOW).failures.map((f) => f.code);

describe("canTransition", () => {
  it.each(ALLOWED_EDGES.map(([f, t]) => [f, t]))(
    "allows %s -> %s",
    (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    },
  );

  it("rejects every pair outside the doc 34 edge set (exhaustive)", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (!isAllowed(from, to)) {
          expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
        }
      }
    }
  });

  it("never allows a self-transition", () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("treats archived as terminal (no outgoing edges)", () => {
    for (const to of ALL_STATUSES) {
      expect(canTransition("archived", to)).toBe(false);
    }
  });

  it("never allows ended -> active (relaunch is duplicate, T9)", () => {
    expect(canTransition("ended", "active")).toBe(false);
  });

  it("per doc 34, scheduled cannot go straight to ended or archived", () => {
    expect(canTransition("scheduled", "ended")).toBe(false);
    expect(canTransition("scheduled", "archived")).toBe(false);
  });

  it("per doc 34 T8, paused and active cannot be archived directly", () => {
    expect(canTransition("paused", "archived")).toBe(false);
    expect(canTransition("active", "archived")).toBe(false);
  });
});

describe("nextStatus", () => {
  const VALID: ReadonlyArray<
    readonly [CampaignAction, CampaignStatus, CampaignStatus]
  > = [
    ["schedule", "draft", "scheduled"],
    ["activate", "draft", "active"],
    ["activate", "scheduled", "active"],
    ["unschedule", "scheduled", "draft"],
    ["pause", "active", "paused"],
    ["resume", "paused", "active"],
    ["end", "active", "ended"],
    ["end", "paused", "ended"],
    ["archive", "draft", "archived"],
    ["archive", "ended", "archived"],
  ];

  it.each(VALID.map(([a, f, t]) => [a, f, t]))(
    "'%s' from %s -> %s",
    (action, from, to) => {
      expect(nextStatus(makeCampaign({ status: from }), action)).toBe(to);
    },
  );

  it("throws CampaignTransitionError for every invalid action/status pair (exhaustive)", () => {
    const ACTIONS: readonly CampaignAction[] = [
      "schedule",
      "activate",
      "unschedule",
      "pause",
      "resume",
      "end",
      "archive",
    ];
    for (const action of ACTIONS) {
      for (const status of ALL_STATUSES) {
        const valid = VALID.some(([a, f]) => a === action && f === status);
        if (valid) continue;
        expect(
          () => nextStatus(makeCampaign({ status }), action),
          `${action} from ${status}`,
        ).toThrow(CampaignTransitionError);
      }
    }
  });

  it("rejects resume from draft even though draft -> active is an edge (that trigger is activate)", () => {
    expect(() => nextStatus(makeCampaign({ status: "draft" }), "resume")).toThrow(
      CampaignTransitionError,
    );
  });

  it("rejects activate from paused (that trigger is resume, T6)", () => {
    expect(() =>
      nextStatus(makeCampaign({ status: "paused" }), "activate"),
    ).toThrow(CampaignTransitionError);
  });

  it("rejects activate from ended (no ended -> active)", () => {
    expect(() =>
      nextStatus(makeCampaign({ status: "ended" }), "activate"),
    ).toThrow(CampaignTransitionError);
  });

  it("rejects every action from archived (terminal)", () => {
    const ACTIONS: readonly CampaignAction[] = [
      "schedule",
      "activate",
      "unschedule",
      "pause",
      "resume",
      "end",
      "archive",
    ];
    for (const action of ACTIONS) {
      expect(() =>
        nextStatus(makeCampaign({ status: "archived" }), action),
      ).toThrow(CampaignTransitionError);
    }
  });

  it("carries the CAMPAIGN_INVALID_STATE code and context on the error", () => {
    try {
      nextStatus(makeCampaign({ status: "ended" }), "activate");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CampaignTransitionError);
      const e = error as CampaignTransitionError;
      expect(e.code).toBe("CAMPAIGN_INVALID_STATE");
      expect(e.message).toContain("activate");
      expect(e.message).toContain("ended");
    }
  });
});

describe("activationGates", () => {
  it("passes all gates for a complete, valid campaign (ok, no failures)", () => {
    const result = activationGates(
      makeCampaign({ budget: { maxTotalPoints: 5000, maxRedemptions: 100, perCustomerLimit: 2 } }),
      fullPayload(),
      activeBusiness,
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("passes with null schedule and empty budget (both mean unlimited)", () => {
    const result = activationGates(
      makeCampaign({ startsAt: null, endsAt: null, budget: {} }),
      fullPayload(),
      activeBusiness,
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  describe("G1 business standing", () => {
    it.each([["pending_verification"], ["suspended"], ["draft"]])(
      "fails BUSINESS_NOT_VERIFIED when business.status is %s",
      (status) => {
        const result = activationGates(
          makeCampaign(),
          fullPayload(),
          { status },
          NOW,
        );
        expect(result.ok).toBe(false);
        expect(result.failures.map((f) => f.code)).toEqual([
          "BUSINESS_NOT_VERIFIED",
        ]);
      },
    );
  });

  describe("G2 payload completeness (type -> payload mapping)", () => {
    const promotionFamily: readonly CampaignType[] = [
      "promotion",
      "discount",
      "seasonal",
      "holiday",
      "event",
    ];

    it.each(promotionFamily.map((t) => [t]))(
      "%s requires a promotions row",
      (type) => {
        const campaign = makeCampaign({ type });
        expect(
          codesOf(campaign, fullPayload({ hasPromotion: false }), activeBusiness),
        ).toEqual(["CAMPAIGN_PAYLOAD_INCOMPLETE"]);
        expect(codesOf(campaign, fullPayload(), activeBusiness)).toEqual([]);
      },
    );

    it("reward requires at least one active reward", () => {
      const campaign = makeCampaign({ type: "reward" });
      expect(
        codesOf(campaign, fullPayload({ rewardCount: 0 }), activeBusiness),
      ).toEqual(["CAMPAIGN_PAYLOAD_INCOMPLETE"]);
      expect(
        codesOf(campaign, fullPayload({ rewardCount: 3 }), activeBusiness),
      ).toEqual([]);
    });

    it.each([["loyalty"], ["membership"]] as const)(
      "%s requires a loyalty program AND its prize reward",
      (type) => {
        const campaign = makeCampaign({ type });
        expect(
          codesOf(
            campaign,
            fullPayload({ hasLoyaltyProgram: false }),
            activeBusiness,
          ),
        ).toEqual(["CAMPAIGN_PAYLOAD_INCOMPLETE"]);
        expect(
          codesOf(
            campaign,
            fullPayload({ hasLoyaltyPrize: false }),
            activeBusiness,
          ),
        ).toEqual(["CAMPAIGN_PAYLOAD_INCOMPLETE"]);
        expect(codesOf(campaign, fullPayload(), activeBusiness)).toEqual([]);
      },
    );

    it("birthday requires points_rules and/or rewards", () => {
      const campaign = makeCampaign({ type: "birthday" });
      expect(
        codesOf(
          campaign,
          fullPayload({ pointsRuleCount: 0, rewardCount: 0 }),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_PAYLOAD_INCOMPLETE"]);
      expect(
        codesOf(
          campaign,
          fullPayload({ pointsRuleCount: 1, rewardCount: 0 }),
          activeBusiness,
        ),
      ).toEqual([]);
      expect(
        codesOf(
          campaign,
          fullPayload({ pointsRuleCount: 0, rewardCount: 1 }),
          activeBusiness,
        ),
      ).toEqual([]);
    });

    it("referral requires points_rules (rewards alone do not satisfy it)", () => {
      const campaign = makeCampaign({ type: "referral" });
      expect(
        codesOf(
          campaign,
          fullPayload({ pointsRuleCount: 0, rewardCount: 5 }),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_PAYLOAD_INCOMPLETE"]);
      expect(
        codesOf(campaign, fullPayload({ pointsRuleCount: 2 }), activeBusiness),
      ).toEqual([]);
    });
  });

  describe("G3 schedule sanity", () => {
    it("fails when endsAt <= startsAt (both set)", () => {
      expect(
        codesOf(
          makeCampaign({ startsAt: FUTURE_END, endsAt: FUTURE_START }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_SCHEDULE_INVALID"]);
      expect(
        codesOf(
          makeCampaign({ startsAt: FUTURE_START, endsAt: FUTURE_START }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_SCHEDULE_INVALID"]);
    });

    it("fails when endsAt is set but not in the future of now", () => {
      expect(
        codesOf(
          makeCampaign({ startsAt: null, endsAt: PAST }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_SCHEDULE_INVALID"]);
      expect(
        codesOf(
          makeCampaign({ startsAt: null, endsAt: NOW }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_SCHEDULE_INVALID"]);
    });

    it("fails for a scheduled campaign whose startsAt is in the past", () => {
      expect(
        codesOf(
          makeCampaign({ status: "scheduled", startsAt: PAST }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_SCHEDULE_INVALID"]);
    });

    it("fails for a scheduled campaign with no startsAt at all", () => {
      expect(
        codesOf(
          makeCampaign({ status: "scheduled", startsAt: null }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_SCHEDULE_INVALID"]);
    });

    it("allows a past startsAt for non-scheduled statuses (activate-now backdating)", () => {
      expect(
        codesOf(
          makeCampaign({ status: "draft", startsAt: PAST, endsAt: FUTURE_END }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual([]);
    });
  });

  describe("G4 budget sanity", () => {
    const keys = ["maxTotalPoints", "maxRedemptions", "perCustomerLimit"] as const;

    it.each(keys.map((k) => [k]))(
      "fails when %s is zero, negative, or fractional",
      (key) => {
        for (const bad of [0, -5, 1.5]) {
          expect(
            codesOf(
              makeCampaign({ budget: { [key]: bad } }),
              fullPayload(),
              activeBusiness,
            ),
            `${key} = ${bad}`,
          ).toEqual(["CAMPAIGN_BUDGET_INVALID"]);
        }
      },
    );

    it("passes when every present key is a positive integer", () => {
      expect(
        codesOf(
          makeCampaign({
            budget: { maxTotalPoints: 1, maxRedemptions: 500, perCustomerLimit: 3 },
          }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual([]);
    });

    it("reports a single G4 failure even when several keys are invalid", () => {
      expect(
        codesOf(
          makeCampaign({ budget: { maxTotalPoints: 0, maxRedemptions: -1 } }),
          fullPayload(),
          activeBusiness,
        ),
      ).toEqual(["CAMPAIGN_BUDGET_INVALID"]);
    });
  });

  it("collects ALL failures without short-circuiting (G1+G2+G3+G4 together)", () => {
    const result = activationGates(
      makeCampaign({
        type: "reward",
        startsAt: FUTURE_END,
        endsAt: FUTURE_START,
        budget: { maxRedemptions: 0 },
      }),
      emptyPayload(),
      { status: "suspended" },
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual([
      "BUSINESS_NOT_VERIFIED",
      "CAMPAIGN_PAYLOAD_INCOMPLETE",
      "CAMPAIGN_SCHEDULE_INVALID",
      "CAMPAIGN_BUDGET_INVALID",
    ]);
    for (const failure of result.failures) {
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });
});

describe("isCampaignLive", () => {
  const live = makeCampaign({
    status: "active",
    startsAt: new Date("2026-07-20T00:00:00.000Z"),
    endsAt: new Date("2026-07-30T00:00:00.000Z"),
  });

  it("is live strictly inside the window", () => {
    expect(isCampaignLive(live, new Date("2026-07-25T12:00:00.000Z"))).toBe(true);
  });

  it("is live exactly at startsAt (inclusive start)", () => {
    expect(isCampaignLive(live, new Date("2026-07-20T00:00:00.000Z"))).toBe(true);
  });

  it("is NOT live exactly at endsAt (doc 34 end-exclusive: at >= ends_at)", () => {
    expect(isCampaignLive(live, new Date("2026-07-30T00:00:00.000Z"))).toBe(false);
  });

  it("is not live before the window or after it", () => {
    expect(isCampaignLive(live, new Date("2026-07-19T23:59:59.000Z"))).toBe(false);
    expect(isCampaignLive(live, new Date("2026-08-01T00:00:00.000Z"))).toBe(false);
  });

  it("null startsAt means live immediately; null endsAt means no expiry", () => {
    const openStart = makeCampaign({ status: "active", startsAt: null, endsAt: new Date("2026-07-30T00:00:00.000Z") });
    expect(isCampaignLive(openStart, new Date("2000-01-01T00:00:00.000Z"))).toBe(true);
    const openEnd = makeCampaign({ status: "active", startsAt: new Date("2026-07-20T00:00:00.000Z"), endsAt: null });
    expect(isCampaignLive(openEnd, new Date("2099-01-01T00:00:00.000Z"))).toBe(true);
    const openBoth = makeCampaign({ status: "active", startsAt: null, endsAt: null });
    expect(isCampaignLive(openBoth, NOW)).toBe(true);
  });

  it("is never live for any non-active status, even inside the window", () => {
    const at = new Date("2026-07-25T12:00:00.000Z");
    for (const status of ALL_STATUSES) {
      if (status === "active") continue;
      expect(isCampaignLive({ ...live, status }, at), status).toBe(false);
    }
  });
});

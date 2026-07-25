import { z } from "zod";

import type { RuleConditions } from "./types";

// Conditions DSL for points_rules.conditions, per
// docs/30-modules/35-points-engine.md section 2. Pure module: no IO.
//
// Semantics: all present keys AND together; {} always applies. Evaluated at
// the receipt's wall-clock date/time in the business timezone (the caller
// derives weekday/minutesOfDay; see ./compute.ts).
//
// Note: the referral-only keys (referrer_points / referee_points) are a [V1]
// referral-slice concern and intentionally not part of this earning DSL yet;
// .strict() keeps unknown keys loud so the DSL can grow without silent
// misconfiguration.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ruleConditionsSchema = z
  .strictObject({
    // ISO weekdays: 1 = Monday .. 7 = Sunday (matches businesses.opening_hours).
    days: z.array(z.number().int().min(1).max(7)).min(1).optional(),
    time_from: z.string().regex(HHMM, "Expected HH:MM").optional(), // inclusive
    time_to: z.string().regex(HHMM, "Expected HH:MM").optional(), // exclusive; from > to spans midnight
    min_amount_centavos: z.number().int().min(0).optional(),
    birthday: z.boolean().optional(),
    first_visit: z.boolean().optional(),
  })
  .refine((c) => (c.time_from === undefined) === (c.time_to === undefined), {
    message: "time_from and time_to must be set together",
  });

export type ValidatedRuleConditions = z.infer<typeof ruleConditionsSchema>;

// Facts about the receipt moment the conditions are checked against.
export interface ConditionContext {
  weekday: number; // ISO 1 (Mon) .. 7 (Sun), in the business timezone
  minutesOfDay: number; // 0..1439 wall-clock minutes, in the business timezone
  amountCentavos: number; // receipt total
  isBirthday?: boolean; // undefined = unknown, treated as not a birthday
  isFirstVisit?: boolean; // undefined = unknown, treated as not first visit
}

function parseHHMM(value: string): number {
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours * 60 + minutes;
}

// Pure predicate: does this receipt context satisfy the rule's conditions?
// Every present key must match (AND). Empty conditions always pass.
export function evaluateConditions(
  conditions: RuleConditions,
  ctx: ConditionContext,
): boolean {
  if (conditions.days !== undefined && !conditions.days.includes(ctx.weekday)) {
    return false;
  }

  // The schema guarantees the pair comes together; evaluate only when both
  // are present so a half-formed window never silently gates.
  if (conditions.time_from !== undefined && conditions.time_to !== undefined) {
    const from = parseHHMM(conditions.time_from);
    const to = parseHHMM(conditions.time_to);
    const m = ctx.minutesOfDay;
    // from inclusive, to exclusive. from > to spans midnight; from == to is
    // an empty window (never matches) by the same [from, to) reading.
    const inWindow = from <= to ? m >= from && m < to : m >= from || m < to;
    if (!inWindow) return false;
  }

  if (
    conditions.min_amount_centavos !== undefined &&
    ctx.amountCentavos < conditions.min_amount_centavos
  ) {
    return false;
  }

  // birthday/first_visit only gate when set to true; false is a no-op so a
  // saved-but-disabled flag never accidentally blocks a rule.
  if (conditions.birthday === true && ctx.isBirthday !== true) return false;
  if (conditions.first_visit === true && ctx.isFirstVisit !== true) return false;

  return true;
}

import type { LoyaltyProgramType } from "@/features/loyalty/display";
import { createClient } from "@/lib/supabase/server";

// ===========================================================================
// THE CONSUMER'S READ OF THEIR OWN LOYALTY CARDS.
//
// Repointed onto doc 35's schema by 0078_loyalty_card_progression.sql. Until
// then this module read the six columns 0066 bolted onto `loyalty_cards`
// (`user_id`, `stamps_count`, `stamps_target`, `prize_reward_name`,
// `is_completed`, `completed_at`) - columns nothing has ever written, because
// 0066's `create table if not exists` was a no-op against a table 0012 had
// already created. 0078 drops them; the surviving columns are 0012's, and the
// target, the prize and the card art live one join away on
// `loyalty_programs` / `rewards` where the write side can actually maintain
// them.
//
// `isCompleted` is derived, not stored: a card is complete when its progress
// has reached the program's target. For a program with
// `resets_on_completion = true` that state is momentary (the RPC subtracts
// the target and keeps the carryover in the same transaction), which is
// correct - the consumer has started a new card and `completedCount` is where
// the finished ones are counted.
//
// ---------------------------------------------------------------------------
// BOTH READS THROW ON A QUERY ERROR. THEY DO NOT RETURN `[]` OR `null` FOR IT.
// ---------------------------------------------------------------------------
// `src/features/rewards/server/repo.ts` settled this exact question on this
// exact money path and its reasoning transfers without amendment: `[]` here
// does not render as "something went wrong", it renders as the /cards empty
// state - "No stamp cards yet. Scan receipts at participating shops to start
// collecting stamps." A consumer whose read just failed would be told, in
// copy, that the stamps they have been collecting do not exist. Failing open
// is not a safe default; failing loud is the caller's signal to degrade
// deliberately.
//
// The split is between "the query failed" and "the answer is genuinely
// nothing": no cards, and a card id that matches nothing, are both real,
// common states and stay non-throwing.
// ===========================================================================

export type LoyaltyCardDTO = {
  id: string;
  businessId: string;
  businessName: string;
  programType: LoyaltyProgramType;
  /** `loyalty_cards.progress`, in the program's own unit. */
  stampsCount: number;
  /** `loyalty_programs.target_value`, the same unit as `stampsCount`. */
  stampsTarget: number;
  /** The completion prize's own name, from `rewards`. */
  prizeRewardName: string;
  completedCount: number;
  isCompleted: boolean;
  /** `loyalty_programs.stamp_icon` - a Material Symbols name, or null. */
  stampIcon: string | null;
};

// No `as any` on either query. `src/lib/supabase/types.ts` carries 0012's
// column list for this table (`progress`, `completed_count`, `consumer_id`)
// and both composite FK relationships, so the generated types resolve
// CARD_SELECT - including the two-level `loyalty_programs -> rewards` nest -
// on their own. Casting the client would throw away the only static check
// that can catch this embed breaking.
const CARD_SELECT = `
  id,
  business_id,
  progress,
  completed_count,
  businesses (
    name
  ),
  loyalty_programs (
    program_type,
    target_value,
    stamp_icon,
    rewards (
      name
    )
  )
` as const;

/**
 * The row shape CARD_SELECT returns. Declared rather than inferred so the
 * assignment below is a compile-time assertion that the query still returns
 * what this module reads - if the embed ever stops resolving, or a column is
 * renamed, `tsc` says so instead of `/cards` quietly emptying.
 */
type CardRow = {
  id: string;
  business_id: string;
  progress: number;
  completed_count: number;
  businesses: { name: string } | null;
  loyalty_programs: {
    program_type: string;
    target_value: number;
    stamp_icon: string | null;
    rewards: { name: string } | null;
  } | null;
};

function toDTO(row: CardRow): LoyaltyCardDTO | null {
  const program = row.loyalty_programs;
  // The program is the source of the target; without it there is no card to
  // render. 0078's `loyalty_programs_cardholder_select` policy is what keeps
  // this from happening when a merchant pauses the campaign behind a card the
  // consumer already holds - but a soft-deleted program, or that policy ever
  // being dropped, lands here, and a card with no target is not something to
  // guess a denominator for.
  if (!program) return null;

  const progress = row.progress ?? 0;
  const target = program.target_value;

  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.businesses?.name ?? "Shop",
    programType: program.program_type as LoyaltyProgramType,
    stampsCount: progress,
    stampsTarget: target,
    prizeRewardName: program.rewards?.name ?? "Free prize",
    completedCount: row.completed_count ?? 0,
    isCompleted: progress >= target,
    stampIcon: program.stamp_icon ?? null,
  };
}

export async function listMyLoyaltyCards(): Promise<LoyaltyCardDTO[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data, error } = await supabase
    .from("loyalty_cards")
    .select(CARD_SELECT)
    .eq("consumer_id", user.id);

  if (error) {
    throw new Error(`listMyLoyaltyCards: failed to load loyalty cards: ${error.message}`);
  }

  const rows: CardRow[] = data ?? [];

  return rows.map(toDTO).filter((card): card is LoyaltyCardDTO => card !== null);
}

export async function getLoyaltyCard(cardId: string): Promise<LoyaltyCardDTO | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("loyalty_cards")
    .select(CARD_SELECT)
    .eq("id", cardId)
    // RLS already fences this to the caller's own rows; the explicit filter
    // is what makes a wrong id a miss rather than a leak if the policy is
    // ever loosened.
    .eq("consumer_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`getLoyaltyCard: failed to load loyalty card: ${error.message}`);
  }

  // `null` past this point means the id matched nothing the caller owns - a
  // genuine miss, which the page turns into notFound().
  if (!data) return null;

  const row: CardRow = data;

  return toDTO(row);
}

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
// ===========================================================================

export type LoyaltyCardDTO = {
  id: string;
  businessId: string;
  businessName: string;
  programId: string;
  programType: LoyaltyProgramType;
  /** `loyalty_cards.progress`, in the program's own unit. */
  stampsCount: number;
  /** `loyalty_programs.target_value`, the same unit as `stampsCount`. */
  stampsTarget: number;
  /** The completion prize's own name, from `rewards`. */
  prizeRewardName: string;
  completedCount: number;
  isCompleted: boolean;
  lastStampAt: string | null;
  /** `loyalty_programs.stamp_icon` - a Material Symbols name, or null. */
  stampIcon: string | null;
};

/**
 * The row shape PostgREST returns for CARD_SELECT. Written out rather than
 * inferred because `src/lib/supabase/types.ts` still carries 0066's column
 * list for this table and would type-check the wrong schema.
 */
type CardRow = {
  id: string;
  business_id: string;
  program_id: string;
  progress: number | null;
  completed_count: number | null;
  last_stamp_at: string | null;
  businesses: { name: string } | null;
  loyalty_programs: {
    program_type: LoyaltyProgramType;
    target_value: number;
    stamp_icon: string | null;
    resets_on_completion: boolean;
    rewards: { name: string } | null;
  } | null;
};

const CARD_SELECT = `
  id,
  business_id,
  program_id,
  progress,
  completed_count,
  last_stamp_at,
  businesses (
    name
  ),
  loyalty_programs (
    program_type,
    target_value,
    stamp_icon,
    resets_on_completion,
    rewards (
      name
    )
  )
`;

function toDTO(row: CardRow): LoyaltyCardDTO | null {
  const program = row?.loyalty_programs;
  // The program is the source of the target; without it there is no card to
  // show. 0078's `loyalty_programs_cardholder_select` policy is what keeps
  // this from happening when a merchant pauses the campaign behind a card the
  // consumer already holds.
  if (!program) return null;

  const progress: number = row.progress ?? 0;
  const target: number = program.target_value;

  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.businesses?.name ?? "Shop",
    programId: row.program_id,
    programType: program.program_type,
    stampsCount: progress,
    stampsTarget: target,
    prizeRewardName: program.rewards?.name ?? "Free prize",
    completedCount: row.completed_count ?? 0,
    isCompleted: progress >= target,
    lastStampAt: row.last_stamp_at ?? null,
    stampIcon: program.stamp_icon ?? null,
  };
}

export async function listMyLoyaltyCards(): Promise<LoyaltyCardDTO[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data, error } = await (supabase as any)
    .from("loyalty_cards")
    .select(CARD_SELECT)
    .eq("consumer_id", user.id);

  if (error || !data) return [];

  return (data as CardRow[])
    .map(toDTO)
    .filter((card): card is LoyaltyCardDTO => card !== null);
}

export async function getLoyaltyCard(cardId: string): Promise<LoyaltyCardDTO | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await (supabase as any)
    .from("loyalty_cards")
    .select(CARD_SELECT)
    .eq("id", cardId)
    // RLS already fences this to the caller's own rows; the explicit filter
    // is what makes a wrong id a miss rather than a leak if the policy is
    // ever loosened.
    .eq("consumer_id", user.id)
    .maybeSingle();

  if (error || !data) return null;

  return toDTO(data as CardRow);
}

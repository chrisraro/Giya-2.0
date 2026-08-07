import { createClient } from "@/lib/supabase/server";

export type LoyaltyCardDTO = {
  id: string;
  businessId: string;
  businessName: string;
  stampsCount: number;
  stampsTarget: number;
  prizeRewardName: string;
  isCompleted: boolean;
  completedAt: string | null;
};

export async function listMyLoyaltyCards(): Promise<LoyaltyCardDTO[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data, error } = await (supabase as any)
    .from("loyalty_cards")
    .select(`
      id,
      business_id,
      stamps_count,
      stamps_target,
      prize_reward_name,
      is_completed,
      completed_at,
      businesses (
        name
      )
    `)
    .eq("user_id", user.id);

  if (error || !data) return [];

  return data.map((row: any) => ({
    id: row.id,
    businessId: row.business_id,
    businessName: row.businesses?.name ?? "Shop",
    stampsCount: row.stamps_count,
    stampsTarget: row.stamps_target,
    prizeRewardName: row.prize_reward_name,
    isCompleted: row.is_completed,
    completedAt: row.completed_at,
  }));
}

export async function getLoyaltyCard(cardId: string): Promise<LoyaltyCardDTO | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await (supabase as any)
    .from("loyalty_cards")
    .select(`
      id,
      business_id,
      stamps_count,
      stamps_target,
      prize_reward_name,
      is_completed,
      completed_at,
      businesses (
        name
      )
    `)
    .eq("id", cardId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    businessId: data.business_id,
    businessName: (data as any).businesses?.name ?? "Shop",
    stampsCount: data.stamps_count,
    stampsTarget: data.stamps_target,
    prizeRewardName: data.prize_reward_name,
    isCompleted: data.is_completed,
    completedAt: data.completed_at,
  };
}

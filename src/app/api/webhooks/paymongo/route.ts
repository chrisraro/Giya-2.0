import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const eventType = body?.data?.attributes?.type;

    if (eventType === "checkout_session.payment.paid") {
      const metadata = body?.data?.attributes?.data?.attributes?.metadata;
      const businessId = metadata?.business_id;
      const plan = metadata?.plan;

      if (businessId && plan) {
        const supabase = await createClient();
        await (supabase as any)
          .from("businesses")
          .update({
            plan,
            updated_at: new Date().toISOString(),
          })
          .eq("id", businessId);
      }
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Webhook handler error" },
      { status: 400 },
    );
  }
}

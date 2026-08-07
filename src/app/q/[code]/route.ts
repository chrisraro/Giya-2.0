import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const supabase = await createClient();

  const { data, error } = await (supabase as any)
    .from("qr_codes")
    .select(`
      code,
      business_id,
      target_type,
      target_id,
      businesses (
        slug
      )
    `)
    .eq("code", code)
    .maybeSingle();

  if (error || !data || !(data as any).businesses?.slug) {
    return NextResponse.redirect(new URL("/discover", request.url));
  }

  const slug = (data as any).businesses.slug;
  return NextResponse.redirect(new URL(`/b/${slug}`, request.url));
}

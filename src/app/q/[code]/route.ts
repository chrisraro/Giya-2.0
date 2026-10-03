import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

// Resolves ONE short code to a business page. Reads qr_codes through the
// service role because 0083 removed every client audience from that table
// (a public "using (true)" policy let anyone enumerate all codes, targets and
// scan counts). The lookup is exact-match on the code, and only businesses with
// status 'active' are followed: the old anon read got that for free from the
// public businesses policy, which the service role bypasses.
//
// Every failure (no credential, unknown code, inactive business, DB error)
// lands on /discover so a prober cannot tell a missing code from a hidden one.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const discover = () => NextResponse.redirect(new URL("/discover", request.url));

  const supabase = createServiceRoleClient();
  if (supabase === null) return discover();

  const { data, error } = await supabase
    .from("qr_codes")
    .select("code, business_id, target_type, target_id, businesses!inner ( slug, status )")
    .eq("code", code)
    .eq("businesses.status", "active")
    .maybeSingle();

  // An !inner many-to-one embed is a single object; normalise defensively in
  // case the generated relationship metadata ever types it as an array.
  const embedded = data?.businesses;
  const business = Array.isArray(embedded) ? embedded[0] : embedded;
  if (error || !data || business?.status !== "active" || !business?.slug) {
    return discover();
  }

  return NextResponse.redirect(new URL("/b/" + business.slug, request.url));
}

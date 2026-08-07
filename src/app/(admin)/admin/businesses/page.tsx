import { notFound } from "next/navigation";

import { canActOnLadder, resolveAdminContext } from "@/features/admin/access";
import { listBusinessesAwaitingReview } from "@/features/admin/businesses";
import { AdminBusinessesScreen } from "@/features/admin/businesses-screen";

export const dynamic = "force-dynamic";

interface AdminBusinessesPageProps {
  searchParams?: Promise<{ filter?: string }>;
}

export default async function AdminBusinessesPage({ searchParams }: AdminBusinessesPageProps) {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  const resolvedParams = searchParams ? await searchParams : {};
  const rawFilter = resolvedParams.filter;
  const filter: "pending" | "active" | "all" =
    rawFilter === "active" ? "active" : rawFilter === "all" ? "all" : "pending";

  const items = await listBusinessesAwaitingReview(filter);

  return (
    <AdminBusinessesScreen
      items={items ?? []}
      filter={filter}
      now={new Date()}
      canAct={canActOnLadder(admin.role)}
      unavailable={items === null}
    />
  );
}

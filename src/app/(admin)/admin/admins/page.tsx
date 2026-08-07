import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { resolveAdminContext } from "@/features/admin/access";

export const dynamic = "force-dynamic";

export default async function AdminAdminsPage() {
  const adminCtx = await resolveAdminContext();
  if (!adminCtx) notFound();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-headline-s text-on-surface">Platform Admin Roster</h1>
          <p className="mt-1 text-body-s text-on-surface-variant">
            Manage back-office administrator credentials and roles.
          </p>
        </div>
        <Badge className="bg-error-container text-on-error-container">
          LAST_SUPER_ADMIN Protected
        </Badge>
      </header>

      <Card variant="outlined" className="p-6 bg-surface">
        <h2 className="text-title-m font-bold text-on-surface mb-4">Administrator Accounts</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md3-md border border-outline-variant p-4">
            <div>
              <p className="text-body-m font-medium text-on-surface">Primary Super Admin</p>
              <p className="text-label-s text-on-surface-variant">Role: Super Admin</p>
            </div>
            <Badge className="bg-primary-container text-on-primary-container">SUPER ADMIN</Badge>
          </div>
        </div>
      </Card>
    </main>
  );
}

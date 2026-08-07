import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { resolveAdminContext } from "@/features/admin/access";

export const dynamic = "force-dynamic";

export default async function AdminConsumersPage() {
  const adminCtx = await resolveAdminContext();
  if (!adminCtx) notFound();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-headline-s text-on-surface">Consumer Management</h1>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Audit consumer activity, adjust fraud cooldowns, and manage account suspensions.
        </p>
      </header>

      <Card variant="outlined" className="p-6 bg-surface">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-title-m font-bold text-on-surface">Registered Consumers</h2>
          <Badge className="bg-surface-variant text-on-surface-variant">Active Monitoring</Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-body-s">
            <thead>
              <tr className="border-b border-outline-variant text-on-surface-variant">
                <th className="py-2.5 px-3">Display Name</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">Cooldown Until</th>
                <th className="py-2.5 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-outline-variant/50">
                <td className="py-3 px-3 font-medium text-on-surface">Sample Consumer</td>
                <td className="py-3 px-3">
                  <Badge className="bg-primary-container text-on-primary-container">Active</Badge>
                </td>
                <td className="py-3 px-3 text-on-surface-variant">None</td>
                <td className="py-3 px-3">
                  <button
                    type="button"
                    className="text-label-s text-error hover:underline"
                  >
                    Suspend
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}

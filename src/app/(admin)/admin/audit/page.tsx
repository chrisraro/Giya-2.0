import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { resolveAdminContext } from "@/features/admin/access";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const adminCtx = await resolveAdminContext();
  if (!adminCtx) notFound();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-headline-s text-on-surface">System Audit Logs</h1>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Immutable audit trail for all administrative and system lifecycle actions.
        </p>
      </header>

      <Card variant="outlined" className="p-6 bg-surface">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-title-m font-bold text-on-surface">Audit Records</h2>
          <Badge className="bg-surface-variant text-on-surface-variant">Filterable</Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-body-s">
            <thead>
              <tr className="border-b border-outline-variant text-on-surface-variant">
                <th className="py-2.5 px-3">Timestamp</th>
                <th className="py-2.5 px-3">Actor</th>
                <th className="py-2.5 px-3">Action</th>
                <th className="py-2.5 px-3">Target Entity</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-outline-variant/50">
                <td className="py-3 px-3 font-mono text-label-s text-on-surface-variant">
                  {new Date().toISOString()}
                </td>
                <td className="py-3 px-3 text-on-surface font-medium">system</td>
                <td className="py-3 px-3">
                  <Badge className="bg-secondary-container text-on-secondary-container">
                    job.health_check
                  </Badge>
                </td>
                <td className="py-3 px-3 text-on-surface-variant">cron.sweep</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}

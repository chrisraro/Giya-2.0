import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/business/kpi-card";
import { BarChart } from "@/components/business/bar-chart";
import { VerificationBanner } from "@/components/business/verification-banner";
import { EmptyState } from "@/components/consumer/empty-state";
import { MOCK_KPIS, MOCK_WEEK_VISITS, MOCK_ACTIVITY } from "@/lib/mock/business"; // TODO(api): replace mock

const FULL_DAY_NAMES: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

function busiestDayLabel(data: { day: string; value: number }[]) {
  const first = data[0];
  if (!first) return "Visits per day this week";
  const busiest = data.reduce((max, current) => (current.value > max.value ? current : max), first);
  const fullName = FULL_DAY_NAMES[busiest.day] ?? busiest.day;
  return `Visits per day this week, highest ${fullName}`;
}

export default function BusinessDashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <VerificationBanner />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {MOCK_KPIS.map((kpi) => (
          <KpiCard key={kpi.label} kpi={kpi} />
        ))}
      </div>

      <Card variant="outlined">
        <CardHeader>
          <CardTitle>Visits this week</CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart data={MOCK_WEEK_VISITS} ariaLabel={busiestDayLabel(MOCK_WEEK_VISITS)} />
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {MOCK_ACTIVITY.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {MOCK_ACTIVITY.map((item) => (
                <li key={item.id} className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
                    <span aria-hidden className="material-symbols-rounded text-[18px]">
                      {item.icon}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body-m text-on-surface">
                    {item.text}
                  </span>
                  <span className="shrink-0 text-body-s text-on-surface-variant">
                    {item.timeLabel}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon="receipt_long"
              title="No activity yet"
              body="Customer scans and redemptions will show up here as they happen."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

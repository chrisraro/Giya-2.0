import type { ReactNode } from "react";

import { formatDateTime } from "./presenter";
import { ReplayPanel } from "./queue-status-panel";
import type { DeadJobItem, QueueStatusView } from "./types";

// ===========================================================================
// `/admin/monitoring/queues` (doc 31 §5, doc 39's DLQ view).
//
// A SYNCHRONOUS, PROP-DRIVEN server component with one client island per dead
// row (`ReplayPanel`, a client component only because a reason has to be
// typed before anything can be submitted) - same shape as
// `businesses-screen.tsx` and `ladder-panel.tsx`.
//
// THREE INDEPENDENT UNAVAILABLE STATES, not one. `QueueStatusView`'s own doc
// explains why the three reads fail independently; this screen renders that
// literally rather than collapsing to a single banner, so a dead-letter read
// failure does not hide a jobs-by-status count that came back fine.
//
// NULL IS NOT EMPTY, this portal's rule everywhere: an empty dead-letter list
// is a claim that nothing on the platform needs attention, and a failed read
// is not entitled to make it. The brief names the exact incident this guards
// against (`getMyBalances`, the metrics loader) and this screen is written so
// the same conflation cannot happen a third time.
//
// Admin surfaces are utilitarian (doc 16, Locked): maximum density, zero
// expressive motion - no `animation:` anywhere in this file.
// ===========================================================================

/** Doc 39's five states, in the order `JOB_STATUSES`
 * (`src/lib/observability/metrics.ts`) declares them. Restated as a literal
 * tuple rather than imported at runtime: that module is `server-only`, and
 * pulling a runtime value from it into a component file would drag the
 * `server-only` pragma into whatever renders this screen in a test. */
const STATUS_ORDER = ["queued", "running", "succeeded", "failed", "dead"] as const;

const STATUS_LABELS: Record<(typeof STATUS_ORDER)[number], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed (between attempts)",
  dead: "Dead (needs a decision)",
};

function UnavailableNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-md3-md border border-outline bg-surface-container p-4 text-body-m text-on-surface"
    >
      {children}
    </div>
  );
}

function StatusTiles({ byStatus }: { byStatus: QueueStatusView["byStatus"] }) {
  if (byStatus === null) {
    return (
      <UnavailableNotice>
        Jobs-by-status counts could not be read right now. This is a failed read,
        not a claim that the queues are empty.
      </UnavailableNotice>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {STATUS_ORDER.map((status) => {
        const count = byStatus[status];
        return (
          <li
            key={status}
            className="rounded-md3-md border border-outline-variant bg-surface p-3"
          >
            <p className="text-label-s text-on-surface-variant">{STATUS_LABELS[status]}</p>
            <p className="text-headline-s text-on-surface">{count === null ? "Not read" : count}</p>
          </li>
        );
      })}
    </ul>
  );
}

function SweepHealthTable({ sweepHealth }: { sweepHealth: QueueStatusView["sweepHealth"] }) {
  if (sweepHealth === null) {
    return (
      <UnavailableNotice>
        Schedule health could not be read right now.
      </UnavailableNotice>
    );
  }

  if (sweepHealth.length === 0) {
    return <p className="text-body-s text-on-surface-variant">No scheduled sweeps have run yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-body-s">
        <thead>
          <tr className="border-b border-outline-variant text-left text-label-s text-on-surface-variant">
            <th className="py-2 pr-3">Schedule</th>
            <th className="py-2 pr-3">Cron</th>
            <th className="py-2 pr-3">Runs (24h)</th>
            <th className="py-2 pr-3">Failures (24h)</th>
            <th className="py-2 pr-3">Last status</th>
            <th className="py-2 pr-3">Last finished</th>
          </tr>
        </thead>
        <tbody>
          {sweepHealth.map((row) => (
            <tr key={row.jobname} className="border-b border-outline-variant last:border-0">
              <td className="py-2 pr-3 text-on-surface">
                {row.jobname}
                {!row.active && <span className="ml-2 text-on-surface-variant">(inactive)</span>}
              </td>
              <td className="py-2 pr-3 text-on-surface-variant">{row.schedule}</td>
              <td className="py-2 pr-3 text-on-surface">{row.runs}</td>
              <td className={row.failures > 0 ? "py-2 pr-3 text-error" : "py-2 pr-3 text-on-surface"}>
                {row.failures}
              </td>
              <td className="py-2 pr-3 text-on-surface">{row.lastStatus ?? "Never run"}</td>
              <td className="py-2 pr-3 text-on-surface-variant">{formatDateTime(row.lastFinishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** I6: "recorded" must also mean "discoverable" - `attempts` resets on every
 * replay, so this chip is the only thing on the screen that tells a job's
 * fifth replay apart from its first. Renders nothing for a never-replayed
 * job (0 is not worth a chip) and a distinct, honest note when the read
 * itself failed - never a silent 0 standing in for "could not find out". */
function ReplayCountChip({ replayCount }: { replayCount: number | null }) {
  if (replayCount === null) {
    return <span className="text-label-s text-on-surface-variant">replay history unavailable</span>;
  }
  if (replayCount === 0) return null;
  return (
    <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-label-s text-on-surface-variant">
      Replayed {replayCount} time{replayCount === 1 ? "" : "s"}
    </span>
  );
}

function DeadJobRow({ item, canAct }: { item: DeadJobItem; canAct: boolean }) {
  return (
    <li className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label-l text-on-surface">{item.queue}</span>
          <span className="rounded-full bg-error-container px-2 py-0.5 text-label-s text-on-error-container">
            {item.attempts}/{item.maxAttempts} attempts
          </span>
          <ReplayCountChip replayCount={item.replayCount} />
        </div>
        <p className="truncate text-body-m text-on-surface">{item.payloadIdentity}</p>
        <p className="text-body-s text-on-surface-variant">
          Died {formatDateTime(item.deadAt)}
          {item.businessId !== null && ` · business ${item.businessId}`}
        </p>
        {item.lastError !== null && (
          <p className="truncate text-body-s text-error" title={item.lastError}>
            {item.lastError}
          </p>
        )}
      </div>
      <div className="shrink-0">
        <ReplayPanel jobId={item.jobId} canAct={canAct} />
      </div>
    </li>
  );
}

function DeadLetterList({
  deadJobs,
  deadTotal,
  canAct,
}: {
  deadJobs: QueueStatusView["deadJobs"];
  /** `byStatus.dead` - the exact count, read independently of this list (see
   * `loadQueueStatus`). Used only to say when the list below is a partial
   * view of it (I5), never to replace the list's own null/empty handling. */
  deadTotal: number | null;
  canAct: boolean;
}) {
  if (deadJobs === null) {
    return (
      <UnavailableNotice>
        The dead-letter list could not be read right now. Do not read this as
        &quot;nothing is dead&quot; - try again shortly.
      </UnavailableNotice>
    );
  }

  if (deadJobs.length === 0) {
    return (
      <p className="rounded-md3-md border border-outline-variant bg-surface p-4 text-body-m text-on-surface-variant">
        Nothing is dead right now.
      </p>
    );
  }

  // I5: the list is capped (`DEAD_JOBS_LIMIT`, "a working list, not an
  // archive"). When the exact count says more exist than this page shows,
  // say so rather than let a truncated list read as the whole truth - the
  // same honesty doctrine that keeps a failed read from rendering as empty.
  const truncated = deadTotal !== null && deadTotal > deadJobs.length;

  return (
    <div className="flex flex-col gap-3">
      {truncated && (
        <p className="text-body-s text-on-surface-variant">
          Showing the {deadJobs.length} oldest of {deadTotal} dead jobs.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {deadJobs.map((item) => (
          <DeadJobRow key={item.jobId} item={item} canAct={canAct} />
        ))}
      </ul>
    </div>
  );
}

export interface QueueStatusScreenProps extends QueueStatusView {
  /** doc 31 §5: admin/super_admin only. `support` sees this screen read-only. */
  canAct: boolean;
}

export function QueueStatusScreen({ byStatus, sweepHealth, deadJobs, canAct }: QueueStatusScreenProps) {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-headline-s text-on-surface">Queue status</h1>
        <p className="text-body-s text-on-surface-variant">
          Every background job on the platform (doc 39). Replaying a dead job
          gives it a fresh attempt budget, never a bypassed one - each replay is
          recorded in the audit log.
        </p>
        {!canAct && (
          <p
            role="note"
            className="mt-2 rounded-md3-sm border border-outline bg-surface-container p-3 text-body-s text-on-surface"
          >
            Your account is read-only. You can see everything on this page and
            replay nothing.
          </p>
        )}
      </div>

      <section aria-labelledby="status-heading" className="flex flex-col gap-3">
        <h2 id="status-heading" className="text-title-m text-on-surface">
          Jobs by status
        </h2>
        <StatusTiles byStatus={byStatus} />
      </section>

      <section aria-labelledby="sweep-heading" className="flex flex-col gap-3">
        <h2 id="sweep-heading" className="text-title-m text-on-surface">
          Schedule health
        </h2>
        <SweepHealthTable sweepHealth={sweepHealth} />
      </section>

      <section aria-labelledby="dead-heading" className="flex flex-col gap-3">
        <h2 id="dead-heading" className="text-title-m text-on-surface">
          Dead letters
        </h2>
        <DeadLetterList deadJobs={deadJobs} deadTotal={byStatus?.dead ?? null} canAct={canAct} />
      </section>
    </div>
  );
}

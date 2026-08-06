import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ===========================================================================
// `/admin/monitoring/queues`, the same "REAL DATA OR AN HONEST ABSENCE, NEVER
// A FIXTURE" property `screens.test.tsx` guards for the fraud/receipts
// queues and the overview - reproduced here for the three independently
// nullable slices this screen renders (`QueueStatusView`'s own doc explains
// why there are three, not one).
// ===========================================================================

vi.mock("./queue-status-actions", () => ({ replayJobAction: vi.fn() }));

import { QueueStatusScreen } from "./queue-status-screen";
import type { DeadJobItem, QueueStatusView } from "./types";

function byStatus(overrides: Partial<Record<string, number | null>> = {}) {
  return {
    queued: 2,
    running: 1,
    succeeded: 4000,
    failed: 0,
    dead: 0,
    ...overrides,
  } as QueueStatusView["byStatus"];
}

function deadJob(overrides: Partial<DeadJobItem> = {}): DeadJobItem {
  return {
    jobId: "job-1",
    queue: "notify.email",
    businessId: "biz-1",
    payloadIdentity: "notification_ids=[1]",
    attempts: 5,
    maxAttempts: 5,
    lastError: "resend 503 x5",
    deadAt: "2026-07-26T10:00:00.000Z",
    createdAt: "2026-07-26T08:00:00.000Z",
    replayCount: 0,
    ...overrides,
  };
}

const view: QueueStatusView = { byStatus: byStatus(), sweepHealth: [], deadJobs: [] };

describe("QueueStatusScreen: jobs by status", () => {
  it("renders the counts it is given", () => {
    render(<QueueStatusScreen {...view} byStatus={byStatus({ dead: 3 })} canAct />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  // Mutant: render `0` (or the empty state) instead of the unavailable
  // banner when byStatus is null. A dropped connection must not be readable
  // as "every queue is at zero", which for `dead` specifically would hide an
  // active incident.
  it("renders an alert, not zeroes, when the count read failed", () => {
    render(<QueueStatusScreen {...view} byStatus={null} canAct />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be read/i);
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  });

  it("shows a per-status null as 'Not read', distinct from a real zero", () => {
    render(<QueueStatusScreen {...view} byStatus={byStatus({ dead: null })} canAct />);
    expect(screen.getByText("Not read")).toBeInTheDocument();
  });
});

describe("QueueStatusScreen: dead letters", () => {
  // Mutant: collapse `deadJobs === null` and `deadJobs.length === 0` into
  // the same branch. The brief names the exact incident (`getMyBalances`,
  // the metrics loader) this distinction exists to prevent from recurring a
  // third time.
  it("distinguishes 'nothing is dead' from 'the dead-letter read failed'", () => {
    const { rerender } = render(<QueueStatusScreen {...view} deadJobs={[]} canAct />);
    expect(screen.getByText("Nothing is dead right now.")).toBeInTheDocument();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    rerender(<QueueStatusScreen {...view} deadJobs={null} canAct />);
    expect(screen.queryByText("Nothing is dead right now.")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be read/i);
  });

  it("renders each dead job's queue, attempts, payload identity and last error", () => {
    render(
      <QueueStatusScreen
        {...view}
        deadJobs={[deadJob({ queue: "ocr.process", attempts: 3, maxAttempts: 3, lastError: "OCR timeout" })]}
        canAct
      />,
    );
    expect(screen.getByText("ocr.process")).toBeInTheDocument();
    expect(screen.getByText("3/3 attempts")).toBeInTheDocument();
    expect(screen.getByText("notification_ids=[1]")).toBeInTheDocument();
    expect(screen.getByText("OCR timeout")).toBeInTheDocument();
  });

  // Mutant: pass `canAct` straight through as `true` regardless of the prop
  // (or drop the prop from the Replay button entirely). Doc 31 §5 scopes
  // this screen to admin/super_admin; a `support` admin must see the Replay
  // control disabled, not merely absent, which is what "assert the
  // refusal, not just the absence of a link" means for this UI layer.
  it("disables the Replay control for a read-only (support) admin", () => {
    render(<QueueStatusScreen {...view} deadJobs={[deadJob()]} canAct={false} />);
    expect(screen.getByRole("button", { name: "Replay" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(/read-only/i);
  });

  it("enables the Replay control for an admin who can act", () => {
    render(<QueueStatusScreen {...view} deadJobs={[deadJob()]} canAct />);
    expect(screen.getByRole("button", { name: "Replay" })).toBeEnabled();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  // I5. Mutant: drop the truncation notice, or compute it from the list
  // length alone without comparing to the exact `byStatus.dead` count. A
  // capped list rendered with no indication of a cap reads as the whole
  // truth on a platform with more than 100 dead jobs.
  it("says when the list is a partial view of a larger exact count", () => {
    const jobs = Array.from({ length: 3 }, (_unused, index) => deadJob({ jobId: `job-${index}` }));
    render(<QueueStatusScreen {...view} byStatus={byStatus({ dead: 250 })} deadJobs={jobs} canAct />);
    expect(screen.getByText("Showing the 3 oldest of 250 dead jobs.")).toBeInTheDocument();
  });

  it("says nothing about truncation when the list already shows every dead job", () => {
    const jobs = [deadJob()];
    render(<QueueStatusScreen {...view} byStatus={byStatus({ dead: 1 })} deadJobs={jobs} canAct />);
    expect(screen.queryByText(/oldest of/i)).not.toBeInTheDocument();
  });

  it("does not claim truncation when the exact count itself could not be read", () => {
    const jobs = [deadJob()];
    render(<QueueStatusScreen {...view} byStatus={null} deadJobs={jobs} canAct />);
    expect(screen.queryByText(/oldest of/i)).not.toBeInTheDocument();
  });

  // I6. Mutant: render nothing for `replayCount`, or render `0` the same way
  // as `null` (the audit-history read failed). `attempts` resets on every
  // replay, so this chip is the only thing that tells a job's fifth replay
  // apart from its first.
  it("shows how many times a job has already been replayed", () => {
    render(<QueueStatusScreen {...view} deadJobs={[deadJob({ replayCount: 3 })]} canAct />);
    expect(screen.getByText("Replayed 3 times")).toBeInTheDocument();
  });

  it("renders no replay-count chip for a job that has never been replayed", () => {
    render(<QueueStatusScreen {...view} deadJobs={[deadJob({ replayCount: 0 })]} canAct />);
    expect(screen.queryByText(/^Replayed/)).not.toBeInTheDocument();
  });

  it("says replay history is unavailable rather than showing a false zero", () => {
    render(<QueueStatusScreen {...view} deadJobs={[deadJob({ replayCount: null })]} canAct />);
    expect(screen.getByText("replay history unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/^Replayed/)).not.toBeInTheDocument();
  });
});

describe("QueueStatusScreen: schedule health", () => {
  it("renders an alert when sweep health could not be read", () => {
    render(<QueueStatusScreen {...view} sweepHealth={null} canAct />);
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((node) => /schedule health/i.test(node.textContent ?? ""))).toBe(true);
  });

  it("renders a row per schedule, flagging a nonzero failure count", () => {
    render(
      <QueueStatusScreen
        {...view}
        sweepHealth={[
          {
            jobname: "campaigns-sweep",
            schedule: "*/5 * * * *",
            active: true,
            runs: 12,
            failures: 2,
            lastStatus: "failed",
            lastFinishedAt: "2026-07-26T11:55:00.000Z",
            lastError: "timeout",
          },
        ]}
        canAct
      />,
    );
    const row = screen.getByText("campaigns-sweep").closest("tr");
    expect(row).not.toBeNull();
    if (row !== null) {
      expect(within(row).getByText("2")).toHaveClass("text-error");
    }
  });
});

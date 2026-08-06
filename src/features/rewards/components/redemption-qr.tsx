"use client";

import * as React from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";

import { getClaimStatus } from "../actions";
import { CancelClaimButton } from "./cancel-claim-button";
import type { ClaimDetailDTO, RewardClaimRow } from "../types";

export interface RedemptionQrProps {
  claim: ClaimDetailDTO;
}

type Phase =
  | "redeemed"
  | "unavailable"
  | "offline"
  | "minting"
  | "ready"
  | "code-expired"
  | "claim-error"
  | "mint-error";

const POLL_INTERVAL_MS = 5_000;
// Grace period before arming the poll fallback even when the Realtime
// channel reports SUBSCRIBED - a belt-and-suspenders net in case
// postgres_changes silently never fires (e.g. Realtime not enabled for this
// table at the project level; see task-5-report.md's realtime-vs-poll note).
const FALLBACK_POLL_DELAY_MS = 8_000;

const UNAVAILABLE_MESSAGE: Record<string, string> = {
  expired: "This claim has expired.",
  cancelled: "This claim was cancelled.",
};

/** Consumer-facing copy for a claim that isn't in a mintable state at all
 * (redeemed is handled separately - see initialPhase). Exported and pure so
 * it's directly unit-testable without rendering the component. */
export function unavailableMessage(status: string): string {
  return UNAVAILABLE_MESSAGE[status] ?? "This claim cannot be redeemed right now.";
}

/**
 * The screen's starting phase, computed once from the server-loaded claim
 * (no need to ever mint a token for a claim that's already redeemed or
 * cannot be redeemed at all). Pure + exported for thorough unit testing -
 * see redemption-qr.test.tsx.
 */
export function initialPhase(
  claim: Pick<ClaimDetailDTO, "status" | "expiresAt">,
  options: { isOnline: boolean; now?: Date },
): Phase {
  const now = options.now ?? new Date();
  if (claim.status === "redeemed") return "redeemed";
  if (claim.status !== "claimed" || new Date(claim.expiresAt).getTime() <= now.getTime()) {
    return "unavailable";
  }
  if (!options.isOnline) return "offline";
  return "minting";
}

/**
 * mm:ss text for a millisecond duration; negative/zero clamps to "0:00" and
 * a sub-second remainder rounds UP (never truncates to 0 while time is
 * technically still left) - a customer should never see "expired" a beat
 * before the code actually expires. Pure + exported: this is the one piece
 * of this screen worth testing exhaustively per the task-5 brief.
 */
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface MintSuccess {
  ok: true;
  token: string;
  expiresAt: number;
}
interface MintFailure {
  ok: false;
  code: string;
  message: string;
}

async function mintToken(claimId: string): Promise<MintSuccess | MintFailure> {
  try {
    const response = await fetch(`/api/v1/reward-claims/${claimId}/token`, { method: "POST" });
    const body = (await response.json()) as {
      data?: { token: string; expires_at: string };
      error?: { code: string; message: string };
    };
    if (!response.ok || !body.data) {
      return {
        ok: false,
        code: body.error?.code ?? "INTERNAL",
        message: body.error?.message ?? "Something went wrong. Please try again.",
      };
    }
    return { ok: true, token: body.data.token, expiresAt: new Date(body.data.expires_at).getTime() };
  } catch {
    return { ok: false, code: "NETWORK", message: "Something went wrong. Please try again." };
  }
}

const BACK_TO_REWARDS_CLASS =
  "mt-2 inline-flex h-12 items-center rounded-full bg-secondary-container px-6 text-label-l text-on-secondary-container transition-colors duration-200 ease-standard hover:opacity-90";

/**
 * The redemption QR screen (client). Mints a short-lived token on mount,
 * shows a live mm:ss countdown, and flips to a success view the moment the
 * claim is redeemed - via a Supabase Realtime subscription on the claim row
 * with a polling fallback (see task-5-report.md for why both exist).
 *
 * QR CONTRAST: the code renders on a hard-coded white card (`bg-white`),
 * not an MD3 surface token. This is a deliberate, isolated exception to
 * "tokens only": `surface-container-
 * lowest` is the LIGHTEST surface role in light theme, but MD3's dark-theme
 * scale runs the other way (it's the DARKEST container in dark theme - see
 * src/styles/md3-tokens.css), so theming this card would hand a near-black
 * background to a dark-mode phone screen, which most camera-based scanners
 * struggle to read reliably. A QR code's scannability must not depend on
 * the viewer's theme preference.
 */
export function RedemptionQr({ claim }: RedemptionQrProps) {
  const [phase, setPhase] = React.useState<Phase>(() =>
    initialPhase(claim, { isOnline: typeof navigator === "undefined" ? true : navigator.onLine }),
  );
  const [token, setToken] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const claimId = claim.claimId;

  // Mint (or re-mint, via the Refresh/Retry buttons setting phase back to
  // "minting"). Already-redeemed is treated as good news, not an error - a
  // concurrent scan beating this mint attempt still ends in the success view.
  React.useEffect(() => {
    if (phase !== "minting") return;
    let cancelled = false;

    void (async () => {
      const result = await mintToken(claimId);
      if (cancelled) return;

      if (!result.ok) {
        if (result.code === "CLAIM_ALREADY_REDEEMED") {
          setPhase("redeemed");
          return;
        }
        setErrorMessage(result.message);
        setPhase(
          result.code === "CLAIM_EXPIRED" ||
            result.code === "CLAIM_INVALID_STATE" ||
            result.code === "NOT_FOUND"
            ? "claim-error"
            : "mint-error",
        );
        return;
      }

      setToken(result.token);
      setExpiresAt(result.expiresAt);
      setNowTick(Date.now());
      setErrorMessage(null);
      setPhase("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, claimId]);

  // Countdown tick while a code is showing.
  React.useEffect(() => {
    if (phase !== "ready" || expiresAt === null) return;
    const interval = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setPhase("code-expired");
      } else {
        setNowTick(Date.now());
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [phase, expiresAt]);

  // Best-effort screen wake lock while a code is showing - never blocks or
  // surfaces a failure; older/unsupported browsers just don't get it.
  React.useEffect(() => {
    if (phase !== "ready") return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;
    navigator.wakeLock
      .request("screen")
      .then((s) => {
        if (released) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
      })
      .catch(() => {
        // Not supported, or refused (e.g. tab backgrounded) - the QR still
        // works, the screen just might dim sooner. Never user-facing.
      });

    return () => {
      released = true;
      void sentinel?.release().catch(() => {});
    };
  }, [phase]);

  // Browser online/offline transitions.
  React.useEffect(() => {
    function handleOffline() {
      setPhase((current) => (current === "redeemed" || current === "unavailable" ? current : "offline"));
    }
    function handleOnline() {
      setPhase((current) => (current === "offline" ? "minting" : current));
    }
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  // Realtime subscription on this claim row (sanctioned per doc 10 D5:
  // "redemption confirmation" - the consumer's own QR screen watching for
  // its claim to flip to 'redeemed' is the same use, just the other
  // screen), with a polling fallback via the getClaimStatus server action
  // if the channel errors, times out, or simply never confirms in time.
  const awaitingRedemption = phase !== "redeemed" && phase !== "unavailable";

  React.useEffect(() => {
    if (!awaitingRedemption) return;

    const supabase = createClient();
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        void getClaimStatus(claimId).then((result) => {
          if (!settled && result?.status === "redeemed") {
            settled = true;
            setPhase("redeemed");
          }
        });
      }, POLL_INTERVAL_MS);
    }

    const channel = supabase
      .channel(`reward-claim-${claimId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "reward_claims", filter: `id=eq.${claimId}` },
        (payload: RealtimePostgresChangesPayload<RewardClaimRow>) => {
          const status = (payload.new as Partial<RewardClaimRow>).status;
          if (!settled && status === "redeemed") {
            settled = true;
            setPhase("redeemed");
          }
        },
      )
      .subscribe((status) => {
        if (!settled && (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")) {
          startPolling();
        }
      });

    const fallbackTimer = setTimeout(() => {
      if (!settled) startPolling();
    }, FALLBACK_POLL_DELAY_MS);

    return () => {
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      clearTimeout(fallbackTimer);
      void supabase.removeChannel(channel);
    };
  }, [awaitingRedemption, claimId]);

  const msRemaining = expiresAt !== null ? expiresAt - nowTick : 0;

  // Task 1.4: the cancel affordance on the claim detail screen. Gated on the
  // ORIGINAL server-loaded status (never redeemed/expired/cancelled reach
  // this component in a claimed-looking phase to begin with - see
  // initialPhase) AND the live phase not yet having flipped to "redeemed"
  // (a concurrent staff scan winning the race while this screen is open) or
  // "unavailable"/"claim-error" (not actually a live claimed row). Shown
  // through every other phase - minting, ready, offline, code-expired,
  // mint-error - because all of those still mean "this claim is claimed and
  // cancellable", a technical hiccup minting the QR code notwithstanding.
  const canCancel =
    claim.status === "claimed" &&
    phase !== "redeemed" &&
    phase !== "unavailable" &&
    phase !== "claim-error";

  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-6 px-4 pt-6 pb-8 text-center">
      <div>
        <p className="text-title-m text-on-surface">{claim.rewardName}</p>
        <p className="text-body-s text-on-surface-variant">{claim.businessName}</p>
      </div>

      {phase === "redeemed" ? (
        <>
          <Card
            variant="filled"
            className="flex w-full flex-col items-center gap-3 bg-secondary-container p-8"
          >
            <span
              aria-hidden
              className="material-symbols-rounded is-filled text-[48px] text-on-secondary-container"
            >
              check_circle
            </span>
            <p className="text-title-l text-on-secondary-container">Redeemed</p>
            <p className="text-body-s text-on-secondary-container">This reward has been redeemed.</p>
          </Card>
          <Link href="/rewards" className={BACK_TO_REWARDS_CLASS}>
            Back to Rewards
          </Link>
        </>
      ) : null}

      {phase === "unavailable" ? (
        <>
          <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8">
            <span aria-hidden className="material-symbols-rounded text-[48px] text-on-surface-variant">
              block
            </span>
            <p className="text-body-l text-on-surface">{unavailableMessage(claim.status)}</p>
          </Card>
          <Link href="/rewards" className={BACK_TO_REWARDS_CLASS}>
            Back to Rewards
          </Link>
        </>
      ) : null}

      {phase === "claim-error" ? (
        <>
          <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8">
            <p className="text-body-l text-on-surface">{errorMessage}</p>
          </Card>
          <Link href="/rewards" className={BACK_TO_REWARDS_CLASS}>
            Back to Rewards
          </Link>
        </>
      ) : null}

      {phase === "offline" ? (
        <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8">
          <span aria-hidden className="material-symbols-rounded text-[48px] text-on-surface-variant">
            wifi_off
          </span>
          <p className="text-body-l text-on-surface">You are offline</p>
          <p className="text-body-s text-on-surface-variant">
            A redemption code needs an internet connection to generate and verify. This screen will pick
            back up automatically once you reconnect.
          </p>
        </Card>
      ) : null}

      {phase === "minting" ? (
        <>
          <Skeleton className="size-56 rounded-md3-lg" />
          <p className="text-body-s text-on-surface-variant">Generating your code...</p>
        </>
      ) : null}

      {phase === "mint-error" ? (
        <>
          <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8">
            <p className="text-body-l text-on-surface">
              {errorMessage ?? "Something went wrong. Please try again."}
            </p>
          </Card>
          <Button type="button" variant="filled" size="touch" onClick={() => setPhase("minting")}>
            Retry
          </Button>
        </>
      ) : null}

      {phase === "ready" && token ? (
        <>
          {/* Hard-coded white, not a surface token - see the QR CONTRAST
              note in this file's header comment. QRCodeSVG's own defaults
              are already white/black, so no bgColor/fgColor props are
              needed here - and raw hex literals are lint-banned in src/
              anyway (docs/10-architecture/16-design-system.md). */}
          <div className="rounded-md3-lg bg-white p-6 shadow-md">
            <QRCodeSVG value={token} size={224} />
          </div>
          <p className="font-mono text-headline-s text-on-surface">{formatCountdown(msRemaining)}</p>
          <p className="text-body-s text-on-surface-variant">Show this code to staff to redeem</p>
        </>
      ) : null}

      {phase === "code-expired" ? (
        <>
          <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8">
            <span aria-hidden className="material-symbols-rounded text-[48px] text-on-surface-variant">
              timer_off
            </span>
            <p className="text-title-m text-on-surface">Code expired</p>
            <p className="text-body-s text-on-surface-variant">Get a fresh code to redeem this reward.</p>
          </Card>
          <Button type="button" variant="filled" size="touch" onClick={() => setPhase("minting")}>
            Refresh code
          </Button>
        </>
      ) : null}

      {canCancel ? (
        <CancelClaimButton claimId={claim.claimId} pointsSpent={claim.pointsSpent} className="mt-2" />
      ) : null}
    </main>
  );
}

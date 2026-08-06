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
  | "cancelled"
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
 * Review fix I2. Three places need to react when this screen learns the
 * claim's status has changed out from under it - a `claim` prop update
 * (router.refresh() after THIS screen's own cancel action; see the
 * prop-sync effect below), a Realtime UPDATE payload, and the poll
 * fallback - and before this fix each of those three call sites handled
 * only "redeemed" (two of them) or nothing (the prop never re-derived
 * `phase` at all, which is the bug the review caught: the screen kept
 * showing a live QR and ticking countdown after the consumer cancelled
 * from this very screen). Centralizing the decision here means the three
 * call sites cannot drift on what counts as a terminal transition, the
 * same reasoning 0050/0051 already applied to the ledger reversal itself.
 *
 * Sticky once terminal: a stale or duplicate event can never regress an
 * already-redeemed or already-cancelled phase back to something live.
 * Any OTHER observed status (including the initial "claimed" a mount-time
 * effect run will pass) is a no-op - this function only ever moves
 * forward into a terminal phase, never sideways.
 */
export function nextPhaseForStatus(current: Phase, status: string): Phase {
  if (current === "redeemed" || current === "cancelled") return current;
  if (status === "redeemed") return "redeemed";
  if (status === "cancelled") return "cancelled";
  // N4 (review): 'expired' is deliberately NOT terminal here, and that is a
  // decision rather than an omission. The claim-expiry sweep can flip a row
  // claimed -> expired while this screen is open, but by then the token's own
  // 5-minute TTL has long since driven the phase to 'code-expired', which
  // already tells the truth; and `canCancel` reads `claim.status` directly,
  // so the cancel affordance disappears regardless. Adding it here would
  // change what a customer sees mid-countdown for no gain. Revisit if the
  // token TTL ever exceeds the claim window.
  return current;
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

  // Review fix I2. router.refresh() after this screen's OWN cancel action
  // (<CancelClaimButton>, below) re-renders the server component tree and
  // hands this already-mounted client component a NEW `claim` prop - but a
  // soft navigation preserves client state, so `phase` never re-derives on
  // its own from a prop change the way it did once, at mount, via
  // initialPhase.
  //
  // This is React's own sanctioned "adjusting state when a prop changes"
  // pattern (https://react.dev/learn/you-might-not-need-an-effect), not a
  // useEffect: the check runs DURING RENDER, so a changed prop is corrected
  // before anything commits, with no extra flush and no
  // react-hooks/set-state-in-effect footgun (calling setState from inside
  // an effect body, as this used to). `observedStatus` is the previous
  // render's claim.status, purely so this can detect "it changed" without
  // an effect; on mount it always equals claim.status, so this is a
  // deliberate no-op then (initialPhase already accounted for the starting
  // status, and feeding the SAME status through nextPhaseForStatus never
  // moves off it).
  const [observedStatus, setObservedStatus] = React.useState(claim.status);
  if (claim.status !== observedStatus) {
    setObservedStatus(claim.status);
    setPhase((current) => nextPhaseForStatus(current, claim.status));
  }

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
      setPhase((current) =>
        current === "redeemed" || current === "cancelled" || current === "unavailable" ? current : "offline",
      );
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
  // Review fix I2: this now watches for "cancelled" too, not just
  // "redeemed" - a consumer can cancel from a DIFFERENT tab/session while
  // this exact screen is open, and only Realtime/poll (not the prop-sync
  // effect above, which only fires on THIS component's own props changing)
  // can ever learn about that.
  const awaitingOutcome = phase !== "redeemed" && phase !== "cancelled" && phase !== "unavailable";

  React.useEffect(() => {
    if (!awaitingOutcome) return;

    const supabase = createClient();
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function observe(status: string | undefined) {
      if (settled || status === undefined) return;
      // N3 (review): route through the same pure decision the prop-sync path
      // uses, rather than re-deriving a subset of it here. The two were
      // behaviourally equivalent, but three comments claimed a single source
      // of truth that did not exist - which is exactly how they drift the
      // next time a terminal status is added.
      let observed = false;
      setPhase((current) => {
        const next = nextPhaseForStatus(current, status);
        observed = next !== current;
        return next;
      });
      if (observed) settled = true;
    }

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        void getClaimStatus(claimId).then((result) => observe(result?.status));
      }, POLL_INTERVAL_MS);
    }

    const channel = supabase
      .channel(`reward-claim-${claimId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "reward_claims", filter: `id=eq.${claimId}` },
        (payload: RealtimePostgresChangesPayload<RewardClaimRow>) => {
          observe((payload.new as Partial<RewardClaimRow>).status);
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
  }, [awaitingOutcome, claimId]);

  const msRemaining = expiresAt !== null ? expiresAt - nowTick : 0;

  // The cancel affordance on the claim detail screen. Gated on claim.status
  // === "claimed" (review fix M2: NOT on phase !== "unavailable" - that
  // phase also fires for a claimed-but-past-expiry row, which
  // cancel_claim's own guard (0050) happily accepts; checking claim.status
  // directly already excludes the other two reasons "unavailable" can fire,
  // a genuinely 'expired' or 'cancelled' server status, so ClaimList and
  // this screen now agree on exactly the same claims) and on the live phase
  // not yet having flipped to "redeemed" or "cancelled" (review fix I2:
  // either can happen while this screen is open, from a concurrent staff
  // scan or a concurrent cancel elsewhere) or "claim-error". Shown through
  // every other phase - minting, ready, offline, code-expired, mint-error -
  // because all of those still mean "this claim is claimed and
  // cancellable", a technical hiccup minting the QR code notwithstanding.
  const canCancel =
    claim.status === "claimed" &&
    phase !== "redeemed" &&
    phase !== "cancelled" &&
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

      {/* Review fix I2: a terminal phase reached LIVE (via the prop-sync
          effect after this screen's own cancel, or Realtime/poll noticing a
          cancel from elsewhere) rather than at initial load - unlike
          "unavailable" above, whose copy reads the (possibly stale)
          claim.status prop, this reads the fixed, always-correct
          "cancelled" string, since a live transition is the one case where
          the prop is not guaranteed to have caught up yet. */}
      {phase === "cancelled" ? (
        <>
          <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8">
            <span aria-hidden className="material-symbols-rounded text-[48px] text-on-surface-variant">
              block
            </span>
            <p className="text-body-l text-on-surface">{unavailableMessage("cancelled")}</p>
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

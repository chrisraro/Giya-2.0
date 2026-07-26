"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/pending-button";
import { cn } from "@/lib/utils";

import { connectMetaPages, disconnectMeta, startMetaConnect } from "../actions";
import { needsReconnect, type MetaConnectionView, type MetaIntegrationView } from "../types";

// =============================================================================
// The connected-accounts card on /business/settings.
// =============================================================================
//
// doc 42's V1 scope for this surface is the CONNECTION, not what it produces.
// INSIGHTS TILES ARE OUT OF SCOPE FOR THIS SLICE and deliberately so: the
// connection is the foundation everything else stands on, and a tile rendered
// against a connection whose token lifecycle is not yet proven is a tile that
// breaks in a way merchants blame on the numbers. Doc 32's analytics tiles pick
// this up once the connection has been through a real app review.
//
// -----------------------------------------------------------------------------
// WHAT RENDERS WHEN THE INTEGRATION IS DORMANT
// -----------------------------------------------------------------------------
//
// META_APP_ID and META_APP_SECRET do not exist yet, so `configured` is false in
// every environment today, and this card's most-exercised state is the one
// below. It renders a plain, honest, non-alarming panel that says the feature
// is not available yet - and NO Connect button, because a button that opens a
// broken consent dialog is worse than no button. It is not an error state: no
// red, no warning icon. Nothing is wrong; something is simply not switched on.
//
// `storageReady` is a SEPARATE flag with its own copy for the same reason it is
// a separate check in the service: it is a different missing variable with a
// different fix, and a merchant support ticket that says "not configured" for
// both is a ticket nobody can act on.
//
// Every colour below is an MD3 role token, so both themes follow the palette
// with no per-theme overrides in this file.

export interface MetaConnectionCardProps {
  readonly view: MetaIntegrationView;
  /** The `?meta=` flag the OAuth callback redirected back with, if any. */
  readonly outcome: string | null;
  /** The pending selection id from `?sid=`, when the merchant must pick. */
  readonly selectionId: string | null;
  /** The Pages offered by that selection. Never carries a token. */
  readonly selectablePages: readonly { id: string; name: string; category: string | null }[];
}

const STATUS_COPY: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  connected: { label: "Connected", tone: "ok" },
  expired: { label: "Needs reconnecting", tone: "warn" },
  revoked: { label: "Access removed", tone: "warn" },
  error: { label: "Something went wrong", tone: "bad" },
};

const OUTCOME_COPY: Record<string, string> = {
  cancelled: "You cancelled before granting access. Nothing was connected.",
  denied: "Only an owner or manager can connect an account.",
  rejected: "That link was no longer valid. Please start again from this page.",
  failed: "We could not complete the connection. Please try again.",
  unavailable: "Facebook is not responding right now. Please try again in a few minutes.",
  no_pages: "That Facebook account does not manage any Page yet. Create a Page, then try again.",
  not_configured: "Connections are not available on this deployment yet.",
};

function StatusPill({ status }: { status: string }) {
  const copy = STATUS_COPY[status] ?? { label: status, tone: "warn" as const };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
        copy.tone === "ok" && "bg-secondary-container text-on-secondary-container",
        copy.tone === "warn" && "bg-surface-container-highest text-on-surface-variant",
        copy.tone === "bad" && "bg-error-container text-on-error-container",
      )}
    >
      {copy.label}
    </span>
  );
}

function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" });
}

function ConnectionRow({
  connection,
  canManage,
  onDisconnect,
  disconnecting,
}: {
  connection: MetaConnectionView;
  canManage: boolean;
  onDisconnect: (id: string) => void;
  disconnecting: string | null;
}) {
  const expires = formatDate(connection.tokenExpiresAt);

  return (
    <li className="flex flex-col gap-3 rounded-md3-sm border border-outline-variant p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-title-s text-on-surface">
            {connection.externalAccountName ?? connection.externalAccountId}
          </span>
          <StatusPill status={connection.status} />
        </div>

        {needsReconnect(connection.status) ? (
          <p className="text-body-s text-on-surface-variant">
            {connection.status === "revoked"
              ? "Access was removed on Facebook. Reconnect to bring insights back."
              : "The access we were given has expired. Reconnect to bring insights back."}
          </p>
        ) : null}

        {connection.status === "error" && connection.error !== null ? (
          <p className="text-body-s text-error">{connection.error}</p>
        ) : null}

        {connection.scopes.length > 0 ? (
          <p className="text-body-s text-on-surface-variant">
            Permissions granted: {connection.scopes.join(", ")}
          </p>
        ) : null}

        {expires !== null && connection.status === "connected" ? (
          <p className="text-body-s text-on-surface-variant">
            Access renews automatically before {expires}.
          </p>
        ) : null}
      </div>

      {canManage ? (
        <PendingButton
          variant="text"
          size="sm"
          pending={disconnecting === connection.id}
          pendingLabel="Disconnecting"
          onClick={() => onDisconnect(connection.id)}
          className="self-start"
        >
          Disconnect
        </PendingButton>
      ) : null}
    </li>
  );
}

export function MetaConnectionCard({
  view,
  outcome,
  selectionId,
  selectablePages,
}: MetaConnectionCardProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(
    outcome === null ? null : (OUTCOME_COPY[outcome] ?? null),
  );
  const [starting, setStarting] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<readonly string[]>(
    // One Page is the overwhelmingly common case, so preselect it rather than
    // making the merchant tick a box to proceed.
    selectablePages.length === 1 ? [selectablePages[0]?.id ?? ""] : [],
  );

  const unavailable = !view.configured || !view.storageReady;

  async function onConnect(): Promise<void> {
    setError(null);
    setNotice(null);
    setStarting(true);
    try {
      const result = await startMetaConnect();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // A full navigation, not a router push: the destination is facebook.com.
      window.location.assign(result.data.authorizeUrl);
    } finally {
      setStarting(false);
    }
  }

  async function onConfirm(): Promise<void> {
    if (selectionId === null) return;
    setError(null);
    setConfirming(true);
    try {
      const result = await connectMetaPages({ selectionId, pageIds: chosen });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The selection is single-use, so the query string must not survive a
      // refresh: reloading a spent `sid` would show an expired picker.
      window.location.assign("/business/settings");
    } finally {
      setConfirming(false);
    }
  }

  async function onDisconnect(connectionId: string): Promise<void> {
    setError(null);
    setNotice(null);
    setDisconnecting(connectionId);
    try {
      const result = await disconnectMeta({ connectionId });
      if (!result.ok) setError(result.message);
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <Card variant="outlined" className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-title-m text-on-surface">Facebook and Instagram</h2>
        <p className="text-body-m text-on-surface-variant">
          Connect your Facebook Page so Giya can read your audience and engagement figures. Giya
          never posts on your behalf.
        </p>
      </div>

      {notice !== null ? (
        <p className="rounded-md3-sm bg-surface-container-highest p-3 text-body-s text-on-surface-variant">
          {notice}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="rounded-md3-sm bg-error-container p-3 text-body-s text-on-error-container">
          {error}
        </p>
      ) : null}

      {unavailable ? (
        // The dormant state. Informational, not an error: nothing is broken.
        <div className="flex flex-col gap-2 rounded-md3-sm bg-surface-container-highest p-4">
          <p className="text-body-m text-on-surface">Not available yet</p>
          <p className="text-body-s text-on-surface-variant">
            {view.configured
              ? "Secure storage for connected accounts is still being set up. This will switch on without any action from you."
              : "Our Facebook application is still going through review. Connecting will switch on here as soon as it is approved, with nothing for you to install."}
          </p>
        </div>
      ) : null}

      {!unavailable && selectionId !== null && selectablePages.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-body-m text-on-surface">
            Choose which Page belongs to this business.
          </p>
          <ul className="flex flex-col gap-2">
            {selectablePages.map((page) => {
              const checked = chosen.includes(page.id);
              return (
                <li key={page.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md3-sm border border-outline-variant p-3">
                    <input
                      type="checkbox"
                      className="size-5 accent-primary"
                      checked={checked}
                      onChange={() =>
                        setChosen((current) =>
                          checked
                            ? current.filter((id) => id !== page.id)
                            : [...current, page.id],
                        )
                      }
                    />
                    <span className="flex flex-col">
                      <span className="text-body-m text-on-surface">{page.name}</span>
                      {page.category !== null ? (
                        <span className="text-body-s text-on-surface-variant">{page.category}</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <PendingButton
            pending={confirming}
            pendingLabel="Connecting"
            disabled={chosen.length === 0}
            onClick={onConfirm}
            className="self-start"
          >
            Connect selected
          </PendingButton>
        </div>
      ) : null}

      {view.connections.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {view.connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              canManage={view.canManage}
              onDisconnect={(id) => void onDisconnect(id)}
              disconnecting={disconnecting}
            />
          ))}
        </ul>
      ) : null}

      {!unavailable && view.canManage && selectionId === null ? (
        <PendingButton
          variant={view.connections.length > 0 ? "outlined" : "filled"}
          pending={starting}
          pendingLabel="Opening Facebook"
          onClick={() => void onConnect()}
          className="self-start"
        >
          {view.connections.length > 0 ? "Connect another Page" : "Connect Facebook Page"}
        </PendingButton>
      ) : null}

      {!unavailable && !view.canManage && view.connections.length === 0 ? (
        <p className="text-body-s text-on-surface-variant">
          Ask an owner or manager to connect a Page.
        </p>
      ) : null}

      <p className="text-body-s text-on-surface-variant">
        Audience and engagement tiles are not part of this release. Connecting now means they work
        the day they arrive.
      </p>
    </Card>
  );
}

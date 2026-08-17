"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/pending-button";
import { TextField } from "@/components/ui/text-field";

import { publishMetaCampaign } from "../actions";
import { PUBLISH_PAGE_COPY, PUBLISH_SURFACE_COPY } from "../copy";
import type { MetaPageCapability, MetaPublishView } from "../types";

// =============================================================================
// The campaign announcement composer.
// =============================================================================
//
// doc 32 section 11.1's composer, pointed at a connected Facebook Page.
//
// -----------------------------------------------------------------------------
// THE RULE THAT SHAPES THIS ENTIRE COMPONENT
// -----------------------------------------------------------------------------
//
// THERE IS NO PUBLISH BUTTON UNLESS A PAGE'S TOKEN ACTUALLY CARRIES
// `pages_manage_posts`. Not "unless the deployment is configured", not "unless
// something is connected", and emphatically not "unless the scope is in
// META_V1_SCOPES" - that constant says what the consent dialog ASKED for, and
// while the Meta app is pending review Facebook grants it only to the app's own
// admins, developers and testers. Everyone else gets a shorter list and no
// warning.
//
// So `view.pages` arrives with a per-Page capability resolved from
// `GET /debug_token` (server/capability.ts), the picker offers only the Pages
// that can actually be posted to, and every other Page is listed with the
// sentence that explains itself. A button that cannot work is worse than no
// button: it is a product stating a control it does not have.
//
// The `scope_missing` copy is the one to read twice. It does not blame the
// merchant and it does not tell them to reconnect, because for anyone outside
// the tester list reconnecting produces exactly the same token. See copy.ts.
//
// -----------------------------------------------------------------------------
// WHY THIS ONE IS A CLIENT COMPONENT WHEN THE INSIGHTS PANEL IS NOT
// -----------------------------------------------------------------------------
//
// It composes: a Page choice, a message, a link, a pending state and a result.
// The insights panel renders four numbers and is a server component for
// exactly that reason. Nothing here animates, so there is no `useReducedMotion`
// to gate; `PendingButton` owns the tap-state rules.

export interface MetaCampaignComposerProps {
  readonly view: MetaPublishView;
}

/** One connected Page that cannot be posted to, and the reason why. */
function BlockedPage({ page }: { page: MetaPageCapability }) {
  return (
    <li className="flex flex-col gap-1 rounded-md3-sm border border-outline-variant p-3">
      <span className="text-title-s text-on-surface">{page.pageName}</span>
      {/*
        Informational, not an error. Only one of these four states is even
        actionable by the merchant, and a red panel on the other three teaches
        them that their Facebook connection is broken when it is not.
      */}
      <span className="text-body-s text-on-surface-variant">
        {PUBLISH_PAGE_COPY[page.capability === "ready" ? "unavailable" : page.capability]}
      </span>
    </li>
  );
}

export function MetaCampaignComposer({ view }: MetaCampaignComposerProps) {
  const publishable = view.pages.filter((page) => page.capability === "ready");
  const blocked = view.pages.filter((page) => page.capability !== "ready");

  const [connectionId, setConnectionId] = React.useState<string>(
    // One Page is the overwhelmingly common case; preselect it rather than
    // making the merchant choose from a list of one.
    publishable[0]?.connectionId ?? "",
  );
  const [message, setMessage] = React.useState("");
  const [linkUrl, setLinkUrl] = React.useState("");
  const [publishing, setPublishing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  async function onPublish(): Promise<void> {
    setError(null);
    setNotice(null);
    setPublishing(true);
    try {
      const result = await publishMetaCampaign({ connectionId, message, linkUrl });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNotice("Your announcement is live on Facebook.");
      setMessage("");
      setLinkUrl("");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Card variant="outlined" className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-title-m text-on-surface">Campaign announcement</h2>
        <p className="text-body-m text-on-surface-variant">
          Post a short announcement to a connected Facebook Page. Giya posts only when you press
          the button below.
        </p>
      </div>

      {notice !== null ? (
        <p className="rounded-md3-sm bg-secondary-container p-3 text-body-s text-on-secondary-container">
          {notice}
        </p>
      ) : null}

      {error !== null ? (
        <p
          role="alert"
          className="rounded-md3-sm bg-error-container p-3 text-body-s text-on-error-container"
        >
          {error}
        </p>
      ) : null}

      {view.state !== "pages" ? (
        <p className="rounded-md3-sm bg-surface-container-highest p-4 text-body-m text-on-surface-variant">
          {PUBLISH_SURFACE_COPY[view.state]}
        </p>
      ) : null}

      {blocked.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {blocked.map((page) => (
            <BlockedPage key={page.connectionId} page={page} />
          ))}
        </ul>
      ) : null}

      {/*
        THE GATE, on the screen. Everything below renders only when at least one
        Page's TOKEN carries the publish permission and the caller's role may
        press the button.
      */}
      {publishable.length > 0 && view.canManage ? (
        <div className="flex flex-col gap-4">
          {publishable.length > 1 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-label-l text-on-surface">Post to</legend>
              {publishable.map((page) => (
                <label
                  key={page.connectionId}
                  className="flex cursor-pointer items-center gap-3 rounded-md3-sm border border-outline-variant p-3"
                >
                  <input
                    type="radio"
                    name="meta-publish-target"
                    className="size-5 accent-primary"
                    value={page.connectionId}
                    checked={connectionId === page.connectionId}
                    onChange={() => setConnectionId(page.connectionId)}
                  />
                  <span className="text-body-m text-on-surface">{page.pageName}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="text-body-s text-on-surface-variant">
              Posting to {publishable[0]?.pageName}
            </p>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="meta-campaign-message" className="text-label-l text-on-surface">
              Announcement
            </label>
            <textarea
              id="meta-campaign-message"
              rows={4}
              maxLength={5000}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Double points all weekend."
              className="rounded-md3-xs border border-outline bg-surface p-4 text-body-l text-on-surface outline-none transition-colors duration-200 ease-standard placeholder:text-on-surface-variant focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>

          <TextField
            id="meta-campaign-link"
            label="Link (optional)"
            type="url"
            inputMode="url"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://giya.ph/b/your-shop"
            helperText="Leave this empty to post without a link."
          />

          <PendingButton
            pending={publishing}
            pendingLabel="Posting"
            disabled={message.trim().length === 0}
            onClick={() => void onPublish()}
            className="self-start"
          >
            Post to Facebook
          </PendingButton>
        </div>
      ) : null}

      {publishable.length > 0 && !view.canManage ? (
        <p className="text-body-s text-on-surface-variant">
          Ask an owner, manager or marketing seat to post this.
        </p>
      ) : null}
    </Card>
  );
}

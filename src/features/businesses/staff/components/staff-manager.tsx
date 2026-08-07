"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import { changeStaffRoleAction, inviteStaffAction, revokeInviteAction } from "../actions";
import { canActOnRole, rolesInvitableBy } from "../roles";
import type { BusinessRole } from "../../server/resolve-owner-business";
import type { StaffRosterItem } from "../types";

// `/business/staff`, doc 32 section 7.1. Modelled directly on
// ../../customers/components/customers-manager.tsx: a Card list, a Dialog for
// the one write that needs more than a single field, everything else an
// inline row control. Locked design (doc 16): no expressive motion, dense
// rows, teal (primary) leads the one filled button on the screen.

const ROLE_LABEL: Record<BusinessRole, string> = {
  owner: "Owner",
  manager: "Manager",
  marketing: "Marketing",
  staff: "Staff",
};

const STATUS_LABEL: Record<string, string> = {
  invited: "Invited",
  active: "Active",
  disabled: "Removed",
};

function RoleBadge({ role }: { role: BusinessRole }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full bg-secondary-container px-3 text-label-m text-on-secondary-container">
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  // Review fix M10: "active" previously used `bg-primary-container`, which
  // is CORAL (docs/10-architecture/16-design-system.md: "Giya Coral #E8563F
  // | primary"), reserved for the consumer PWA's expressive surfaces
  // ("consumer PWA (expressive): coral leads"). The business portal is
  // "productive: teal leads" - `secondary` is Deep Teal - so every chip
  // here stays in that family. A solid `bg-secondary` fill (not the lighter
  // `-container` tone `RoleBadge` uses above) is what visually distinguishes
  // "this is the status" from "this is the role" without reaching for coral
  // or for tertiary (Mango, reserved elsewhere as reward/points language
  // only).
  const tone =
    status === "active"
      ? "bg-secondary text-on-secondary"
      : status === "invited"
        ? "border border-outline text-on-surface-variant"
        : "bg-surface-container text-on-surface-variant";
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full px-3 text-label-m", tone)}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export interface StaffManagerProps {
  businessName: string;
  roster: StaffRosterItem[];
  actorRole: BusinessRole;
}

export function StaffManager({ businessName, roster, actorRole }: StaffManagerProps) {
  const invitableRoles = rolesInvitableBy(actorRole);
  const canChangeRoles = actorRole === "owner";

  const [inviting, setInviting] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<BusinessRole | null>(invitableRoles[0] ?? null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<Record<string, string>>({});

  function openInvite() {
    setEmail("");
    setRole(invitableRoles[0] ?? null);
    setError(null);
    setInviting(true);
  }

  function closeInvite() {
    setInviting(false);
    setPending(false);
    setError(null);
  }

  async function submitInvite() {
    if (!role) return;
    setPending(true);
    setError(null);

    const result = await inviteStaffAction({ email, role });

    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    closeInvite();
  }

  async function revoke(staffId: string) {
    setRowError((prev) => ({ ...prev, [staffId]: "" }));
    const result = await revokeInviteAction(staffId);
    if (!result.ok) {
      setRowError((prev) => ({ ...prev, [staffId]: result.message }));
    }
  }

  async function changeRole(staffId: string, nextRole: BusinessRole) {
    setRowError((prev) => ({ ...prev, [staffId]: "" }));
    const result = await changeStaffRoleAction({ staffId, role: nextRole });
    if (!result.ok) {
      setRowError((prev) => ({ ...prev, [staffId]: result.message }));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-headline-s font-bold text-on-surface">Staff</h1>
          <p className="text-body-s text-on-surface-variant">
            Who can sign in to {businessName}&apos;s Giya portal, and what they can do.
          </p>
        </div>
        {invitableRoles.length > 0 ? (
          <Button type="button" variant="filled" size="md" onClick={openInvite} className="w-full sm:w-auto">
            Invite Teammate
          </Button>
        ) : null}
      </div>

      {roster.length === 0 ? (
        <EmptyState icon="group_add" title="Just you, for now" body="Invite a teammate to get started." />
      ) : (
        <Card variant="outlined" className="flex flex-col divide-y divide-outline-variant p-0">
          {roster.map((row) => {
            const canActOnRow = canActOnRole(actorRole, row.role);
            return (
              <div key={row.id} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-body-l text-on-surface">
                      {row.invitedEmail ?? "Member"}
                    </span>
                    <span className="text-body-s text-on-surface-variant">
                      Since {formatDate(row.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <RoleBadge role={row.role} />
                    <StatusChip status={row.status} />
                  </div>
                </div>

                {row.status === "invited" && canActOnRow ? (
                  <div>
                    <Button
                      type="button"
                      variant="outlined"
                      size="sm"
                      onClick={() => void revoke(row.id)}
                    >
                      Revoke invite
                    </Button>
                  </div>
                ) : null}

                {row.status === "active" && row.role !== "owner" && canChangeRoles ? (
                  <div className="flex items-center gap-2">
                    <label htmlFor={`role-${row.id}`} className="text-label-m text-on-surface-variant">
                      Role
                    </label>
                    <select
                      id={`role-${row.id}`}
                      value={row.role}
                      onChange={(event) => void changeRole(row.id, event.target.value as BusinessRole)}
                      className="h-9 rounded-md3-xs border border-outline bg-surface px-3 text-body-s text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    >
                      {(["manager", "marketing", "staff"] as const).map((option) => (
                        <option key={option} value={option}>
                          {ROLE_LABEL[option]}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {rowError[row.id] ? (
                  <p role="alert" className="text-body-s text-error">
                    {rowError[row.id]}
                  </p>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}

      <Dialog open={inviting} onClose={closeInvite} title="Invite a teammate">
        <div className="flex flex-col gap-4">
          <TextField
            id="invite-email"
            label="Email address"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-label-l text-on-surface">Role</legend>
            {invitableRoles.map((value) => (
              <label key={value} className="flex items-center gap-3 text-body-m text-on-surface">
                <input
                  type="radio"
                  name="invite-role"
                  value={value}
                  checked={role === value}
                  onChange={() => setRole(value)}
                  className="size-4"
                />
                {ROLE_LABEL[value]}
              </label>
            ))}
          </fieldset>

          {error ? (
            <p role="alert" className="text-body-s text-error">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            variant="filled"
            size="touch"
            disabled={pending || email.trim().length === 0 || !role}
            onClick={submitInvite}
          >
            {pending ? "Sending..." : "Send invite"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

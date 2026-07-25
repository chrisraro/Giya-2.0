"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import { changeCustomerSegment, updateCustomerNotes } from "../actions";
import { CUSTOMER_NOTES_MAX_LENGTH, SEGMENT_REASON_MAX_LENGTH } from "../schemas";
import { CUSTOMER_SEGMENTS, type CustomerListItem, type CustomerSegment, type CustomerSort, type SegmentFilter } from "../types";
import { CustomerTable, SEGMENT_LABEL, formatVisitDate } from "./customer-table";

export interface CustomersManagerProps {
  businessName: string;
  customers: CustomerListItem[];
  segment: SegmentFilter;
  sort: CustomerSort;
  truncated: boolean;
  /** Owner/manager. Marketing gets the list read-only (doc 01 matrix). */
  canManage: boolean;
  pageSize: number;
}

const SEGMENT_FILTERS: { value: SegmentFilter; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "regular", label: "Regular" },
  { value: "vip", label: "VIP" },
  { value: "blacklisted", label: "Blocked" },
];

const SORTS: { value: CustomerSort; label: string }[] = [
  { value: "last_visit", label: "Recent visit" },
  { value: "points", label: "Points balance" },
  { value: "visits", label: "Most visits" },
  { value: "spend", label: "Biggest spend" },
  { value: "lifetime", label: "Lifetime points" },
];

/**
 * Filters and sorts are URL state, not component state: they belong in the
 * address bar so a merchant can bookmark "my blocked customers", and so the
 * server component underneath re-runs the query with the right `.order()`
 * instead of the client re-sorting a page it only partly has.
 */
function href(segment: SegmentFilter, sort: CustomerSort): string {
  return `/business/customers?segment=${segment}&sort=${sort}`;
}

const pillClass = "inline-flex h-8 items-center rounded-full px-4 text-label-l transition-colors duration-200 ease-standard outline-none focus-visible:ring-2 focus-visible:ring-primary";

function FilterPill({
  label,
  selected,
  to,
}: {
  label: string;
  selected: boolean;
  to: string;
}) {
  return (
    <Link
      href={to}
      aria-current={selected ? "true" : undefined}
      className={cn(
        pillClass,
        selected
          ? "bg-secondary-container text-on-secondary-container"
          : "border border-outline text-on-surface-variant hover:bg-surface-container",
      )}
    >
      {label}
    </Link>
  );
}

export function CustomersManager({
  businessName,
  customers,
  segment,
  sort,
  truncated,
  canManage,
  pageSize,
}: CustomersManagerProps) {
  const [managing, setManaging] = React.useState<CustomerListItem | null>(null);
  const [nextSegment, setNextSegment] = React.useState<CustomerSegment>("regular");
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function openManage(customer: CustomerListItem) {
    setManaging(customer);
    setNextSegment(customer.segment);
    setReason("");
    setNotes(customer.notes ?? "");
    setError(null);
  }

  function closeManage() {
    setManaging(null);
    setError(null);
    setPending(false);
  }

  async function saveSegment() {
    if (!managing) return;
    setPending(true);
    setError(null);

    const result = await changeCustomerSegment({
      customerId: managing.id,
      segment: nextSegment,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });

    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    closeManage();
  }

  async function saveNotes() {
    if (!managing) return;
    setPending(true);
    setError(null);

    const result = await updateCustomerNotes({ customerId: managing.id, notes: notes.trim() });

    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    closeManage();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-headline-s text-on-surface">Customers</h1>
        <p className="text-body-s text-on-surface-variant">
          Everyone who has earned points at {businessName}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label-m text-on-surface-variant">Show</span>
          {SEGMENT_FILTERS.map((filter) => (
            <FilterPill
              key={filter.value}
              label={filter.label}
              selected={segment === filter.value}
              to={href(filter.value, sort)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label-m text-on-surface-variant">Sort by</span>
          {SORTS.map((option) => (
            <FilterPill
              key={option.value}
              label={option.label}
              selected={sort === option.value}
              to={href(segment, option.value)}
            />
          ))}
        </div>
      </div>

      {customers.length === 0 ? (
        <EmptyState
          icon="group"
          title={segment === "all" ? "No customers yet" : "Nobody in this group"}
          body={
            segment === "all"
              ? "Customers appear here the first time they scan a receipt from your store."
              : "Try another group, or clear the filter to see everyone."
          }
        />
      ) : (
        <>
          <CustomerTable customers={customers} canManage={canManage} onManage={openManage} />
          {truncated ? (
            <p className="text-body-s text-on-surface-variant">
              Showing the first {pageSize} customers for this view.
            </p>
          ) : null}
        </>
      )}

      <Dialog
        open={managing !== null}
        onClose={closeManage}
        title={managing ? `Customer ${managing.reference}` : "Customer"}
      >
        {managing ? (
          <div className="flex flex-col gap-6">
            <Card variant="outlined" className="flex flex-col gap-1 p-4">
              <p className="text-body-s text-on-surface-variant">
                {managing.visitCount} visits, last seen {formatVisitDate(managing.lastVisitAt)}
              </p>
              <p className="text-body-s text-on-surface-variant">
                {managing.pointsBalance} points now, {managing.lifetimePoints} earned all time
              </p>
            </Card>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-label-l text-on-surface">Standing</legend>
              {CUSTOMER_SEGMENTS.map((value) => (
                <label key={value} className="flex items-start gap-3 text-body-m text-on-surface">
                  <input
                    type="radio"
                    name="segment"
                    value={value}
                    checked={nextSegment === value}
                    onChange={() => setNextSegment(value)}
                    className="mt-1 size-4"
                  />
                  <span>
                    <span className="block">{SEGMENT_LABEL[value]}</span>
                    <span className="block text-body-s text-on-surface-variant">
                      {value === "vip"
                        ? "Can be targeted by campaigns aimed at VIPs."
                        : value === "blacklisted"
                          ? "Cannot claim or redeem anything at your store."
                          : "The default standing."}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {nextSegment === "blacklisted" ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="segment-reason" className="text-label-l text-on-surface">
                  Why are you blocking them?
                </label>
                <textarea
                  id="segment-reason"
                  rows={2}
                  maxLength={SEGMENT_REASON_MAX_LENGTH}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="rounded-md3-xs border border-outline bg-surface px-4 py-3 text-body-l text-on-surface outline-none transition-colors duration-200 ease-standard focus:border-primary focus:ring-1 focus:ring-primary"
                />
                <p className="text-body-s text-on-surface-variant">
                  Recorded in your activity log with your name and the time.
                </p>
              </div>
            ) : null}

            <Button
              type="button"
              variant="filled"
              size="touch"
              disabled={pending || nextSegment === managing.segment}
              onClick={saveSegment}
            >
              {pending ? "Saving..." : "Save standing"}
            </Button>

            <div className="flex flex-col gap-2 border-t border-outline-variant pt-6">
              <label htmlFor="customer-notes" className="text-label-l text-on-surface">
                Private note
              </label>
              <textarea
                id="customer-notes"
                rows={3}
                maxLength={CUSTOMER_NOTES_MAX_LENGTH}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="rounded-md3-xs border border-outline bg-surface px-4 py-3 text-body-l text-on-surface outline-none transition-colors duration-200 ease-standard focus:border-primary focus:ring-1 focus:ring-primary"
              />
              <p className="text-body-s text-on-surface-variant">
                Only your staff can see this. It is never shown to the customer.
              </p>
              <Button
                type="button"
                variant="outlined"
                size="touch"
                disabled={pending}
                onClick={saveNotes}
              >
                Save note
              </Button>
            </div>

            {error ? (
              <p role="alert" className="text-body-s text-error">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

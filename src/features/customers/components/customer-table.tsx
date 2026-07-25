"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatPeso } from "@/lib/money";

import type { CustomerListItem, CustomerSegment } from "../types";

export const SEGMENT_LABEL: Record<CustomerSegment, string> = {
  regular: "Regular",
  vip: "VIP",
  blacklisted: "Blocked",
};

/**
 * `blacklisted` is the only segment that takes something away - `claim_reward`
 * refuses a blacklisted customer outright - so it is the only one that gets the
 * error palette. `vip` is a positive standing and uses the secondary container,
 * not the tertiary/mango one: mango is reserved for points and reward language,
 * and a person is not a reward.
 */
export function segmentChipClass(segment: CustomerSegment): string {
  switch (segment) {
    case "blacklisted":
      return "bg-error-container text-on-error-container";
    case "vip":
      return "bg-secondary-container text-on-secondary-container";
    case "regular":
    default:
      return "border border-outline-variant text-on-surface-variant";
  }
}

export function formatVisitDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  });
}

export interface CustomerTableProps {
  customers: CustomerListItem[];
  /** Owner/manager only; marketing sees the same table without the action. */
  canManage: boolean;
  onManage: (customer: CustomerListItem) => void;
}

const headerCellClass = "px-3 py-2 text-left text-label-m text-on-surface-variant whitespace-nowrap";
const cellClass = "px-3 py-3 text-body-s text-on-surface whitespace-nowrap";

export function CustomerTable({ customers, canManage, onManage }: CustomerTableProps) {
  return (
    // Wide table, narrow phone: the table scrolls inside this box rather than
    // pushing the portal layout sideways.
    <div className="overflow-x-auto rounded-md3-md border border-outline-variant">
      <table className="w-full min-w-[56rem] border-collapse">
        <thead className="bg-surface-container-high">
          <tr>
            <th scope="col" className={headerCellClass}>
              Customer
            </th>
            <th scope="col" className={headerCellClass}>
              Standing
            </th>
            <th scope="col" className={cn(headerCellClass, "text-right")}>
              Points
            </th>
            <th scope="col" className={cn(headerCellClass, "text-right")}>
              Lifetime points
            </th>
            <th scope="col" className={cn(headerCellClass, "text-right")}>
              Visits
            </th>
            <th scope="col" className={cn(headerCellClass, "text-right")}>
              Lifetime spend
            </th>
            <th scope="col" className={headerCellClass}>
              Last visit
            </th>
            {canManage ? (
              <th scope="col" className={headerCellClass}>
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {customers.map((customer) => (
            <tr key={customer.id} className="border-t border-outline-variant">
              <th scope="row" className={cn(cellClass, "font-normal")}>
                <span className="font-mono">{customer.reference}</span>
                {customer.notes ? (
                  <span
                    className="ml-2 text-body-s text-on-surface-variant"
                    title={customer.notes}
                  >
                    note
                  </span>
                ) : null}
              </th>
              <td className={cellClass}>
                <span
                  className={cn(
                    "inline-flex rounded-full px-2.5 py-0.5 text-label-m",
                    segmentChipClass(customer.segment),
                  )}
                >
                  {SEGMENT_LABEL[customer.segment]}
                </span>
              </td>
              {/* Deliberately NOT the mango Badge, even though this is a
                  points figure: tertiary is reserved for the rewards surface,
                  and a dense CRM table where every row carried an accent chip
                  would emphasise nothing. */}
              <td className={cn(cellClass, "text-right tabular-nums")}>
                {customer.pointsBalance}
              </td>
              <td className={cn(cellClass, "text-right tabular-nums")}>
                {customer.lifetimePoints}
              </td>
              <td className={cn(cellClass, "text-right tabular-nums")}>{customer.visitCount}</td>
              <td className={cn(cellClass, "text-right tabular-nums")}>
                {formatPeso(customer.lifetimeSpendCentavos)}
              </td>
              <td className={cellClass}>{formatVisitDate(customer.lastVisitAt)}</td>
              {canManage ? (
                <td className={cellClass}>
                  <Button
                    type="button"
                    variant="text"
                    size="sm"
                    onClick={() => onManage(customer)}
                  >
                    Manage
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

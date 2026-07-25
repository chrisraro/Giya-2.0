import { redirect } from "next/navigation";

import { EmptyState } from "@/components/consumer/empty-state";
import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { CUSTOMER_VIEW_ROLES, CUSTOMER_WRITE_ROLES } from "@/features/customers/roles";
import { CustomersManager } from "@/features/customers/components/customers-manager";
import { CUSTOMER_PAGE_SIZE } from "@/features/customers/server/repo";
import { loadCustomers } from "@/features/customers/server/service";
import {
  isCustomerSort,
  isSegmentFilter,
  type CustomerSort,
  type SegmentFilter,
} from "@/features/customers/types";

// /business/customers - the tenant's CRM (doc 32 section 8).
//
// TENANCY: `resolveStaffContext` resolves the caller's business and role from
// `business_staff` under the caller's own session, and that business id is the
// only one that reaches a query. The `?segment=` and `?sort=` parameters are
// caller-supplied and are validated against closed unions before they are used;
// they select a filter and an ORDER BY column, never a tenant. There is no
// route segment or parameter anywhere here that can name a business.
export const dynamic = "force-dynamic";

type SearchParams = { segment?: string | string[]; sort?: string | string[] };

function readOne(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readSegment(params: SearchParams): SegmentFilter {
  const raw = readOne(params.segment);
  return raw !== undefined && isSegmentFilter(raw) ? raw : "all";
}

function readSort(params: SearchParams): CustomerSort {
  const raw = readOne(params.sort);
  return raw !== undefined && isCustomerSort(raw) ? raw : "last_visit";
}

export default async function BusinessCustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await resolveStaffContext(CUSTOMER_VIEW_ROLES);
  if (context === null) {
    // The portal layout already redirected non-members; reaching here means an
    // active member whose role cannot view customers (doc 01 matrix: `staff` is
    // the only business role excluded from the list).
    redirect("/business/dashboard");
  }

  const params = await searchParams;
  const segment = readSegment(params);
  const sort = readSort(params);

  const result = await loadCustomers(context.businessId, { segment, sort });

  // A failed query is not an empty CRM. "No customers yet" is a real and common
  // state for a new business, which is exactly why it must not be shown for a
  // read that did not answer - same discipline as menu/page.tsx.
  if (!result.ok || !result.data) {
    return (
      <EmptyState
        icon="error"
        title="Could not load your customers"
        body="Refresh to try again."
      />
    );
  }

  return (
    <CustomersManager
      businessName={context.businessName}
      customers={result.data.customers}
      segment={segment}
      sort={sort}
      truncated={result.data.truncated}
      canManage={CUSTOMER_WRITE_ROLES.includes(context.role)}
      pageSize={CUSTOMER_PAGE_SIZE}
    />
  );
}

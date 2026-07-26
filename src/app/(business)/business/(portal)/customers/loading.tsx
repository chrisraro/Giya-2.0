import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Route skeleton for the customers table.
//
// This is the one portal page with a real <table>, and the skeleton is a real
// <table> too. Building it out of divs would produce the right pixel height
// and the wrong column widths, so every column would jump sideways the moment
// the data arrived. A table with the same eight headers and the same
// `min-w-[56rem]` lays out its columns identically.
//
// Row height is 56px: py-3 plus a 32px Manage button, which is the tallest
// cell content.

const COLUMNS = [
  { label: "Customer", width: "w-32", align: "text-left" },
  { label: "Standing", width: "w-20", align: "text-left" },
  { label: "Points", width: "w-16", align: "text-right" },
  { label: "Lifetime points", width: "w-28", align: "text-right" },
  { label: "Visits", width: "w-14", align: "text-right" },
  { label: "Lifetime spend", width: "w-28", align: "text-right" },
  { label: "Last visit", width: "w-24", align: "text-left" },
  { label: "", width: "w-20", align: "text-left" },
] as const;

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

export default function Loading() {
  return (
    <SkeletonScreen label="your customers" className="flex flex-col gap-6">
      <div>
        <SkeletonText size="headline-s" className="w-44" />
        <SkeletonText size="body-s" className="w-72" />
      </div>

      {/* Two filter rows of h-8 pills: 4 segments, then 5 sort options. */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonText size="label-m" className="w-10" />
          {["w-24", "w-20", "w-16", "w-20"].map((width, i) => (
            <Skeleton key={i} className={`h-8 rounded-full ${width}`} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonText size="label-m" className="w-14" />
          {["w-28", "w-32", "w-28", "w-28", "w-32"].map((width, i) => (
            <Skeleton key={i} className={`h-8 rounded-full ${width}`} />
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md3-md border border-outline-variant">
        <table className="w-full min-w-[56rem] border-collapse">
          <thead className="bg-surface-container-high">
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.label}
                  className={cn(
                    "px-3 py-2 text-label-m whitespace-nowrap",
                    column.align,
                  )}
                >
                  <SkeletonText size="label-m" className={column.width} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row} className="border-t border-outline-variant">
                {COLUMNS.map((column) => (
                  <td
                    key={column.label}
                    className={cn("px-3 py-3 text-body-s whitespace-nowrap", column.align)}
                  >
                    {/* h-8 matches the tallest real cell content (the Manage
                        button), fixing the row at 56px. */}
                    <div
                      className={cn(
                        "flex h-8 items-center",
                        column.align === "text-right" && "justify-end",
                      )}
                    >
                      <Skeleton className={cn("h-4 rounded-md3-xs", column.width)} />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SkeletonScreen>
  );
}

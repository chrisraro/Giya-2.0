"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import type { RoundingMode } from "@/features/points/types";
import { previewReceiptPointsAction } from "../server/preview-action";

/**
 * The base earning rule an estimate is computed under.
 *
 * Owned here rather than by the server read, because it is this component's
 * prop type and both call sites build one: /scan reads the shop's saved rule,
 * and the merchant's earning-rule card builds one from the values currently in
 * its form. Declaring it in the "server-only" read module would make the
 * merchant card import that module for a type.
 */
export interface ScanPreviewRule {
  readonly rateCentavosPerPoint: number;
  readonly rounding: RoundingMode;
}

export interface ScanPreviewProps {
  /**
   * Names the shop in the estimate line ("~120 pts at Kape Diaria"), which is
   * doc-plan wording and is also the honest framing: the number is only true
   * of the shop whose rule produced it.
   */
  readonly businessName?: string | undefined;
  readonly heading?: string;
  readonly description?: string;
  /**
   * The caveat under the figure. Defaults to the consumer wording; the merchant
   * card overrides it, because "your receipt" is not the merchant's receipt.
   */
  readonly footnote?: string;
  /**
   * REQUIRED IN PRACTICE at any surface that shows a consumer a number.
   *
   * Omitting it falls back to the platform default of 1 point per peso, which
   * is right for a generic "how does this work" illustration and WRONG for a
   * shop whose base rule says something else. `/scan` therefore renders nothing
   * at all rather than render this component without a rule; see the guard on
   * that page.
   */
  readonly rule?: ScanPreviewRule | undefined;
}

/** Blank, unparseable and non-positive all mean "nothing to estimate yet". */
function toCentavos(amountPeso: string): number | null {
  const num = parseFloat(amountPeso);
  if (isNaN(num) || num <= 0) return null;
  return Math.round(num * 100);
}

export function ScanPreview({
  businessName,
  heading = "Points preview",
  description = "Enter a receipt total to see what it would earn.",
  footnote = "Estimate only. The points that land are worked out when your receipt is approved.",
  rule,
}: ScanPreviewProps) {
  const inputId = useId();
  const [amountPeso, setAmountPeso] = useState("");
  const [answer, setAnswer] = useState<{ question: string; points: number } | null>(null);
  const [isPending, startTransition] = useTransition();

  const rate = rule?.rateCentavosPerPoint;
  const rounding = rule?.rounding;

  const centavos = toCentavos(amountPeso);
  /**
   * Everything the estimate depends on, as one value.
   *
   * The displayed figure is DERIVED from whether the stored answer still
   * matches this question, rather than stored as "the current estimate". Two
   * ways that mattered:
   *  - The merchant card changes the rule underneath a figure already on
   *    screen (type ₱300, see the answer, then move the rate). A number kept as
   *    "the estimate" survives that edit looking exactly as authoritative as it
   *    did when it was true.
   *  - Two requests in flight resolve in whatever order they resolve in, and
   *    the older one landing last would overwrite the answer to what the person
   *    actually typed.
   */
  const question =
    centavos === null ? null : `${centavos}|${rate ?? "default"}|${rounding ?? "default"}`;

  useEffect(() => {
    if (question === null || centavos === null) return;

    let current = true;
    startTransition(async () => {
      const res = await previewReceiptPointsAction({
        amountCentavos: centavos,
        ...(rate === undefined || rounding === undefined
          ? {}
          : { baseRateCentavosPerPoint: rate, rounding }),
      });
      if (current && res.ok) {
        setAnswer({ question, points: res.points });
      }
    });

    return () => {
      current = false;
    };
  }, [question, centavos, rate, rounding]);

  const pointsEstimate =
    answer !== null && question !== null && answer.question === question ? answer.points : null;

  const estimate =
    pointsEstimate === null
      ? null
      : businessName === undefined
        ? `~${pointsEstimate} pts`
        : `~${pointsEstimate} pts at ${businessName}`;

  return (
    <Card variant="outlined" className="p-4 bg-surface-container/50 border-outline-variant">
      <h3 className="text-title-s font-semibold text-on-surface">{heading}</h3>
      <p className="text-body-s text-on-surface-variant mt-0.5">{description}</p>

      <div className="mt-3">
        <label htmlFor={inputId} className="sr-only">
          Receipt total in pesos
        </label>
        <div className="relative">
          <span
            aria-hidden
            className="absolute left-3 top-1/2 -translate-y-1/2 text-body-m font-semibold text-on-surface-variant"
          >
            ₱
          </span>
          <input
            id={inputId}
            type="number"
            step="0.01"
            inputMode="decimal"
            value={amountPeso}
            onChange={(e) => setAmountPeso(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-md3-xs border border-outline bg-surface py-2 pl-8 pr-3 text-body-m text-on-surface focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      {/* aria-live, because the number changes without the focus moving: a
          consumer using a screen reader would otherwise type into the field and
          hear nothing back. `aria-busy` marks the in-flight gap rather than
          blanking the last figure, which would read as "the estimate is now
          zero". */}
      <p
        aria-live="polite"
        aria-busy={isPending}
        className="mt-3 font-mono text-title-l font-bold text-primary"
      >
        {estimate}
      </p>

      {/* The estimate is an estimate. Campaign multipliers, bonuses and the
          shop's own review of the receipt all land after this, and a figure
          shown with no such caveat is a figure a consumer will hold the app to. */}
      <p className="mt-1 text-label-s text-on-surface-variant">{footnote}</p>
    </Card>
  );
}

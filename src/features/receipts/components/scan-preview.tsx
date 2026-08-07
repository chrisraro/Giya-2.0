"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { previewReceiptPointsAction } from "../server/preview-action";

export function ScanPreview() {
  const [amountPeso, setAmountPeso] = useState("");
  const [pointsEstimate, setPointsEstimate] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setAmountPeso(val);
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) {
      setPointsEstimate(null);
      return;
    }

    const centavos = Math.round(num * 100);
    startTransition(async () => {
      const res = await previewReceiptPointsAction({ amountCentavos: centavos });
      if (res.ok) {
        setPointsEstimate(res.points);
      }
    });
  };

  return (
    <Card variant="outlined" className="p-4 bg-surface-container/50 border-outline-variant">
      <h3 className="text-title-s font-semibold text-on-surface">Test Receipt Points Calculator</h3>
      <p className="text-body-s text-on-surface-variant mt-0.5">
        Enter receipt total to preview points award.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-body-m font-semibold text-on-surface-variant">
            ₱
          </span>
          <input
            type="number"
            step="0.01"
            value={amountPeso}
            onChange={handleChange}
            placeholder="0.00"
            className="w-full rounded-md3-xs border border-outline bg-surface py-2 pl-8 pr-3 text-body-m text-on-surface focus:border-primary focus:outline-none"
          />
        </div>

        <div className="min-w-24 text-right">
          <span className="text-label-s text-on-surface-variant block">Est. Points</span>
          <span className="font-mono text-title-l font-bold text-primary">
            {pointsEstimate !== null ? `+${pointsEstimate} pts` : "0 pts"}
          </span>
        </div>
      </div>
    </Card>
  );
}

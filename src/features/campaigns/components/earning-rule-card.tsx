"use client";

import * as React from "react";
import { useForm, useWatch, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/ui/text-field";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatPeso, pesoToCentavos } from "@/lib/money";
import { describeBaseRule } from "@/features/businesses/activation/presenter";
import {
  ScanPreview,
  type ScanPreviewRule,
} from "@/features/receipts/components/scan-preview";

import { roundingSchema } from "../schemas";
import type { BaseRuleInput } from "../schemas";
import type { PointsRuleRow } from "../server/types";

type ActionResult = { ok: true } | { ok: false; message: string };

export interface EarningRuleCardProps {
  baseRule: PointsRuleRow | null;
  onSave: (input: BaseRuleInput) => Promise<ActionResult>;
}

const ROUNDING_LABEL: Record<string, string> = {
  floor: "Round down",
  round: "Round to nearest",
  ceil: "Round up",
};

function isValidPeso(value: string): boolean {
  try {
    pesoToCentavos(value);
    return true;
  } catch {
    return false;
  }
}

const editFormSchema = z
  .object({
    ruleType: z.enum(["amount_rate", "fixed_per_visit"]),
    rate: z.string().optional(),
    fixedPoints: z.string().optional(),
    rounding: roundingSchema,
  })
  .superRefine((value, ctx) => {
    if (value.ruleType === "amount_rate") {
      if (!value.rate || !isValidPeso(value.rate)) {
        ctx.addIssue({ code: "custom", path: ["rate"], message: "Enter a valid peso amount" });
      }
    } else if (!value.fixedPoints || !/^\d+$/.test(value.fixedPoints) || Number(value.fixedPoints) < 1) {
      ctx.addIssue({ code: "custom", path: ["fixedPoints"], message: "Enter a whole number of points" });
    }
  });

type EditFormValues = z.infer<typeof editFormSchema>;

/**
 * Delegated to `describeBaseRule` rather than restated here.
 *
 * This card used to own the sentence, and it is now read in three places: here,
 * the dashboard go-live checklist that embeds this same card, and the admin
 * verification queue that has to show a reviewer what a merchant's customers
 * will actually earn. Three copies would drift, and the way they drift is a
 * merchant and the admin reviewing them reading different words about the same
 * rule.
 */
function summaryText(rule: PointsRuleRow): string {
  return describeBaseRule(rule) ?? "Custom earning rule";
}

/**
 * Shows and edits the business's single active base points rule
 * (kind='base'): either an amount_rate ("1 point per PN") or a
 * fixed_per_visit flat award, plus its rounding mode. fixed_per_receipt
 * exists at the schema/DB level but is not exposed here - the task-6 brief
 * scopes the UI to the two rule types a business owner actually chooses
 * between.
 */
export function EarningRuleCard({ baseRule, onSave }: EarningRuleCardProps) {
  const [editing, setEditing] = React.useState(baseRule === null);
  const [submitting, setSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const defaultValues = React.useMemo<EditFormValues>(() => {
    if (baseRule && baseRule.rule_type === "fixed_per_visit" && baseRule.fixed_points !== null) {
      return {
        ruleType: "fixed_per_visit",
        fixedPoints: String(baseRule.fixed_points),
        rounding: baseRule.rounding as EditFormValues["rounding"],
      };
    }
    if (baseRule && baseRule.rate_centavos_per_point !== null) {
      return {
        ruleType: "amount_rate",
        rate: formatPeso(baseRule.rate_centavos_per_point, { symbol: false }),
        rounding: baseRule.rounding as EditFormValues["rounding"],
      };
    }
    return { ruleType: "amount_rate", rounding: "floor" };
  }, [baseRule]);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EditFormValues>({ resolver: zodResolver(editFormSchema), defaultValues });

  const ruleType = useWatch({ control, name: "ruleType" });
  const watchedRate = useWatch({ control, name: "rate" });
  const watchedRounding = useWatch({ control, name: "rounding" });

  /**
   * The rule the "test a receipt" preview computes under: the one in the FORM,
   * not the one in the database.
   *
   * That is the whole point of the control. A merchant moving from 1 point per
   * ₱100 to 1 point per ₱50 is asking what the new rule pays, and a preview
   * answering from `baseRule` would confidently show them the old number on the
   * screen where they are choosing the new one.
   *
   * null for anything there is no honest amount-based answer for:
   *  - `fixed_per_visit` awards the same points whatever the receipt says, so a
   *    peso field would be a control that cannot change its own output.
   *  - a rate that does not parse, or is not positive, is a half-typed one.
   */
  const previewRule = React.useMemo<ScanPreviewRule | null>(() => {
    if (ruleType !== "amount_rate") return null;
    if (!watchedRate || !isValidPeso(watchedRate)) return null;
    const rateCentavosPerPoint = pesoToCentavos(watchedRate);
    if (rateCentavosPerPoint <= 0) return null;
    return { rateCentavosPerPoint, rounding: watchedRounding };
  }, [ruleType, watchedRate, watchedRounding]);

  function openEdit() {
    reset(defaultValues);
    setServerError(null);
    setEditing(true);
  }

  function closeEdit() {
    setEditing(false);
    setServerError(null);
  }

  const submit: SubmitHandler<EditFormValues> = async (values) => {
    setSubmitting(true);
    setServerError(null);

    const input: BaseRuleInput =
      values.ruleType === "amount_rate"
        ? {
            ruleType: "amount_rate",
            rateCentavosPerPoint: pesoToCentavos(values.rate ?? "0"),
            rounding: values.rounding,
          }
        : {
            ruleType: "fixed_per_visit",
            fixedPoints: Number(values.fixedPoints),
            rounding: values.rounding,
          };

    const result = await onSave(input);
    setSubmitting(false);
    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    setEditing(false);
  };

  if (!editing && baseRule) {
    return (
      <Card variant="outlined" className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-title-s text-on-surface">Base earning rule</p>
            <p className="text-body-s text-on-surface-variant">
              {ROUNDING_LABEL[baseRule.rounding] ?? baseRule.rounding}
            </p>
          </div>
          <Button type="button" variant="outlined" size="sm" onClick={openEdit}>
            Edit
          </Button>
        </div>
        <Badge className="w-fit">{summaryText(baseRule)}</Badge>
      </Card>
    );
  }

  if (!editing && !baseRule) {
    return (
      <Card variant="outlined" className="flex flex-col items-start gap-3 p-4">
        <div>
          <p className="text-title-s text-on-surface">No earning rule yet</p>
          <p className="text-body-s text-on-surface-variant">
            Set how customers earn points when they visit or spend with you.
          </p>
        </div>
        <Button type="button" variant="tonal" size="md" onClick={openEdit}>
          Set up earning rule
        </Button>
      </Card>
    );
  }

  return (
    <Card variant="outlined" className="p-4">
      <CardHeader className="p-0 pb-4">
        <CardTitle>Base earning rule</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-4">
          {serverError ? (
            <p role="alert" className="text-body-s text-error">
              {serverError}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <label htmlFor="earning-rule-type" className="text-label-l text-on-surface">
              Rule type
            </label>
            <select
              id="earning-rule-type"
              className={cn(
                "h-12 rounded-md3-xs border border-outline bg-surface px-4 text-body-l text-on-surface",
                "outline-none transition-colors duration-200 ease-standard focus:border-primary focus:ring-1 focus:ring-primary",
              )}
              {...register("ruleType")}
            >
              <option value="amount_rate">Rate (points per peso spent)</option>
              <option value="fixed_per_visit">Fixed points per visit</option>
            </select>
          </div>

          {ruleType === "amount_rate" ? (
            <TextField
              id="earning-rule-rate"
              label="1 point per (peso)"
              placeholder="1.00"
              inputMode="decimal"
              {...(errors.rate?.message ? { errorText: errors.rate.message } : {})}
              {...register("rate")}
            />
          ) : (
            <TextField
              id="earning-rule-fixed-points"
              label="Points per visit"
              placeholder="1"
              inputMode="numeric"
              {...(errors.fixedPoints?.message ? { errorText: errors.fixedPoints.message } : {})}
              {...register("fixedPoints")}
            />
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="earning-rule-rounding" className="text-label-l text-on-surface">
              Rounding
            </label>
            <select
              id="earning-rule-rounding"
              className={cn(
                "h-12 rounded-md3-xs border border-outline bg-surface px-4 text-body-l text-on-surface",
                "outline-none transition-colors duration-200 ease-standard focus:border-primary focus:ring-1 focus:ring-primary",
              )}
              {...register("rounding")}
            >
              <option value="floor">Round down</option>
              <option value="round">Round to nearest</option>
              <option value="ceil">Round up</option>
            </select>
          </div>

          <div className="flex items-center gap-3">
            {baseRule ? (
              <Button type="button" variant="text" size="touch" onClick={closeEdit} disabled={submitting}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit" variant="filled" size="touch" className="flex-1" disabled={submitting}>
              {submitting ? "Saving..." : "Save earning rule"}
            </Button>
          </div>
        </form>

        {/* OUTSIDE the <form>, deliberately. A number input inside a form
            submits it on Enter, and a merchant who types a test amount and hits
            Enter would save a rule they were still deciding on. */}
        {previewRule === null ? null : (
          <div className="mt-4">
            <ScanPreview
              rule={previewRule}
              heading="Test a receipt"
              description="Enter a receipt total to see what this rule would award."
              footnote="Base rule only. Any live campaign multipliers or bonuses are added on top."
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

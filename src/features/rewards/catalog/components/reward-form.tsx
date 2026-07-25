"use client";

import * as React from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";

import {
  MAX_CLAIM_EXPIRY_DAYS,
  MAX_POINTS_COST,
  MIN_CLAIM_EXPIRY_DAYS,
  MIN_TOTAL_INVENTORY,
  REWARD_DESCRIPTION_MAX_LENGTH,
  REWARD_NAME_MAX_LENGTH,
  REWARD_NAME_MIN_LENGTH,
  REWARD_TERMS_MAX_LENGTH,
} from "../schemas";
import type { CampaignOption, RewardCatalogItem } from "../types";

// The create/edit form rendered inside <Dialog>. Money is not involved here -
// rewards are priced in points - but the same string-first convention as
// src/features/menu/components/product-form.tsx applies to every numeric field:
// the input holds a string so it never fights the user mid-type, and Number()
// runs once at submit.
//
// Every bound below is the client-side echo of ../schemas.ts, which is itself
// the echo of the `rewards` check constraints and the `claim_reward` guards.
// The server re-validates all of it; this layer exists so the merchant is told
// before they submit, not after.

const fieldControlClass = cn(
  "rounded-md3-xs border bg-surface px-4 text-body-l text-on-surface",
  "outline-none transition-colors duration-200 ease-standard",
);

function controlBorderClass(hasError: boolean) {
  return hasError
    ? "border-error focus:border-error focus:ring-1 focus:ring-error"
    : "border-outline focus:border-primary focus:ring-1 focus:ring-primary";
}

function isWholeNumber(value: string, opts: { min?: number; max?: number } = {}): boolean {
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return false;
  if (opts.min !== undefined && parsed < opts.min) return false;
  if (opts.max !== undefined && parsed > opts.max) return false;
  return true;
}

const rewardFormSchema = z
  .object({
    campaignId: z.string().min(1, "Pick the campaign this reward belongs to"),
    name: z
      .string()
      .trim()
      .min(REWARD_NAME_MIN_LENGTH, "Give the reward a name")
      .max(REWARD_NAME_MAX_LENGTH, `Keep the name under ${REWARD_NAME_MAX_LENGTH} characters`),
    description: z.string().max(REWARD_DESCRIPTION_MAX_LENGTH).optional(),
    pointsCost: z.string().min(1, "Points cost is required"),
    totalInventory: z.string().optional(),
    perCustomerLimit: z.string().min(1, "Per-customer limit is required"),
    claimExpiryDays: z.string().min(1, "Claim expiry is required"),
    terms: z.string().max(REWARD_TERMS_MAX_LENGTH).optional(),
  })
  .superRefine((value, ctx) => {
    if (!isWholeNumber(value.pointsCost, { min: 0, max: MAX_POINTS_COST })) {
      ctx.addIssue({
        code: "custom",
        path: ["pointsCost"],
        message: "Enter a whole number of points. Use 0 for a free reward.",
      });
    }
    if (!isWholeNumber(value.perCustomerLimit, { min: 1 })) {
      ctx.addIssue({
        code: "custom",
        path: ["perCustomerLimit"],
        message: "Enter a whole number, at least 1",
      });
    }
    if (
      !isWholeNumber(value.claimExpiryDays, {
        min: MIN_CLAIM_EXPIRY_DAYS,
        max: MAX_CLAIM_EXPIRY_DAYS,
      })
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["claimExpiryDays"],
        message: `Enter a whole number of days, ${MIN_CLAIM_EXPIRY_DAYS} to ${MAX_CLAIM_EXPIRY_DAYS}`,
      });
    }
    // Blank means unlimited. Zero does not: a reward stocked at zero is out of
    // stock from the moment it is saved (claim_reward step 2), so the field
    // refuses it rather than quietly creating a reward nobody can claim.
    if (
      value.totalInventory !== undefined &&
      value.totalInventory !== "" &&
      !isWholeNumber(value.totalInventory, { min: MIN_TOTAL_INVENTORY })
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["totalInventory"],
        message: "Enter a whole number of at least 1, or leave this blank for unlimited",
      });
    }
  });

type RewardFormValues = z.infer<typeof rewardFormSchema>;

export interface RewardFormOutput {
  campaignId: string;
  name: string;
  description?: string;
  pointsCost: number;
  totalInventory?: number | null;
  perCustomerLimit: number;
  claimExpiryDays: number;
  terms?: string;
}

export interface RewardFormProps {
  /** Campaigns a NEW reward may hang off: the tenant's non-terminal ones. */
  campaigns: CampaignOption[];
  /** Present when editing; its campaign is fixed and shown read-only. */
  reward?: RewardCatalogItem | null;
  onSubmit: (output: RewardFormOutput) => void;
  onCancel: () => void;
  submitting?: boolean;
  serverError?: string | null;
}

const DEFAULT_PER_CUSTOMER_LIMIT = "1";
const DEFAULT_CLAIM_EXPIRY_DAYS = "30";

export function RewardForm({
  campaigns,
  reward = null,
  onSubmit,
  onCancel,
  submitting = false,
  serverError = null,
}: RewardFormProps) {
  const editing = reward !== null;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RewardFormValues>({
    resolver: zodResolver(rewardFormSchema),
    defaultValues: {
      campaignId: reward?.campaignId ?? campaigns[0]?.id ?? "",
      name: reward?.name ?? "",
      description: reward?.description ?? "",
      pointsCost: reward ? String(reward.pointsCost) : "0",
      totalInventory: reward?.totalInventory === null ? "" : String(reward?.totalInventory ?? ""),
      perCustomerLimit: reward
        ? String(reward.perCustomerLimit)
        : DEFAULT_PER_CUSTOMER_LIMIT,
      claimExpiryDays: reward ? String(reward.claimExpiryDays) : DEFAULT_CLAIM_EXPIRY_DAYS,
      terms: reward?.terms ?? "",
    },
  });

  const submit: SubmitHandler<RewardFormValues> = (values) => {
    const trimmedDescription = values.description?.trim();
    const trimmedTerms = values.terms?.trim();

    onSubmit({
      campaignId: values.campaignId,
      name: values.name.trim(),
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
      pointsCost: Number(values.pointsCost),
      totalInventory:
        values.totalInventory === undefined || values.totalInventory === ""
          ? null
          : Number(values.totalInventory),
      perCustomerLimit: Number(values.perCustomerLimit),
      claimExpiryDays: Number(values.claimExpiryDays),
      ...(trimmedTerms ? { terms: trimmedTerms } : {}),
    });
  };

  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-6">
      {serverError ? (
        <p role="alert" className="text-body-s text-error">
          {serverError}
        </p>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-2">
          <p className="text-label-l text-on-surface">Campaign</p>
          <p className="text-body-m text-on-surface-variant">
            {reward?.campaign?.name ?? "Unknown campaign"}
          </p>
          <p className="text-body-s text-on-surface-variant">
            A reward stays with the campaign it was created under, because claims already made count
            against that campaign.
          </p>
          <input type="hidden" {...register("campaignId")} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor="reward-campaign" className="text-label-l text-on-surface">
            Campaign
          </label>
          <select
            id="reward-campaign"
            className={cn(
              fieldControlClass,
              "h-12",
              controlBorderClass(Boolean(errors.campaignId?.message)),
            )}
            {...register("campaignId")}
          >
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
                {campaign.claimable ? "" : " (not live yet)"}
              </option>
            ))}
          </select>
          {errors.campaignId?.message ? (
            <p role="alert" className="text-body-s text-error">
              {errors.campaignId.message}
            </p>
          ) : (
            <p className="text-body-s text-on-surface-variant">
              Customers can claim this once its campaign is active and inside its dates.
            </p>
          )}
        </div>
      )}

      <TextField
        id="reward-name"
        label="Reward name"
        placeholder="e.g. Free medium iced coffee"
        {...(errors.name?.message ? { errorText: errors.name.message } : {})}
        {...register("name")}
      />

      <div className="flex flex-col gap-2">
        <label htmlFor="reward-description" className="text-label-l text-on-surface">
          Description (optional)
        </label>
        <textarea
          id="reward-description"
          rows={2}
          placeholder="What the customer gets"
          className={cn(fieldControlClass, "py-3", controlBorderClass(false))}
          {...register("description")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="reward-points-cost"
          label="Points cost"
          placeholder="0"
          inputMode="numeric"
          helperText="0 makes it a free claim."
          {...(errors.pointsCost?.message ? { errorText: errors.pointsCost.message } : {})}
          {...register("pointsCost")}
        />
        <TextField
          id="reward-total-inventory"
          label="Stock"
          placeholder="Unlimited"
          inputMode="numeric"
          helperText="Leave blank for unlimited."
          {...(errors.totalInventory?.message ? { errorText: errors.totalInventory.message } : {})}
          {...register("totalInventory")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="reward-per-customer-limit"
          label="Per-customer limit"
          placeholder="1"
          inputMode="numeric"
          helperText="How many times one customer may claim this."
          {...(errors.perCustomerLimit?.message ? { errorText: errors.perCustomerLimit.message } : {})}
          {...register("perCustomerLimit")}
        />
        <TextField
          id="reward-claim-expiry-days"
          label="Claim expires after (days)"
          placeholder="30"
          inputMode="numeric"
          helperText="Claims expire this many days after claiming."
          {...(errors.claimExpiryDays?.message ? { errorText: errors.claimExpiryDays.message } : {})}
          {...register("claimExpiryDays")}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="reward-terms" className="text-label-l text-on-surface">
          Terms (optional)
        </label>
        <textarea
          id="reward-terms"
          rows={3}
          placeholder="Any fine print customers should see"
          className={cn(fieldControlClass, "py-3", controlBorderClass(false))}
          {...register("terms")}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" variant="text" size="touch" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="filled" size="touch" className="flex-1" disabled={submitting}>
          {submitting ? "Saving..." : editing ? "Save reward" : "Create reward"}
        </Button>
      </div>
    </form>
  );
}

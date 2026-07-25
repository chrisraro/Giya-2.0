"use client";

import * as React from "react";
import { useForm, useWatch, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";
import { pesoToCentavos } from "@/lib/money";

import {
  CAMPAIGN_DESCRIPTION_MAX_LENGTH,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_NAME_MIN_LENGTH,
  REWARD_NAME_MAX_LENGTH,
  REWARD_NAME_MIN_LENGTH,
  offerKindSchema,
  programTypeSchema,
} from "../schemas";
import { CAMPAIGN_TIMEZONE, endOfDayExclusiveInZone, startOfDayInZone } from "../date-window";
import type {
  CreateLoyaltyCampaignInput,
  CreatePromotionCampaignInput,
  CreateRewardCampaignInput,
  OfferKind,
  ProgramType,
} from "../schemas";

// The create flow rendered inside <Dialog>: step 1 is a type picker
// (Promotion / Reward / Loyalty), step 2 is a type-specific RHF+Zod form.
// Each type keeps its own useForm instance rather than one shared schema
// with a discriminated union, since the three payloads share almost no
// fields beyond the campaign name - matching how schemas.ts itself models
// them as three separate create*CampaignSchema exports. Money is kept as a
// string in form state (never in Date/number form) and converted via
// pesoToCentavos only at submit time, same convention as
// src/features/menu/components/product-form.tsx.

/**
 * A peso amount typed as a string, validated as parseable via
 * `pesoToCentavos`. Kept string-first so the input never fights the user
 * mid-type.
 */
function isValidPeso(value: string): boolean {
  try {
    pesoToCentavos(value);
    return true;
  } catch {
    return false;
  }
}

function isPositiveInt(value: string, opts: { min?: number; max?: number } = {}): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  const min = opts.min ?? 0;
  if (n < min) return false;
  if (opts.max !== undefined && n > opts.max) return false;
  return true;
}

// Shared control chrome for native <select>/<textarea>, mirroring
// TextField's height/border/radius/focus classes (product-form.tsx's
// fieldControlClass, duplicated here for the same reason: these element
// types aren't covered by TextField's input-only props type).
const fieldControlClass = cn(
  "rounded-md3-xs border bg-surface px-4 text-body-l text-on-surface",
  "outline-none transition-colors duration-200 ease-standard",
);

function controlBorderClass(hasError: boolean) {
  return hasError
    ? "border-error focus:border-error focus:ring-1 focus:ring-error"
    : "border-outline focus:border-primary focus:ring-1 focus:ring-primary";
}

// -------------------------------------------------------------- shared step 1

export type CampaignFormType = "promotion" | "reward" | "loyalty";

export type CampaignFormOutput =
  | { type: "promotion"; data: CreatePromotionCampaignInput }
  | { type: "reward"; data: CreateRewardCampaignInput }
  | { type: "loyalty"; data: CreateLoyaltyCampaignInput };

export interface CampaignFormProps {
  onSubmit: (output: CampaignFormOutput) => void;
  onCancel: () => void;
  submitting?: boolean;
  serverError?: string | null;
}

const TYPE_OPTIONS: {
  type: CampaignFormType;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    type: "promotion",
    label: "Promotion",
    description: "A percent or peso discount, bundle, freebie, or announcement.",
    icon: "sell",
  },
  {
    type: "reward",
    label: "Reward",
    description: "Something customers redeem with points.",
    icon: "redeem",
  },
  {
    type: "loyalty",
    label: "Loyalty program",
    description: "A stamp card or points-target program with a completion prize.",
    icon: "loyalty",
  },
];

function TypePicker({
  onSelect,
  onCancel,
}: {
  onSelect: (type: CampaignFormType) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-m text-on-surface-variant">What kind of campaign do you want to create?</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {TYPE_OPTIONS.map((option) => (
          <button
            key={option.type}
            type="button"
            onClick={() => onSelect(option.type)}
            className="text-left outline-none focus-visible:ring-2 focus-visible:ring-secondary rounded-md3-md"
          >
            <Card
              variant="outlined"
              className="flex h-full flex-col gap-2 p-4 transition-colors duration-200 ease-standard hover:bg-surface-container"
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
                <span aria-hidden className="material-symbols-rounded text-[18px]">
                  {option.icon}
                </span>
              </span>
              <p className="text-title-s text-on-surface">{option.label}</p>
              <p className="text-body-s text-on-surface-variant">{option.description}</p>
            </Card>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="text" size="touch" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface StepProps {
  onBack: () => void;
  onCancel: () => void;
  submitting: boolean;
  serverError: string | null | undefined;
}

function ServerErrorText({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-body-s text-error">
      {message}
    </p>
  );
}

function StepActions({
  onBack,
  onCancel,
  submitting,
}: {
  onBack: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button type="button" variant="text" size="touch" onClick={onBack} disabled={submitting}>
        Back
      </Button>
      <Button type="button" variant="text" size="touch" onClick={onCancel} disabled={submitting}>
        Cancel
      </Button>
      <Button type="submit" variant="filled" size="touch" className="flex-1" disabled={submitting}>
        {submitting ? "Creating..." : "Create campaign"}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------- promotions

const promotionFormSchema = z
  .object({
    name: z
      .string()
      .min(CAMPAIGN_NAME_MIN_LENGTH, "Name is required")
      .max(CAMPAIGN_NAME_MAX_LENGTH, `Keep it under ${CAMPAIGN_NAME_MAX_LENGTH} characters`),
    description: z.string().max(CAMPAIGN_DESCRIPTION_MAX_LENGTH).optional(),
    offerKind: offerKindSchema,
    percentOff: z.string().optional(),
    amountOff: z.string().optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    terms: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.offerKind === "percent_off") {
      if (!value.percentOff || !isPositiveInt(value.percentOff, { min: 1, max: 100 })) {
        ctx.addIssue({
          code: "custom",
          path: ["percentOff"],
          message: "Enter a percent between 1 and 100",
        });
      }
    } else if (value.offerKind === "amount_off") {
      if (!value.amountOff || !isValidPeso(value.amountOff)) {
        ctx.addIssue({ code: "custom", path: ["amountOff"], message: "Enter a valid peso amount" });
      }
    }
    if (
      value.startsAt &&
      value.endsAt &&
      endOfDayExclusiveInZone(value.endsAt, CAMPAIGN_TIMEZONE).getTime() <=
        startOfDayInZone(value.startsAt, CAMPAIGN_TIMEZONE).getTime()
    ) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after start date" });
    }
  });

type PromotionFormValues = z.infer<typeof promotionFormSchema>;

const OFFER_KIND_OPTIONS: { value: OfferKind; label: string }[] = [
  { value: "percent_off", label: "Percent off" },
  { value: "amount_off", label: "Amount off" },
  { value: "bundle", label: "Bundle" },
  { value: "freebie", label: "Freebie" },
  { value: "announcement", label: "Announcement" },
];

function PromotionFields({ onBack, onCancel, submitting, serverError, onSubmit }: StepProps & {
  onSubmit: (data: CreatePromotionCampaignInput) => void;
}) {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<PromotionFormValues>({
    resolver: zodResolver(promotionFormSchema),
    defaultValues: { offerKind: "percent_off" },
  });

  const offerKind = useWatch({ control, name: "offerKind" });

  const submit: SubmitHandler<PromotionFormValues> = (values) => {
    onSubmit({
      name: values.name,
      ...(values.description ? { description: values.description } : {}),
      ...(values.startsAt ? { startsAt: startOfDayInZone(values.startsAt, CAMPAIGN_TIMEZONE) } : {}),
      ...(values.endsAt ? { endsAt: endOfDayExclusiveInZone(values.endsAt, CAMPAIGN_TIMEZONE) } : {}),
      promotion: {
        offerKind: values.offerKind,
        ...(values.offerKind === "percent_off" && values.percentOff
          ? { percentOff: Number(values.percentOff) }
          : {}),
        ...(values.offerKind === "amount_off" && values.amountOff
          ? { amountOffCentavos: pesoToCentavos(values.amountOff) }
          : {}),
        ...(values.terms ? { terms: values.terms } : {}),
      },
    });
  };


  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-6">
      <ServerErrorText message={serverError} />

      <TextField
        id="promo-name"
        label="Campaign name"
        placeholder="e.g. Summer Sale"
        {...(errors.name?.message ? { errorText: errors.name.message } : {})}
        {...register("name")}
      />

      <div className="flex flex-col gap-2">
        <label htmlFor="promo-offer-kind" className="text-label-l text-on-surface">
          Offer kind
        </label>
        <select
          id="promo-offer-kind"
          className={cn(fieldControlClass, "h-12", controlBorderClass(false))}
          {...register("offerKind")}
        >
          {OFFER_KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {offerKind === "percent_off" ? (
        <TextField
          id="promo-percent-off"
          label="Percent off"
          placeholder="0"
          inputMode="numeric"
          {...(errors.percentOff?.message ? { errorText: errors.percentOff.message } : {})}
          {...register("percentOff")}
        />
      ) : null}

      {offerKind === "amount_off" ? (
        <TextField
          id="promo-amount-off"
          label="Amount off"
          placeholder="0.00"
          inputMode="decimal"
          {...(errors.amountOff?.message ? { errorText: errors.amountOff.message } : {})}
          {...register("amountOff")}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField id="promo-starts-at" label="Start date (optional)" type="date" {...register("startsAt")} />
        <TextField
          id="promo-ends-at"
          label="End date (optional)"
          type="date"
          {...(errors.endsAt?.message ? { errorText: errors.endsAt.message } : {})}
          {...register("endsAt")}
        />
      </div>
      <p className="text-body-s text-on-surface-variant">Dates follow Philippine time.</p>

      <div className="flex flex-col gap-2">
        <label htmlFor="promo-terms" className="text-label-l text-on-surface">
          Terms (optional)
        </label>
        <textarea
          id="promo-terms"
          rows={3}
          placeholder="Any fine print customers should see"
          className={cn(fieldControlClass, "py-3", controlBorderClass(false))}
          {...register("terms")}
        />
      </div>

      <StepActions onBack={onBack} onCancel={onCancel} submitting={submitting} />
    </form>
  );
}

// ----------------------------------------------------------------- rewards

const rewardFormSchema = z
  .object({
    name: z
      .string()
      .min(CAMPAIGN_NAME_MIN_LENGTH, "Campaign name is required")
      .max(CAMPAIGN_NAME_MAX_LENGTH),
    rewardName: z
      .string()
      .min(REWARD_NAME_MIN_LENGTH, "Reward name is required")
      .max(REWARD_NAME_MAX_LENGTH),
    pointsCost: z.string().min(1, "Points cost is required"),
    totalInventory: z.string().optional(),
    perCustomerLimit: z.string().min(1, "Per-customer limit is required"),
    claimExpiryDays: z.string().min(1, "Expiry days is required"),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    terms: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!isPositiveInt(value.pointsCost, { min: 0 })) {
      ctx.addIssue({ code: "custom", path: ["pointsCost"], message: "Enter a whole number of points" });
    }
    if (!isPositiveInt(value.perCustomerLimit, { min: 1 })) {
      ctx.addIssue({ code: "custom", path: ["perCustomerLimit"], message: "Enter a whole number, at least 1" });
    }
    if (!isPositiveInt(value.claimExpiryDays, { min: 1, max: 365 })) {
      ctx.addIssue({
        code: "custom",
        path: ["claimExpiryDays"],
        message: "Enter a whole number of days, 1 to 365",
      });
    }
    if (value.totalInventory && !isPositiveInt(value.totalInventory, { min: 0 })) {
      ctx.addIssue({ code: "custom", path: ["totalInventory"], message: "Enter a whole number" });
    }
    if (
      value.startsAt &&
      value.endsAt &&
      endOfDayExclusiveInZone(value.endsAt, CAMPAIGN_TIMEZONE).getTime() <=
        startOfDayInZone(value.startsAt, CAMPAIGN_TIMEZONE).getTime()
    ) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after start date" });
    }
  });

type RewardFormValues = z.infer<typeof rewardFormSchema>;

function RewardFields({ onBack, onCancel, submitting, serverError, onSubmit }: StepProps & {
  onSubmit: (data: CreateRewardCampaignInput) => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RewardFormValues>({ resolver: zodResolver(rewardFormSchema) });

  const submit: SubmitHandler<RewardFormValues> = (values) => {
    onSubmit({
      name: values.name,
      ...(values.startsAt ? { startsAt: startOfDayInZone(values.startsAt, CAMPAIGN_TIMEZONE) } : {}),
      ...(values.endsAt ? { endsAt: endOfDayExclusiveInZone(values.endsAt, CAMPAIGN_TIMEZONE) } : {}),
      reward: {
        name: values.rewardName,
        pointsCost: Number(values.pointsCost),
        ...(values.totalInventory ? { totalInventory: Number(values.totalInventory) } : {}),
        perCustomerLimit: Number(values.perCustomerLimit),
        claimExpiryDays: Number(values.claimExpiryDays),
        ...(values.terms ? { terms: values.terms } : {}),
      },
    });
  };


  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-6">
      <ServerErrorText message={serverError} />

      <TextField
        id="reward-campaign-name"
        label="Campaign name"
        placeholder="e.g. Free Drink Friday"
        {...(errors.name?.message ? { errorText: errors.name.message } : {})}
        {...register("name")}
      />

      <TextField
        id="reward-name"
        label="Reward name"
        placeholder="e.g. Free medium iced coffee"
        {...(errors.rewardName?.message ? { errorText: errors.rewardName.message } : {})}
        {...register("rewardName")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="reward-points-cost"
          label="Points cost"
          placeholder="0"
          inputMode="numeric"
          {...(errors.pointsCost?.message ? { errorText: errors.pointsCost.message } : {})}
          {...register("pointsCost")}
        />
        <TextField
          id="reward-total-inventory"
          label="Inventory (optional)"
          placeholder="Unlimited"
          inputMode="numeric"
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
          {...(errors.perCustomerLimit?.message ? { errorText: errors.perCustomerLimit.message } : {})}
          {...register("perCustomerLimit")}
        />
        <TextField
          id="reward-claim-expiry-days"
          label="Claim expires after (days)"
          placeholder="30"
          inputMode="numeric"
          {...(errors.claimExpiryDays?.message ? { errorText: errors.claimExpiryDays.message } : {})}
          {...register("claimExpiryDays")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField id="reward-starts-at" label="Start date (optional)" type="date" {...register("startsAt")} />
        <TextField
          id="reward-ends-at"
          label="End date (optional)"
          type="date"
          {...(errors.endsAt?.message ? { errorText: errors.endsAt.message } : {})}
          {...register("endsAt")}
        />
      </div>
      <p className="text-body-s text-on-surface-variant">Dates follow Philippine time.</p>

      <div className="flex flex-col gap-2">
        <label htmlFor="reward-terms" className="text-label-l text-on-surface">
          Terms (optional)
        </label>
        <textarea
          id="reward-terms"
          rows={3}
          className={cn(fieldControlClass, "py-3", controlBorderClass(false))}
          {...register("terms")}
        />
      </div>

      <StepActions onBack={onBack} onCancel={onCancel} submitting={submitting} />
    </form>
  );
}

// --------------------------------------------------------- loyalty programs

const loyaltyFormSchema = z
  .object({
    name: z
      .string()
      .min(CAMPAIGN_NAME_MIN_LENGTH, "Campaign name is required")
      .max(CAMPAIGN_NAME_MAX_LENGTH),
    programType: programTypeSchema,
    targetValue: z.string().min(1, "Target is required"),
    prizeRewardName: z
      .string()
      .min(REWARD_NAME_MIN_LENGTH, "Prize reward name is required")
      .max(REWARD_NAME_MAX_LENGTH),
    prizeClaimExpiryDays: z.string().optional(),
    stampIcon: z.string().optional(),
    minAmountPerStamp: z.string().optional(),
    maxStampsPerDay: z.string().optional(),
    resetsOnCompletion: z.boolean().optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!isPositiveInt(value.targetValue, { min: 1 })) {
      ctx.addIssue({ code: "custom", path: ["targetValue"], message: "Enter a whole number, at least 1" });
    }
    if (value.prizeClaimExpiryDays && !isPositiveInt(value.prizeClaimExpiryDays, { min: 1, max: 365 })) {
      ctx.addIssue({
        code: "custom",
        path: ["prizeClaimExpiryDays"],
        message: "Enter a whole number of days, 1 to 365",
      });
    }
    if (value.minAmountPerStamp && !isValidPeso(value.minAmountPerStamp)) {
      ctx.addIssue({ code: "custom", path: ["minAmountPerStamp"], message: "Enter a valid peso amount" });
    }
    if (value.maxStampsPerDay && !isPositiveInt(value.maxStampsPerDay, { min: 1 })) {
      ctx.addIssue({ code: "custom", path: ["maxStampsPerDay"], message: "Enter a whole number, at least 1" });
    }
    if (
      value.startsAt &&
      value.endsAt &&
      endOfDayExclusiveInZone(value.endsAt, CAMPAIGN_TIMEZONE).getTime() <=
        startOfDayInZone(value.startsAt, CAMPAIGN_TIMEZONE).getTime()
    ) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after start date" });
    }
  });

type LoyaltyFormValues = z.infer<typeof loyaltyFormSchema>;

const PROGRAM_TYPE_OPTIONS: { value: ProgramType; label: string }[] = [
  { value: "visit_count", label: "Visit count" },
  { value: "points_target", label: "Points target" },
  { value: "receipt_count", label: "Receipt count" },
  { value: "spend_amount", label: "Spend amount" },
  { value: "custom", label: "Custom" },
];

function LoyaltyFields({ onBack, onCancel, submitting, serverError, onSubmit }: StepProps & {
  onSubmit: (data: CreateLoyaltyCampaignInput) => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoyaltyFormValues>({
    resolver: zodResolver(loyaltyFormSchema),
    defaultValues: { programType: "visit_count" },
  });

  const submit: SubmitHandler<LoyaltyFormValues> = (values) => {
    onSubmit({
      name: values.name,
      ...(values.startsAt ? { startsAt: startOfDayInZone(values.startsAt, CAMPAIGN_TIMEZONE) } : {}),
      ...(values.endsAt ? { endsAt: endOfDayExclusiveInZone(values.endsAt, CAMPAIGN_TIMEZONE) } : {}),
      loyaltyProgram: {
        programType: values.programType,
        targetValue: Number(values.targetValue),
        ...(values.stampIcon ? { stampIcon: values.stampIcon } : {}),
        ...(values.minAmountPerStamp
          ? { minAmountPerStampCentavos: pesoToCentavos(values.minAmountPerStamp) }
          : {}),
        ...(values.maxStampsPerDay ? { maxStampsPerDay: Number(values.maxStampsPerDay) } : {}),
        ...(values.resetsOnCompletion !== undefined
          ? { resetsOnCompletion: values.resetsOnCompletion }
          : {}),
        prizeReward: {
          name: values.prizeRewardName,
          ...(values.prizeClaimExpiryDays
            ? { claimExpiryDays: Number(values.prizeClaimExpiryDays) }
            : {}),
        },
      },
    });
  };


  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-6">
      <ServerErrorText message={serverError} />

      <TextField
        id="loyalty-name"
        label="Campaign name"
        placeholder="e.g. Coffee Stamp Card"
        {...(errors.name?.message ? { errorText: errors.name.message } : {})}
        {...register("name")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="loyalty-program-type" className="text-label-l text-on-surface">
            Program type
          </label>
          <select
            id="loyalty-program-type"
            className={cn(fieldControlClass, "h-12", controlBorderClass(false))}
            {...register("programType")}
          >
            {PROGRAM_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <TextField
          id="loyalty-target-value"
          label="Target value"
          placeholder="e.g. 10"
          inputMode="numeric"
          {...(errors.targetValue?.message ? { errorText: errors.targetValue.message } : {})}
          {...register("targetValue")}
        />
      </div>

      <TextField
        id="loyalty-prize-name"
        label="Prize reward name"
        placeholder="e.g. Free bag of beans"
        {...(errors.prizeRewardName?.message ? { errorText: errors.prizeRewardName.message } : {})}
        {...register("prizeRewardName")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="loyalty-stamp-icon"
          label="Stamp icon (optional)"
          placeholder="e.g. local_cafe"
          {...register("stampIcon")}
        />
        <TextField
          id="loyalty-prize-expiry"
          label="Prize claim expiry (days, optional)"
          placeholder="30"
          inputMode="numeric"
          {...(errors.prizeClaimExpiryDays?.message ? { errorText: errors.prizeClaimExpiryDays.message } : {})}
          {...register("prizeClaimExpiryDays")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="loyalty-min-amount"
          label="Min. amount per stamp (optional)"
          placeholder="0.00"
          inputMode="decimal"
          {...(errors.minAmountPerStamp?.message ? { errorText: errors.minAmountPerStamp.message } : {})}
          {...register("minAmountPerStamp")}
        />
        <TextField
          id="loyalty-max-stamps"
          label="Max stamps per day (optional)"
          placeholder="1"
          inputMode="numeric"
          {...(errors.maxStampsPerDay?.message ? { errorText: errors.maxStampsPerDay.message } : {})}
          {...register("maxStampsPerDay")}
        />
      </div>

      <label className="flex items-center gap-2 text-body-m text-on-surface">
        <input type="checkbox" className="size-4 rounded border-outline" {...register("resetsOnCompletion")} />
        Card resets automatically when completed
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField id="loyalty-starts-at" label="Start date (optional)" type="date" {...register("startsAt")} />
        <TextField
          id="loyalty-ends-at"
          label="End date (optional)"
          type="date"
          {...(errors.endsAt?.message ? { errorText: errors.endsAt.message } : {})}
          {...register("endsAt")}
        />
      </div>
      <p className="text-body-s text-on-surface-variant">Dates follow Philippine time.</p>

      <StepActions onBack={onBack} onCancel={onCancel} submitting={submitting} />
    </form>
  );
}

// ------------------------------------------------------------------- root

export function CampaignForm({ onSubmit, onCancel, submitting = false, serverError = null }: CampaignFormProps) {
  const [formType, setFormType] = React.useState<CampaignFormType | null>(null);

  if (formType === null) {
    return <TypePicker onSelect={setFormType} onCancel={onCancel} />;
  }

  const stepProps: StepProps = {
    onBack: () => setFormType(null),
    onCancel,
    submitting,
    serverError,
  };

  if (formType === "promotion") {
    return (
      <PromotionFields {...stepProps} onSubmit={(data) => onSubmit({ type: "promotion", data })} />
    );
  }
  if (formType === "reward") {
    return <RewardFields {...stepProps} onSubmit={(data) => onSubmit({ type: "reward", data })} />;
  }
  return <LoyaltyFields {...stepProps} onSubmit={(data) => onSubmit({ type: "loyalty", data })} />;
}

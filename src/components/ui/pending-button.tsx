"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "@/components/ui/button";
import { CircularProgress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

// Pending states for mutating actions.
//
// Three rules, all of which this file enforces so a caller cannot forget one:
//
//   1. A tapped button must VISIBLY say it was tapped. On a slow Philippine
//      mobile connection the gap between tap and server response is the whole
//      experience, and a button that looks idle during it invites a second tap.
//   2. It must not be tappable twice. `disabled` while pending, always.
//   3. It must not SHIFT LAYOUT when its label changes. "Claim" is narrower
//      than "Claiming", and a button that resizes mid-tap moves whatever is
//      under it. The label stack below solves this by rendering both labels in
//      the same CSS grid cell: the grid is as wide as the WIDER label from
//      first paint, and swapping which one is visible changes nothing about
//      the box.
//
// `aria-busy` and a polite live region carry the same news to assistive tech,
// because a spinner is invisible to a screen reader.

interface LabelStackProps {
  readonly pending: boolean;
  readonly idleLabel: React.ReactNode;
  readonly pendingLabel: React.ReactNode;
}

/**
 * Both labels occupy the same grid cell. The inactive one is hidden with
 * `invisible` (not `hidden`) so it keeps contributing its width, which is what
 * fixes the button's size. Nothing reflows when the state flips.
 *
 * The inactive label is ALSO `aria-hidden`. Without it the button's accessible
 * name is the concatenation of both labels -- "Claim Claiming" -- which is
 * what a screen reader would read out and what `getByRole(name)` would match.
 * `visibility: hidden` alone would do the job in a real browser, but leaning on
 * it would make the accessible name depend on whether a stylesheet loaded, and
 * a button's name should not be a CSS side effect.
 */
function LabelStack({ pending, idleLabel, pendingLabel }: LabelStackProps) {
  return (
    <span className="grid grid-cols-1 grid-rows-1 place-items-center">
      <span
        aria-hidden={pending}
        className={cn(
          "col-start-1 row-start-1 whitespace-nowrap",
          pending && "invisible",
        )}
      >
        {idleLabel}
      </span>
      <span
        aria-hidden={!pending}
        className={cn(
          "col-start-1 row-start-1 whitespace-nowrap",
          !pending && "invisible",
        )}
      >
        {pendingLabel}
      </span>
    </span>
  );
}

export interface PendingButtonProps extends Omit<ButtonProps, "children"> {
  readonly pending: boolean;
  readonly children: React.ReactNode;
  /**
   * Label shown while pending. Defaults to the idle label, which is a fine
   * choice when the spinner alone is enough of a signal.
   */
  readonly pendingLabel?: React.ReactNode;
}

/**
 * A Button whose pending state is CONTROLLED by the caller. Use this where the
 * mutation is driven by client state rather than a form submission: the reward
 * claim, the review-queue approve and reject confirmations.
 */
export function PendingButton({
  pending,
  children,
  pendingLabel,
  disabled,
  className,
  ...props
}: PendingButtonProps) {
  return (
    <Button
      {...props}
      aria-busy={pending}
      disabled={disabled === true || pending}
      className={cn("relative", className)}
    >
      {pending ? <CircularProgress size="sm" /> : null}
      <LabelStack
        pending={pending}
        idleLabel={children}
        pendingLabel={pendingLabel ?? children}
      />
    </Button>
  );
}

export interface SubmitButtonProps extends Omit<ButtonProps, "children" | "type"> {
  readonly children: React.ReactNode;
  readonly pendingLabel?: React.ReactNode;
}

/**
 * A submit button that reads its own pending state from the enclosing form via
 * `useFormStatus`. This is the idiomatic path for this app's server-action
 * forms: the form stays a server component, and only the button ships JS.
 *
 * Must be rendered INSIDE the `<form>` it belongs to; `useFormStatus` returns
 * the status of the nearest ancestor form and reports `false` forever if the
 * button is a sibling of the form rather than a descendant.
 */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  className,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <PendingButton
      {...props}
      type="submit"
      pending={pending}
      pendingLabel={pendingLabel}
      {...(disabled === undefined ? {} : { disabled })}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </PendingButton>
  );
}

/**
 * Pending state for a form control that is NOT a `Button` (a bare styled
 * `<button>`, a label-wrapped file input). Gives the caller the same
 * `useFormStatus` reading without forcing the Button component on them.
 *
 * Render inside the form. The children function receives the pending flag.
 */
export function FormPending({
  children,
}: {
  readonly children: (pending: boolean) => React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return <>{children(pending)}</>;
}

"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";

import { revokeDevice } from "../actions";
import { GENERIC_FAILURE, reportThrown } from "../messages";
import type { DeviceDTO } from "../server/devices";

// The one client island on /profile/devices. The page reads and gates; this
// removes.
//
// THE COPY IN HERE IS LOAD-BEARING, NOT DECORATION.
//
// Deleting a `user_devices` row does NOT invalidate that browser's Supabase
// session. The refresh token lives in GoTrue's own tables, not in this one, so
// the browser whose row was just deleted keeps refreshing and stays signed in.
// A device list that implied "signed out everywhere" would be advertising a
// control the product does not have - and that is precisely the Critical T3.2
// took, where /suspended told consumers they could not redeem while redemption
// was ungated.
//
// So this screen says two true things instead of one comforting one: removing a
// device takes it off the list, and it does not sign that browser out. And it
// points at the control that DOES help somebody who thinks their account is
// compromised, which is changing the password.
//
// THE ONE SESSION THAT CAN REALLY BE ENDED IS THIS ONE. Removing the device you
// are holding is a foreseeable tap, so it is wired to a real `auth.signOut()`
// in the action and this component follows it to /login. That row's button says
// so before it is pressed rather than after.

export interface DeviceListProps {
  readonly devices: readonly DeviceDTO[];
}

export function DeviceList({ devices: initial }: DeviceListProps) {
  const router = useRouter();
  const reduce = useReducedMotion();

  const [devices, setDevices] = React.useState<readonly DeviceDTO[]>(initial);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function handleRemove(device: DeviceDTO): Promise<void> {
    // Per row, not a global flag: a slow revoke on one device has no business
    // freezing the rest of the list. What it must stop is a second tap on the
    // SAME row, which would send a delete for a row that is already gone.
    if (removing === device.id) return;

    setRemoving(device.id);
    setError(null);

    try {
      const result = await revokeDevice(device.id);

      if (!result.ok) {
        // The row stays. Removing it from the list on a failed delete would
        // show a device as gone while the database still has it.
        // `||`, not `??`: a message of "" is falsy but not nullish, and `??`
        // would let it through to render an empty alert.
        setError(result.message || GENERIC_FAILURE);
        return;
      }

      if (result.signedOut) {
        // This session is genuinely over - the action called auth.signOut().
        // `replace`, not `push`: there is nothing to go back to.
        router.replace("/login");
        return;
      }

      setDevices((current) => current.filter((entry) => entry.id !== device.id));
      router.refresh();
    } catch (thrown) {
      setError(reportThrown(`revoke device threw`, thrown));
    } finally {
      // In `finally`. A throw that skipped this would leave the row's control
      // wedged with nothing on screen explaining why.
      setRemoving(null);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      {/* No AnimatePresence and no exit animation, deliberately. A row that
          animates out lingers in the DOM after the state says it is gone, and
          "the list still shows a device the database no longer has" is the one
          thing this list must never do - including for the moment somebody
          spends looking at it. The surviving rows still slide up via `layout`,
          which is the motion that actually communicates the removal. */}
      <ul className="flex flex-col gap-3">
        {devices.map((device) => (
          <motion.li
            key={device.id}
            layout={!reduce}
            transition={reduce ? { duration: 0 } : { duration: 0.2 }}
            className="flex items-start justify-between gap-3 overflow-hidden rounded-md3-md border border-outline-variant bg-surface-container p-4"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-label-l text-on-surface">{device.summary}</span>
              <span className="text-body-s text-on-surface-variant">
                Last used {device.lastSeen}
              </span>
              {device.isCurrent ? (
                <span className="mt-1 inline-flex w-fit items-center rounded-full bg-secondary-container px-2 py-0.5 text-label-s text-on-secondary-container">
                  This device
                </span>
              ) : null}
            </div>
            {/* THE CONSEQUENCE IS IN THE VISIBLE TEXT, not in an aria-label.
                `aria-label` REPLACES the accessible name; it adds nothing to
                what a sighted person reads. A button reading "Remove" whose
                hidden name says "this signs you out" warns precisely the users
                who were not going to be surprised.

                The device name is appended in a visually hidden span rather
                than by overriding the name, so the accessible name CONTAINS the
                visible label (WCAG 2.5.3 Label in Name - a voice-control user
                saying "click remove and sign out" has to hit this button) while
                a screen reader still gets "Remove and sign out, Chrome on
                Windows" instead of "Remove" four times down a list. */}
            <Button
              type="button"
              variant="text"
              onClick={() => void handleRemove(device)}
              disabled={removing === device.id}
            >
              {device.isCurrent ? "Remove and sign out" : "Remove"}
              <span className="sr-only">, {device.summary}</span>
            </Button>
          </motion.li>
        ))}
      </ul>

      {error !== null ? (
        <p role="alert" className="text-body-s text-error">
          {error}
        </p>
      ) : null}

      {/* Says what removing does and, just as importantly, what it does not.
          Silence here would mislead somebody who came to this screen because
          they think another person is using their account.

          THE SECOND SENTENCE IS THE QUALIFICATION, and it is not optional. The
          disclaimer before it is true of every row EXCEPT the one the consumer
          is on, where revokeDevice really does call auth.signOut(). Left
          unqualified it is T3.2's Critical inverted: there the product claimed
          a control it did not have; here it would disclaim a consequence it
          does have, and the surprise sign-out lands on somebody who has just
          read that nothing would happen. */}
      <p className="text-body-s text-on-surface-variant">
        Removing a device takes it off this list. It does not sign that browser out on its own, so
        it stays signed in until its session expires or somebody signs out on it. Removing the
        device you are using now signs you out here. If you think someone else is using your
        account,{" "}
        <Link href="/forgot-password" className="text-primary hover:underline">
          change your password
        </Link>
        .
      </p>
    </div>
  );
}

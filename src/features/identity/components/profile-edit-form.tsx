"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/ui/pending-button";
import { TextField } from "@/components/ui/text-field";

import {
  removeConsumerAvatar,
  saveConsumerAvatar,
  saveConsumerProfile,
} from "../actions";
import { AVATAR_ACCEPTED_MIME_TYPES, AVATAR_MAX_UPLOAD_BYTES, oversizePhotoMessage } from "../avatar";
import { initialsFrom } from "../display-name";
import { GENERIC_FAILURE } from "../messages";
import { DISPLAY_NAME_MAX_LENGTH, profileEditSchema } from "../profile-schema";
import { CityPicker, useCityPicker } from "./city-picker";

// The one client island on /profile/edit. The page around it stays a server
// component, and nothing but plain data crosses the boundary into here.
//
// Two independent mutations, deliberately not merged into one submit:
//
//   * The photo is applied the moment it is picked. A file input that stages a
//     change until some later Save is a change people lose - they pick, they see
//     nothing happen, they leave.
//   * The name and city are saved together by the Save button, because they are
//     text fields somebody is mid-edit on and applying those per keystroke would
//     be writing drafts to the database.
//
// EVERY failure keeps the input on screen and says something specific. There is
// one alert region and it is never handed an empty string: `||`, not `??`. A
// server message of "" is falsy but not nullish, so `??` lets it through and the
// alert renders an empty box - a live bug this codebase has already shipped
// once, which is why `toErrorMessage` exists. GENERIC_FAILURE is imported from
// `messages.ts` rather than redeclared here: that module is the one place this
// slice's consumer-facing copy lives, and the server actions read the same
// constants, so the form and the action cannot end up saying different things.
//
// EVERY action call is also wrapped. A server action can THROW instead of
// returning - a 413 past the Server Action body limit, a dropped connection, a
// deploy mid-request - and before that was handled the rejection went unhandled,
// the busy flag was never cleared, and the screen sat there with every control
// disabled and nothing written on it.

/**
 * Log the thrown value, return the consumer's sentence.
 *
 * The mirror of `infrastructureFailure` in actions.ts, and it exists because
 * that fix was half-applied: RETURNED database and storage errors were mapped to
 * copy while THROWN ones went through `toErrorMessage` and rendered the
 * framework's own words - "Body exceeded 1 MB limit", "Failed to fetch",
 * "ECONNRESET". Same slice, same class of failure, two different policies.
 *
 * A throw is infrastructure by definition. Nothing that reaches a catch here is
 * a choice the consumer made and could change, so there is nothing for a
 * specific message to tell them. The detail goes to the console, where a
 * developer with the session open is the one who can act on it.
 */
function reportThrown(scope: string, thrown: unknown): string {
  console.error(`[identity] ${scope}`, thrown);
  return GENERIC_FAILURE;
}

export interface ProfileEditFormProps {
  readonly displayName: string;
  readonly cityName: string | null;
  readonly avatarUrl: string | null;
}

export function ProfileEditForm({
  displayName: initialDisplayName,
  cityName: initialCityName,
  avatarUrl: initialAvatarUrl,
}: ProfileEditFormProps) {
  const router = useRouter();
  const reduce = useReducedMotion();

  const [displayName, setDisplayName] = React.useState(initialDisplayName);
  const [cityName, setCityName] = React.useState(initialCityName);
  const [avatarUrl, setAvatarUrl] = React.useState(initialAvatarUrl);

  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [busyWithPhoto, setBusyWithPhoto] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // This form never unmounts the picker, so the placement is not load-bearing
  // here the way it is in the onboarding wizard - but the hook is where the
  // ref_cities read lives, so it has to be called by somebody.
  const cityPicker = useCityPicker();

  // Local validation, so the person hears about a name that cannot be stored
  // before spending a round trip on it. The SAME schema runs again server side;
  // this copy catches a mistake early, never instead of the server's.
  const localIssue = React.useMemo(() => {
    const parsed = profileEditSchema.safeParse({ displayName, cityName });
    if (parsed.success) return null;
    return parsed.error.issues[0]?.message || GENERIC_FAILURE;
  }, [displayName, cityName]);

  // Only after the field has been touched, so an empty form does not greet
  // somebody with a complaint about a name they have not typed yet.
  const [nameTouched, setNameTouched] = React.useState(false);
  const nameError = nameTouched ? localIssue : null;

  const initials = initialsFrom(displayName) || "?";

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (savingProfile) return;

    setNameTouched(true);
    setSaved(false);
    if (localIssue !== null) {
      // Deliberately NOT also set as the form-level error. Marking the field
      // touched already surfaces the same sentence under the field it is about,
      // which is where somebody is looking; repeating it at the bottom of the
      // form would announce it twice to a screen reader and give the page two
      // alert regions saying one thing.
      setError(null);
      return;
    }

    setSavingProfile(true);
    setError(null);
    try {
      const result = await saveConsumerProfile({ displayName, cityName });

      if (!result.ok) {
        // Stay put with the typed values intact. Navigating away or resetting
        // the form would throw away work and leave nothing to retry.
        setError(result.message || GENERIC_FAILURE);
        return;
      }

      setSaved(true);
      router.refresh();
    } catch (thrown) {
      // A server action can THROW rather than return: a 413 past the body
      // limit, a dropped connection, a deploy mid-request. Before this catch
      // existed the rejection went unhandled and the screen said nothing.
      setError(reportThrown("save profile threw", thrown));
    } finally {
      // In `finally`, not after the await. A throw used to skip the reset, which
      // left every control disabled with no message - a dead screen until
      // reload. This is the line that makes the failure honest.
      setSavingProfile(false);
    }
  }

  async function handlePhotoPicked(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Reset the input straight away so picking the SAME file twice fires change
    // again - otherwise a failed upload cannot be retried without picking a
    // different photo.
    event.target.value = "";
    if (!file) return;

    setSaved(false);

    // CHECKED HERE, not only in the action. Next answers a Server Action body
    // past `experimental.serverActions.bodySizeLimit` with a 413 BEFORE the
    // action function is entered, so the action's own size message is not
    // something a browser caller can ever be shown. The action keeps its check
    // for callers that are not this form.
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
      setError(oversizePhotoMessage());
      return;
    }

    setBusyWithPhoto(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.set("avatar", file);
      const result = await saveConsumerAvatar(formData);

      if (!result.ok) {
        setError(result.message || GENERIC_FAILURE);
        return;
      }

      setAvatarUrl(result.avatarUrl);
      router.refresh();
    } catch (thrown) {
      setError(reportThrown("save avatar threw", thrown));
    } finally {
      setBusyWithPhoto(false);
    }
  }

  async function handleRemovePhoto(): Promise<void> {
    if (busyWithPhoto) return;
    setBusyWithPhoto(true);
    setError(null);
    setSaved(false);

    try {
      const result = await removeConsumerAvatar();

      if (!result.ok) {
        setError(result.message || GENERIC_FAILURE);
        return;
      }

      setAvatarUrl(result.avatarUrl);
      router.refresh();
    } catch (thrown) {
      setError(reportThrown("remove avatar threw", thrown));
    } finally {
      setBusyWithPhoto(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="mt-6 flex flex-col gap-8">
      <section className="flex flex-col gap-4" aria-labelledby="photo-heading">
        <h2 id="photo-heading" className="text-title-m text-on-surface">
          Photo
        </h2>
        <div className="flex items-center gap-4">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public storage-CDN object; next/image domain allowlisting is not set up for this slice
            <img
              src={avatarUrl}
              alt=""
              className="size-20 shrink-0 rounded-full bg-secondary-container object-cover"
            />
          ) : (
            <span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-secondary-container text-title-l text-on-secondary-container">
              {initials}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {/* A label wrapping a visually hidden input, not a button that
                clicks a hidden input: the label IS the control, so it is
                keyboard reachable and correctly named without any JS. */}
            <label
              className="inline-flex h-10 cursor-pointer items-center rounded-full bg-secondary-container px-5 text-label-l text-on-secondary-container transition-colors duration-200 ease-standard hover:opacity-90 focus-within:ring-2 focus-within:ring-primary aria-disabled:pointer-events-none aria-disabled:opacity-40"
              aria-disabled={busyWithPhoto || undefined}
            >
              {avatarUrl ? "Change photo" : "Add a photo"}
              <input
                ref={fileInputRef}
                type="file"
                name="avatar"
                accept={AVATAR_ACCEPTED_MIME_TYPES.join(",")}
                disabled={busyWithPhoto}
                onChange={(event) => void handlePhotoPicked(event)}
                className="sr-only"
              />
            </label>
            {avatarUrl ? (
              <Button
                type="button"
                variant="text"
                onClick={() => void handleRemovePhoto()}
                disabled={busyWithPhoto}
              >
                Remove photo
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="name-heading">
        <h2 id="name-heading" className="text-title-m text-on-surface">
          Name
        </h2>
        <TextField
          id="display-name"
          label="Display name"
          value={displayName}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          onChange={(event) => setDisplayName(event.target.value)}
          onBlur={() => setNameTouched(true)}
          {...(nameError === null
            ? { helperText: "This is the name businesses see when you scan." }
            : { errorText: nameError })}
        />
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="city-heading">
        <h2 id="city-heading" className="text-title-m text-on-surface">
          City
        </h2>
        <p className="text-body-s text-on-surface-variant">
          We show you deals near here first.
        </p>
        <CityPicker
          state={cityPicker}
          value={cityName}
          onChange={setCityName}
          searchInputId="profile-city-search"
        />
      </section>

      {/* One alert region for both mutations. `role="alert"` so it is announced
          the moment it appears, rather than sitting silently above a form
          somebody is already halfway down. */}
      {error !== null ? (
        <p role="alert" className="text-body-s text-error">
          {error}
        </p>
      ) : null}

      {saved ? (
        <motion.p
          role="status"
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.2 }}
          className="text-body-s text-on-surface-variant"
        >
          Saved.
        </motion.p>
      ) : null}

      <PendingButton
        type="submit"
        variant="filled"
        size="touch"
        pending={savingProfile}
        pendingLabel="Saving"
        disabled={busyWithPhoto}
      >
        Save
      </PendingButton>
    </form>
  );
}

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DISPLAY_NAME_MAX_LENGTH } from "../profile-schema";

// The edit surface itself. /profile has been read-only since it was built, so
// every behaviour here is new: a save that persists, a failure that keeps the
// typed values on screen with a SPECIFIC message, and an avatar that can be
// added, replaced and removed.

const mocks = vi.hoisted(() => ({
  saveConsumerProfile: vi.fn(),
  saveConsumerAvatar: vi.fn(),
  removeConsumerAvatar: vi.fn(),
  refresh: vi.fn(),
  cities: [{ name: "Cebu City" }, { name: "Davao City" }, { name: "Naga (Camarines Sur)" }],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));

vi.mock("../actions", () => ({
  saveConsumerProfile: mocks.saveConsumerProfile,
  saveConsumerAvatar: mocks.saveConsumerAvatar,
  removeConsumerAvatar: mocks.removeConsumerAvatar,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => Promise.resolve({ data: mocks.cities, error: null }) }),
      }),
    }),
  }),
}));

const { ProfileEditForm } = await import("./profile-edit-form");

const AVATAR_URL = "https://proj.supabase.co/storage/v1/object/public/avatars/user-1/a.jpg";
const NEXT_AVATAR_URL = "https://proj.supabase.co/storage/v1/object/public/avatars/user-1/b.jpg";

function renderForm(
  props: Partial<{ displayName: string; cityName: string | null; avatarUrl: string | null }> = {},
) {
  return render(
    <ProfileEditForm
      displayName="Ana Cruz"
      cityName="Davao City"
      avatarUrl={null}
      {...props}
    />,
  );
}

function nameField(): HTMLInputElement {
  return screen.getByLabelText("Display name") as HTMLInputElement;
}

/**
 * Clicks Save by TYPE rather than by name: PendingButton swaps its accessible
 * name to "Saving" while a submit is in flight, so a name query cannot find the
 * same control twice in a row - which is exactly what the double-tap test needs
 * to do.
 */
function save(): void {
  fireEvent.click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
}

function pickPhoto(name = "me.jpg", type = "image/jpeg"): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3]) as unknown as BlobPart], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveConsumerProfile.mockResolvedValue({ ok: true });
  mocks.saveConsumerAvatar.mockResolvedValue({ ok: true, avatarUrl: NEXT_AVATAR_URL });
  mocks.removeConsumerAvatar.mockResolvedValue({ ok: true, avatarUrl: null });
});

describe("ProfileEditForm: what it starts with", () => {
  it("opens with the values the consumer already has, not an empty form", async () => {
    renderForm();

    expect(nameField()).toHaveValue("Ana Cruz");
    expect(await screen.findByRole("radio", { name: /Davao/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("does not complain about a name nobody has touched yet", () => {
    renderForm({ displayName: "" });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ProfileEditForm: saving name and city", () => {
  it("CRITICAL: persists the edited name and the chosen city together", async () => {
    renderForm();

    fireEvent.change(nameField(), { target: { value: "Ana Marie Cruz" } });
    fireEvent.click(await screen.findByRole("radio", { name: /Cebu/ }));
    save();

    await waitFor(() =>
      expect(mocks.saveConsumerProfile).toHaveBeenCalledWith({
        displayName: "Ana Marie Cruz",
        cityName: "Cebu City",
      }),
    );
  });

  it("confirms the save rather than leaving it ambiguous", async () => {
    renderForm();
    save();

    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("refreshes the server data so /profile is not stale behind it", async () => {
    renderForm();
    save();

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("CRITICAL: a failed save keeps the typed input on screen with a specific message", async () => {
    mocks.saveConsumerProfile.mockResolvedValue({
      ok: false,
      message: "We could not match that city. Pick one from the list and try again.",
    });
    renderForm();

    fireEvent.change(nameField(), { target: { value: "Ana Marie Cruz" } });
    save();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not match that city. Pick one from the list and try again.",
    );
    // The work survives the failure. A form that resets on error is a form that
    // makes people retype what they just lost.
    expect(nameField()).toHaveValue("Ana Marie Cruz");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("CRITICAL: an EMPTY server message renders the generic copy, not a blank alert", async () => {
    // `message ?? FALLBACK` does not catch "" - `??` only catches null and
    // undefined, and "" is falsy but not nullish - so the alert node renders
    // nothing at all and the screen looks like the tap did nothing. This
    // codebase has shipped that bug once already.
    mocks.saveConsumerProfile.mockResolvedValue({ ok: false, message: "" });
    renderForm();

    save();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim()).toBe("Something went wrong. Please try again.");
    expect(alert.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("CRITICAL: refuses a name past the database bound without calling the server", async () => {
    renderForm();

    fireEvent.change(nameField(), { target: { value: "a".repeat(DISPLAY_NAME_MAX_LENGTH + 1) } });
    save();

    // The complaint lands on the FIELD, described by it, not in a second alert
    // region at the bottom of the form.
    const alert = await screen.findByRole("alert");
    expect(nameField()).toHaveAttribute("aria-describedby", alert.id);
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(mocks.saveConsumerProfile).not.toHaveBeenCalled();
  });

  it("refuses an empty name the same way", async () => {
    renderForm();

    fireEvent.change(nameField(), { target: { value: "   " } });
    save();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(mocks.saveConsumerProfile).not.toHaveBeenCalled();
  });

  it("stops complaining once the name is fixed", async () => {
    renderForm();
    fireEvent.change(nameField(), { target: { value: "" } });
    save();
    await screen.findByRole("alert");

    fireEvent.change(nameField(), { target: { value: "Ana" } });

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("clears a stale failure once the next save succeeds", async () => {
    mocks.saveConsumerProfile.mockResolvedValueOnce({ ok: false, message: "Network is down" });
    renderForm();

    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Network is down");

    save();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("does not submit twice on a double tap", async () => {
    let release: (value: { ok: true }) => void = () => {};
    mocks.saveConsumerProfile.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );
    renderForm();

    save();
    save();

    expect(mocks.saveConsumerProfile).toHaveBeenCalledTimes(1);
    release({ ok: true });
  });
});

describe("ProfileEditForm: the avatar", () => {
  it("shows the initials circle when there is no photo, and no image", () => {
    const { container } = renderForm({ avatarUrl: null });

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("AC")).toBeInTheDocument();
    expect(screen.getByText("Add a photo")).toBeInTheDocument();
  });

  it("shows the photo, and offers to change or remove it, when there is one", () => {
    const { container } = renderForm({ avatarUrl: AVATAR_URL });

    expect(container.querySelector("img")).toHaveAttribute("src", AVATAR_URL);
    expect(screen.getByText("Change photo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove photo" })).toBeInTheDocument();
  });

  it("CRITICAL: uploading a photo sends the file and shows the new one", async () => {
    const { container } = renderForm({ avatarUrl: null });

    pickPhoto();

    await waitFor(() => expect(mocks.saveConsumerAvatar).toHaveBeenCalled());
    const sent = mocks.saveConsumerAvatar.mock.calls[0]?.[0] as FormData;
    expect(sent.get("avatar")).toBeInstanceOf(File);
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute("src", NEXT_AVATAR_URL),
    );
  });

  it("CRITICAL: removing a photo goes back to the initials circle", async () => {
    const { container } = renderForm({ avatarUrl: AVATAR_URL });

    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));

    await waitFor(() => expect(mocks.removeConsumerAvatar).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(screen.getByText("AC")).toBeInTheDocument();
  });

  it("a failed upload says why and leaves the previous photo in place", async () => {
    mocks.saveConsumerAvatar.mockResolvedValue({
      ok: false,
      message: "That photo is larger than 8 MB. Try a smaller one.",
    });
    const { container } = renderForm({ avatarUrl: AVATAR_URL });

    pickPhoto();

    expect(await screen.findByRole("alert")).toHaveTextContent("larger than 8 MB");
    expect(container.querySelector("img")).toHaveAttribute("src", AVATAR_URL);
  });

  it("an EMPTY upload error message renders the generic copy too", async () => {
    mocks.saveConsumerAvatar.mockResolvedValue({ ok: false, message: "" });
    renderForm({ avatarUrl: null });

    pickPhoto();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim()).toBe("Something went wrong. Please try again.");
  });

  it("a failed removal leaves the photo on screen", async () => {
    mocks.removeConsumerAvatar.mockResolvedValue({ ok: false, message: "could not clear" });
    const { container } = renderForm({ avatarUrl: AVATAR_URL });

    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not clear");
    expect(container.querySelector("img")).toHaveAttribute("src", AVATAR_URL);
  });

  it("CRITICAL: clears the file input so the SAME photo can be retried", async () => {
    // Without this a failed upload cannot be retried without picking a
    // DIFFERENT file: a file input whose value is unchanged fires no `change`
    // event when the same file is chosen again.
    //
    // Asserted by watching the value SETTER rather than by reading `.value`
    // back. jsdom's `fireEvent.change(input, { target: { files } })` never
    // populates `.value` in the first place, so `expect(input.value).toBe("")`
    // is true whether or not the component clears anything - a green assertion
    // about nothing.
    mocks.saveConsumerAvatar.mockResolvedValue({ ok: false, message: "nope" });
    renderForm({ avatarUrl: null });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const writes: string[] = [];
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: (next: string) => writes.push(next),
    });

    pickPhoto();
    await screen.findByRole("alert");

    expect(writes).toContain("");
  });

  it("offers only the formats the bucket accepts", () => {
    renderForm({ avatarUrl: null });

    expect(document.querySelector('input[type="file"]')).toHaveAttribute(
      "accept",
      "image/jpeg,image/png,image/webp",
    );
  });

  it("does nothing at all when the picker is dismissed without a file", () => {
    renderForm({ avatarUrl: null });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });

    expect(mocks.saveConsumerAvatar).not.toHaveBeenCalled();
  });
});

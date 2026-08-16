import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The heart is the only thing a consumer touches in this whole feature, and it
// was the only part of it with no test: `repo.test.ts` covered the four
// database calls and stopped there. Everything below is about the gap between
// the tap and the row landing, which is where an optimistic control can lie.

const mocks = vi.hoisted(() => ({ toggleFavoriteAction: vi.fn() }));

vi.mock("../server/actions", () => ({
  toggleFavoriteAction: mocks.toggleFavoriteAction,
}));

const { FavoriteButton } = await import("./favorite-button");

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";

const ADD = "Add to favorites";
const REMOVE = "Remove from favorites";

/** A promise the test resolves by hand, so "still in flight" is observable. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function heart(): HTMLElement {
  return screen.getByRole("button");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.toggleFavoriteAction.mockResolvedValue({ ok: true });
});

describe("FavoriteButton resting state", () => {
  it("offers to ADD when the business is not yet a favourite", () => {
    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite={false} />);

    expect(heart()).toHaveAccessibleName(ADD);
    expect(heart().textContent).toBe("favorite_border");
  });

  it("offers to REMOVE when it already is one", () => {
    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite />);

    expect(heart()).toHaveAccessibleName(REMOVE);
    expect(heart().textContent).toBe("favorite");
  });
});

describe("FavoriteButton optimistic toggle", () => {
  it("CRITICAL: flips before the write resolves, so the tap is not silent", async () => {
    const write = deferred<{ ok: boolean }>();
    mocks.toggleFavoriteAction.mockReturnValue(write.promise);

    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite={false} />);
    fireEvent.click(heart());

    // Nothing has come back from the server yet. The heart is already filled.
    expect(mocks.toggleFavoriteAction).toHaveBeenCalledTimes(1);
    expect(heart()).toHaveAccessibleName(REMOVE);
    expect(heart().textContent).toBe("favorite");

    await act(async () => {
      write.resolve({ ok: true });
    });
  });

  it("CRITICAL: sends the state the write must UNDO, not the state it optimistically showed", async () => {
    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite />);

    await act(async () => {
      fireEvent.click(heart());
    });

    // `true` here is what routes the action to removeFavorite. Sending the
    // already-flipped `false` would call addFavorite on a row that exists and
    // leave the favourite in place while the UI claimed it was gone.
    expect(mocks.toggleFavoriteAction).toHaveBeenCalledWith(BUSINESS_ID, true);
  });

  it("keeps the new state when the write succeeds", async () => {
    await act(async () => {
      render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite={false} />);
    });

    await act(async () => {
      fireEvent.click(heart());
    });

    expect(heart()).toHaveAccessibleName(REMOVE);
  });

  it("locks the control while the write is in flight, so one tap is one write", async () => {
    const write = deferred<{ ok: boolean }>();
    mocks.toggleFavoriteAction.mockReturnValue(write.promise);

    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite={false} />);
    fireEvent.click(heart());

    expect(heart()).toBeDisabled();
    fireEvent.click(heart());
    expect(mocks.toggleFavoriteAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      write.resolve({ ok: true });
    });
  });
});

describe("FavoriteButton when the write fails", () => {
  it("CRITICAL: reverts to ADD rather than leaving a heart the database never filled", async () => {
    mocks.toggleFavoriteAction.mockResolvedValue({ ok: false, message: "Unauthenticated" });

    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite={false} />);
    await act(async () => {
      fireEvent.click(heart());
    });

    await waitFor(() => {
      expect(heart()).toHaveAccessibleName(ADD);
    });
    expect(heart().textContent).toBe("favorite_border");
  });

  it("CRITICAL: reverts a REMOVE too, rather than hiding a favourite that is still saved", async () => {
    mocks.toggleFavoriteAction.mockResolvedValue({ ok: false, message: "boom" });

    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite />);
    await act(async () => {
      fireEvent.click(heart());
    });

    await waitFor(() => {
      expect(heart()).toHaveAccessibleName(REMOVE);
    });
    expect(heart().textContent).toBe("favorite");
  });

  it("becomes tappable again after a failure, so the consumer can retry", async () => {
    mocks.toggleFavoriteAction.mockResolvedValue({ ok: false, message: "boom" });

    render(<FavoriteButton businessId={BUSINESS_ID} initialIsFavorite={false} />);
    await act(async () => {
      fireEvent.click(heart());
    });

    await waitFor(() => {
      expect(heart()).not.toBeDisabled();
    });
  });
});

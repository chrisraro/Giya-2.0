import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// THIS FILE PROVES NOTHING ABOUT REACHABILITY, ON PURPOSE.
//
// A test that renders <ScanPreview /> directly passed for the whole time no
// page imported it, which was T4.6's actual defect. That question is settled
// elsewhere and only elsewhere: `/scan`'s page test and the earning rule card's
// test both drive this component through the surface that mounts it.
//
// What is left over is the one thing those tests cannot see, because they let
// every request settle inside act(): what is on screen WHILE an answer is in
// flight. The component holds an answer plus the question it answered and shows
// the figure only when the two still match, and a stale points figure is
// indistinguishable from a fresh one to the person reading it.

const mocks = vi.hoisted(() => ({ previewReceiptPointsAction: vi.fn() }));

vi.mock("../server/preview-action", () => ({
  previewReceiptPointsAction: mocks.previewReceiptPointsAction,
}));

const { ScanPreview } = await import("./scan-preview");

type PreviewResult = { ok: true; points: number; basePoints: number; multiplierExtras: number };

function deferred(): { promise: Promise<PreviewResult>; resolve: (value: PreviewResult) => void } {
  let resolve!: (value: PreviewResult) => void;
  const promise = new Promise<PreviewResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function points(n: number): PreviewResult {
  return { ok: true, points: n, basePoints: n, multiplierExtras: 0 };
}

function figure(): HTMLElement {
  const el = screen.getByLabelText("Receipt total in pesos").parentElement?.parentElement
    ?.nextElementSibling;
  if (!(el instanceof HTMLElement)) throw new Error("estimate element not found");
  return el;
}

async function type(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Receipt total in pesos"), { target: { value } });
  });
}

const PESO_50 = { rateCentavosPerPoint: 5000, rounding: "floor" } as const;
const PESO_10 = { rateCentavosPerPoint: 1000, rounding: "floor" } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScanPreview while an estimate is in flight", () => {
  it("CRITICAL: blanks the figure rather than leaving the old rule's answer on screen", async () => {
    const first = deferred();
    const second = deferred();
    mocks.previewReceiptPointsAction
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<ScanPreview rule={PESO_50} />);
    await type("300");
    await act(async () => {
      first.resolve(points(6));
    });
    expect(figure().textContent).toBe("~6 pts");

    // The rule changes underneath the figure, which is exactly what the
    // merchant card does. 6 is now the answer to a question nobody is asking.
    await act(async () => {
      rerender(<ScanPreview rule={PESO_10} />);
    });

    expect(figure().textContent).toBe("");
    expect(figure()).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      second.resolve(points(30));
    });
    expect(figure().textContent).toBe("~30 pts");
  });

  it("CRITICAL: an out-of-order response cannot overwrite the answer to what was typed last", async () => {
    const first = deferred();
    const second = deferred();
    mocks.previewReceiptPointsAction
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<ScanPreview rule={PESO_50} />);
    await type("300");
    await type("400");

    // The ₱400 request settles first, then the ₱300 one it overtook lands.
    await act(async () => {
      second.resolve(points(8));
    });
    await act(async () => {
      first.resolve(points(6));
    });

    expect(figure().textContent).toBe("~8 pts");
  });

  it("marks itself busy while waiting, rather than reading as a settled zero", async () => {
    const first = deferred();
    mocks.previewReceiptPointsAction.mockReturnValueOnce(first.promise);

    render(<ScanPreview rule={PESO_50} />);
    await type("300");

    expect(figure()).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      first.resolve(points(6));
    });
    expect(figure()).toHaveAttribute("aria-busy", "false");
  });

  it("asks nothing at all for a blank or non-positive amount", async () => {
    render(<ScanPreview rule={PESO_50} />);

    await type("");
    await type("0");
    await type("-5");

    expect(mocks.previewReceiptPointsAction).not.toHaveBeenCalled();
    expect(figure().textContent).toBe("");
  });
});

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

const submitMock = vi.hoisted(() => ({ submitCapturedReceipt: vi.fn() }));
vi.mock("@/features/receipts/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/receipts/upload")>();
  return { ...actual, submitCapturedReceipt: submitMock.submitCapturedReceipt };
});

import { putOutboxItem, listOutboxItems, type OutboxItem } from "@/features/pwa/outbox";
import { OUTBOX_UPLOADED_MESSAGE } from "@/features/pwa/outbox-copy";
import { ReceiptOutbox } from "./receipt-outbox";

// A REAL IndexedDB again: every claim this card makes is a claim about what is
// on the device, and a stand-in store would let all of them pass vacuously.
function row(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: "row-1",
    image: new NodeBlob(["jpeg"], { type: "image/jpeg" }) as unknown as Blob,
    client_sha256: null,
    business_id: null,
    captured_at: "2026-08-16T09:00:00.000Z",
    idempotency_key: "22222222-2222-4222-8222-222222222222",
    image_path: null,
    attempts: 0,
    last_error: null,
    status: "queued",
    ...overrides,
  };
}

const ACCEPTED = { ok: true, receiptId: "receipt-1", status: "queued", imagePath: "u/1.jpg" };
const OFFLINE = {
  ok: false,
  error: { kind: "network", code: "OFFLINE", title: "", message: "", retryable: true },
  imagePath: null,
};

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  submitMock.submitCapturedReceipt.mockReset();
  // Default: the drain finds no signal, so mounting the card in a test that is
  // about rendering does not empty the queue underneath it.
  submitMock.submitCapturedReceipt.mockResolvedValue(OFFLINE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReceiptOutbox card (doc 41 section 3)", () => {
  it("renders nothing at all when the queue is empty", async () => {
    const { container } = render(<ReceiptOutbox />);

    await waitFor(() => expect(submitMock.submitCapturedReceipt).not.toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the waiting receipts, and says receipt rather than receipts for one", async () => {
    await putOutboxItem(row());

    render(<ReceiptOutbox />);

    expect(await screen.findByText("1 receipt waiting to upload")).toBeInTheDocument();
  });

  it("shows every queued receipt with its capture time and status", async () => {
    await putOutboxItem(row({ id: "a", captured_at: "2026-08-16T09:00:00.000Z" }));
    await putOutboxItem(row({ id: "b", captured_at: "2026-08-16T09:30:00.000Z", status: "failed", attempts: 5 }));

    render(<ReceiptOutbox />);

    expect(await screen.findByText("2 receipts waiting to upload")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Waiting for a connection")).toBeInTheDocument();
    expect(screen.getByText("Not sent yet. Tap Retry.")).toBeInTheDocument();
    // The two capture times are rendered as machine-readable times, so two
    // receipts taken minutes apart are distinguishable.
    const times = screen.getAllByText((_, element) => element?.tagName === "TIME");
    expect(times.map((element) => element.getAttribute("datetime"))).toEqual([
      "2026-08-16T09:00:00.000Z",
      "2026-08-16T09:30:00.000Z",
    ]);
  });

  it("offers Retry only on a row that has run out of automatic attempts", async () => {
    await putOutboxItem(row({ id: "waiting" }));
    await putOutboxItem(row({ id: "done", captured_at: "2026-08-16T09:30:00.000Z", status: "failed" }));

    render(<ReceiptOutbox />);

    await screen.findByText("2 receipts waiting to upload");
    // One Retry button, not two: a row still inside its backoff needs no tap.
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });
});

describe("ReceiptOutbox replay (doc 41 sections 3 and 6)", () => {
  it("drains on mount, which is the app-launch replay iOS depends on", async () => {
    await putOutboxItem(row());
    submitMock.submitCapturedReceipt.mockResolvedValue(ACCEPTED);

    render(<ReceiptOutbox />);

    await waitFor(() => expect(submitMock.submitCapturedReceipt).toHaveBeenCalledTimes(1));
    // The row is gone from IndexedDB, not merely from the screen.
    await waitFor(async () => expect(await listOutboxItems()).toHaveLength(0));
  });

  it("drains again when the connection comes back", async () => {
    await putOutboxItem(row());
    render(<ReceiptOutbox />);
    await screen.findByText("1 receipt waiting to upload");
    expect(submitMock.submitCapturedReceipt).toHaveBeenCalledTimes(1);

    submitMock.submitCapturedReceipt.mockResolvedValue(ACCEPTED);
    fireEvent(window, new Event("online"));

    await waitFor(() => expect(submitMock.submitCapturedReceipt).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect(await listOutboxItems()).toHaveLength(0));
  });

  it("CRITICAL: an online transition retries a row that a mount will not touch", async () => {
    // Five attempts are spendable in one bad afternoon, and doc 41 section 8
    // gives an iOS outbox about seven days before eviction. A mount is not
    // evidence anything changed - navigating to /receipts and back would spend
    // attempts on a row that has none left - but `online` is, so the two runs
    // pass different answers and this test is what holds them apart.
    await putOutboxItem(row({ status: "failed", attempts: 5, last_error: "network" }));
    render(<ReceiptOutbox />);
    await screen.findByText("1 receipt waiting to upload");
    expect(submitMock.submitCapturedReceipt).not.toHaveBeenCalled();

    submitMock.submitCapturedReceipt.mockResolvedValue(ACCEPTED);
    fireEvent(window, new Event("online"));

    await waitFor(() => expect(submitMock.submitCapturedReceipt).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await listOutboxItems()).toHaveLength(0));
  });

  it("tells the consumer the receipt was uploaded, in doc 41's words", async () => {
    await putOutboxItem(row());
    submitMock.submitCapturedReceipt.mockResolvedValue(ACCEPTED);

    render(<ReceiptOutbox />);

    // And it OUTLIVES the row it is about. The queue is empty by now, so a card
    // that unmounted with its last row would have deleted the receipt, uploaded
    // it, and told the consumer nothing.
    expect(
      await screen.findByText("Receipt uploaded. We are processing it now."),
    ).toBeInTheDocument();
    expect(await listOutboxItems()).toHaveLength(0);
    expect(screen.queryByText(/waiting to upload/)).not.toBeInTheDocument();
    expect(OUTBOX_UPLOADED_MESSAGE).toBe("Receipt uploaded. We are processing it now.");
  });

  it("refreshes when the service worker says it drained the queue itself", async () => {
    // Background Sync ran with this page open. The replay happened in the
    // worker, so nothing on this screen would notice without the message.
    const listeners: ((event: MessageEvent) => void)[] = [];
    vi.stubGlobal("navigator", {
      onLine: true,
      serviceWorker: {
        addEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.push(fn),
        removeEventListener: () => undefined,
      },
    });
    await putOutboxItem(row());
    render(<ReceiptOutbox />);
    await screen.findByText("1 receipt waiting to upload");

    await deleteEverything();
    listeners.forEach((fn) => fn({ data: { type: "OUTBOX_CHANGED" } } as MessageEvent));

    await waitFor(() =>
      expect(screen.queryByText("1 receipt waiting to upload")).not.toBeInTheDocument(),
    );
  });

  it("ignores service worker messages that are not about the outbox", async () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    vi.stubGlobal("navigator", {
      onLine: true,
      serviceWorker: {
        addEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.push(fn),
        removeEventListener: () => undefined,
      },
    });
    await putOutboxItem(row());
    render(<ReceiptOutbox />);
    await screen.findByText("1 receipt waiting to upload");

    await deleteEverything();
    listeners.forEach((fn) => fn({ data: { type: "SKIP_WAITING" } } as MessageEvent));

    // Still showing the stale count, because nothing told it to look again.
    // This is the discriminator for the test above: without it, a card that
    // refreshed on EVERY message would pass that one too.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText("1 receipt waiting to upload")).toBeInTheDocument();
  });
});

describe("ReceiptOutbox manual actions", () => {
  it("clears the attempt budget when the consumer retries by hand", async () => {
    await putOutboxItem(row({ status: "failed", attempts: 5, last_error: "network" }));
    render(<ReceiptOutbox />);
    await screen.findByRole("button", { name: "Retry" });
    // The mount drain left it alone: a `failed` row is the drain's way of
    // saying it is out of automatic attempts, so nothing has been submitted yet.
    expect(submitMock.submitCapturedReceipt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(submitMock.submitCapturedReceipt).toHaveBeenCalledTimes(1));
    const [item] = await listOutboxItems();
    expect(item?.attempts).toBe(0);
    expect(item?.status).toBe("queued");
  });

  it("needs two taps to delete, because the queued photo is the only copy", async () => {
    await putOutboxItem(row());
    render(<ReceiptOutbox />);
    await screen.findByText("1 receipt waiting to upload");

    fireEvent.click(screen.getByRole("button", { name: "Delete this receipt" }));

    expect(await listOutboxItems()).toHaveLength(1);
    const confirm = await screen.findByRole("button", {
      name: "Tap again to delete this receipt for good",
    });

    fireEvent.click(confirm);

    await waitFor(async () => expect(await listOutboxItems()).toHaveLength(0));
  });
});

/** Empties the store behind the card's back, so a refresh has something to see. */
async function deleteEverything(): Promise<void> {
  const { deleteOutboxItem } = await import("@/features/pwa/outbox");
  for (const item of await listOutboxItems()) await deleteOutboxItem(item.id);
}

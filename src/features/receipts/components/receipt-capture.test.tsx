import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
}));

// The canvas pipeline cannot run in jsdom (no 2d context, no toBlob), so the
// compression step is stubbed. Everything else in the module stays real -
// notably validateCaptureFile, so the 10MB rejection below is the production
// rule and not a test double.
const compressMocks = vi.hoisted(() => ({
  compressReceiptFile: vi.fn(),
  clientSha256: vi.fn(),
}));
vi.mock("../compress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compress")>();
  return {
    ...actual,
    compressReceiptFile: compressMocks.compressReceiptFile,
    clientSha256: compressMocks.clientSha256,
  };
});

import { ReceiptCapture } from "./receipt-capture";

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";
const IMAGE_PATH = "0d5a3f0c-1111-4111-8111-111111111111/2b8f0c1a-2222-4222-8222-222222222222.jpg";
const UPLOAD_URL = "https://storage.example/object/upload/sign/receipts/x?token=abc";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ticket = () =>
  jsonResponse(200, { data: { upload_url: UPLOAD_URL, image_path: IMAGE_PATH, token: "t" } });
const putOk = () => new Response(null, { status: 200 });
const accepted = () => jsonResponse(202, { data: { receipt_id: "receipt-1", status: "queued" } });

function photoFile(name = "receipt.jpg", type = "image/jpeg", size = 2048): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function pickFromGallery(file: File): void {
  const input = screen.getByLabelText(/Choose from gallery/);
  fireEvent.change(input, { target: { files: [file] } });
}

/** Drive the flow to the confirm step with a stubbed compression result. */
async function captureAPhoto(): Promise<void> {
  pickFromGallery(photoFile());
  expect(await screen.findByRole("button", { name: "Use this photo" })).toBeInTheDocument();
}

function submitCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => call[0] === "/api/v1/receipts");
}

function idempotencyKeyOf(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  nav.push.mockReset();
  compressMocks.clientSha256.mockResolvedValue(undefined);
  compressMocks.compressReceiptFile.mockReset();
  compressMocks.compressReceiptFile.mockResolvedValue({
    blob: new Blob(["jpeg"], { type: "image/jpeg" }),
    width: 2048,
    height: 1536,
    quality: 0.8,
    byteSize: 900_000,
    reducedBeyondDefault: false,
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReceiptCapture idle state", () => {
  it("starts idle with a gallery source when the browser has no camera API", () => {
    // jsdom has no navigator.mediaDevices, which is exactly the no-camera
    // branch: the screen must still be usable, never a dead end.
    render(<ReceiptCapture />);

    expect(screen.getByText("Add your receipt")).toBeInTheDocument();
    expect(screen.getByText(/cannot open the camera/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Choose from gallery/)).toBeInTheDocument();
    // No viewfinder is rendered, so no getUserMedia prompt can be triggered.
    expect(screen.queryByLabelText(/Camera viewfinder/)).not.toBeInTheDocument();
  });

  it("keeps the file input focusable rather than display:none", () => {
    render(<ReceiptCapture />);

    const input = screen.getByLabelText(/Choose from gallery/);
    expect(input).toHaveClass("sr-only");
    expect(input).not.toBeDisabled();
    input.focus();
    expect(input).toHaveFocus();
  });

  it("mentions the pre-bound business when one was passed", () => {
    render(<ReceiptCapture businessId={BUSINESS_ID} />);

    expect(screen.getByText(/sent to the store you came from/)).toBeInTheDocument();
  });

  it("renders the dev-only OCR stub note only when told to", () => {
    const { unmount } = render(<ReceiptCapture />);
    expect(screen.queryByText(/OCR stub active/)).not.toBeInTheDocument();
    unmount();

    render(<ReceiptCapture showOcrStubNote />);
    expect(screen.getByText(/Dev only: OCR stub active/)).toBeInTheDocument();
  });
});

describe("ReceiptCapture capture to confirm", () => {
  it("moves to the confirm step with a retake option after a photo is picked", async () => {
    render(<ReceiptCapture />);

    await captureAPhoto();

    expect(screen.getByRole("button", { name: "Retake" })).toBeInTheDocument();
    expect(compressMocks.compressReceiptFile).toHaveBeenCalledTimes(1);
    // Nothing is uploaded before the consumer confirms: doc 33's confirm step
    // exists so a blurry first frame is never auto-submitted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns to the capture step on Retake", async () => {
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Retake" }));

    expect(screen.getByText("Add your receipt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this photo" })).not.toBeInTheDocument();
  });

  it("rejects a file over 10MB before any compression work happens", async () => {
    render(<ReceiptCapture />);

    pickFromGallery(photoFile("huge.jpg", "image/jpeg", 11 * 1024 * 1024));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That photo is too large");
    expect(alert).toHaveTextContent("under 10MB");
    expect(compressMocks.compressReceiptFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported file type with format guidance", async () => {
    render(<ReceiptCapture />);

    pickFromGallery(photoFile("statement.pdf", "application/pdf"));

    expect(await screen.findByRole("alert")).toHaveTextContent("not a photo we can read");
    expect(compressMocks.compressReceiptFile).not.toHaveBeenCalled();
  });

  it("explains a HEIC photo this browser cannot decode", async () => {
    const { ImageCaptureError } = await import("../compress");
    compressMocks.compressReceiptFile.mockRejectedValueOnce(
      new ImageCaptureError("decode_failed", "no decoder"),
    );
    render(<ReceiptCapture />);

    pickFromGallery(photoFile("IMG_0001.heic", "image/heic"));

    expect(await screen.findByRole("alert")).toHaveTextContent("cannot open that photo");
  });
});

describe("ReceiptCapture submission", () => {
  it("uploads, submits with an Idempotency-Key and routes to the status screen", async () => {
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(accepted());
    render(<ReceiptCapture businessId={BUSINESS_ID} />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/scan/receipt-1"));
    const submits = submitCalls(fetchMock);
    expect(submits).toHaveLength(1);
    expect(idempotencyKeyOf(submits[0] ?? [])).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.parse((submits[0]?.[1] as RequestInit).body as string)).toEqual({
      image_path: IMAGE_PATH,
      business_id: BUSINESS_ID,
    });
  });

  it("shows the sending state while the submission is in flight", async () => {
    let releaseSubmit: (() => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseSubmit = () => resolve(accepted());
          }),
      );
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    expect(await screen.findByText("Sending your receipt...")).toBeInTheDocument();
    expect(screen.getByText("Sending your receipt.")).toBeInTheDocument();
    releaseSubmit?.();
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
  });

  it("freezes the advisory client hash at the first attempt so a retry body cannot drift", async () => {
    // The hash resolves asynchronously. If a retry picked it up late, the body
    // would change under an unchanged Idempotency-Key and the server would
    // answer 409 IDEMPOTENCY_REPLAYED instead of replaying the original 202.
    let resolveHash: ((value: string | undefined) => void) | undefined;
    compressMocks.clientSha256.mockReturnValueOnce(
      new Promise<string | undefined>((resolve) => {
        resolveHash = resolve;
      }),
    );
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "DEPENDENCY_UNAVAILABLE" } }))
      .mockResolvedValueOnce(accepted());
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    resolveHash?.("b".repeat(64));
    // Flush the hash promise and its state update BEFORE retrying, so this
    // test would fail if the retry read the (now populated) preview hash
    // instead of the value frozen with the key.
    await act(async () => {});
    fireEvent.click(retry);

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const submits = submitCalls(fetchMock);
    expect((submits[0]?.[1] as RequestInit).body).toBe((submits[1]?.[1] as RequestInit).body);
  });

  it("reuses the SAME Idempotency-Key and image path when a failed submission is retried", async () => {
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "DEPENDENCY_UNAVAILABLE" } }))
      .mockResolvedValueOnce(accepted());
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/scan/receipt-1"));

    const submits = submitCalls(fetchMock);
    expect(submits).toHaveLength(2);
    // The whole point of the header: one submission, one key, however many
    // attempts. A key minted per attempt would file a second receipt.
    expect(idempotencyKeyOf(submits[0] ?? [])).toBe(idempotencyKeyOf(submits[1] ?? []));
    // And the same body, so the server replays instead of answering 409
    // IDEMPOTENCY_REPLAYED: the bytes are already in the bucket, so no second
    // upload ticket is minted.
    expect((submits[0]?.[1] as RequestInit).body).toBe((submits[1]?.[1] as RequestInit).body);
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/v1/receipts/uploads")).toHaveLength(1);
  });

  it("mints a FRESH Idempotency-Key once the consumer retakes the photo", async () => {
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "DEPENDENCY_UNAVAILABLE" } }))
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(accepted());
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Take another photo" }));
    await captureAPhoto();
    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/scan/receipt-1"));
    const submits = submitCalls(fetchMock);
    expect(submits).toHaveLength(2);
    // A different photo is a different submission, so it must not inherit the
    // abandoned one's key: the server would replay the old failure forever.
    expect(idempotencyKeyOf(submits[0] ?? [])).not.toBe(idempotencyKeyOf(submits[1] ?? []));
  });

  it("shows scan-limit copy with the Retry-After window and no retry button on 403 CONSUMER_SCAN_BLOCKED", async () => {
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(
        jsonResponse(403, { error: { code: "CONSUMER_SCAN_BLOCKED" } }, { "Retry-After": "7200" }),
      );
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Scan limit reached");
    expect(alert).toHaveTextContent("in about 2 hours");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
  });

  it("shows already-scanned copy on 422 RECEIPT_DUPLICATE", async () => {
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(jsonResponse(422, { error: { code: "RECEIPT_DUPLICATE" } }));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Already scanned");
    expect(alert).toHaveTextContent("already scanned this receipt");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take another photo" })).toBeInTheDocument();
  });

  it("offers a sign-in link on 401 rather than a pointless retry", async () => {
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "UNAUTHENTICATED" } }));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("refuses honestly when a network failure cannot be queued either", async () => {
    // jsdom has no IndexedDB and this test does not install one, so the outbox
    // refuses. The screen must NOT claim the receipt was saved: an unqueueable
    // capture that says "saved on your phone" is the exact failure the outbox
    // rewrite exists to remove.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not save it on this phone");
    expect(alert).toHaveTextContent("so it was not kept");
    expect(screen.queryByText(/We will send it when you are back online/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("ReceiptCapture offline queueing (doc 41 section 3)", () => {
  // A REAL IndexedDB, for the same reason outbox.test.ts uses one: the claim
  // under test is that the receipt is on the phone, and a stand-in store would
  // let that claim pass without a single byte reaching a database.
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("navigator", { onLine: true });
  });

  it("queues the receipt when the connection dies, and says exactly that", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReceiptCapture businessId={BUSINESS_ID} />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    expect(
      await screen.findByText("Saved on your phone. We will send it when you are back online."),
    ).toBeInTheDocument();
    // Not an error, and not a route change: the consumer stays put and knows
    // where the receipt is.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();

    const { listOutboxItems } = await import("@/features/pwa/outbox");
    const items = await listOutboxItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.business_id).toBe(BUSINESS_ID);
    expect(items[0]?.status).toBe("queued");
    expect(items[0]?.attempts).toBe(0);
  });

  it("stores the SAME Idempotency-Key the failed attempt used", async () => {
    // This is receipt-capture.test.tsx's in-session retry property carried
    // across a process death. If the queued row held a fresh key, a replay
    // after the tab closed would file a second receipt for the same purchase
    // whenever the original POST had actually reached the server.
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ReceiptCapture businessId={BUSINESS_ID} />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await screen.findByText(/We will send it when you are back online/);

    const submits = submitCalls(fetchMock);
    expect(submits).toHaveLength(1);
    const { listOutboxItems } = await import("@/features/pwa/outbox");
    const [item] = await listOutboxItems();
    expect(item?.idempotency_key).toBe(idempotencyKeyOf(submits[0] ?? []));
    // And it is a real key, not two coincidentally-undefined values.
    expect(item?.idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("CRITICAL: carries the image_path of an upload that already landed", async () => {
    // The presign and the PUT succeeded; only the submit POST died. The bytes
    // are in the bucket under IMAGE_PATH, so the queued row must remember it:
    // POST /api/v1/receipts/uploads mints a fresh path on every call, and a
    // replay that re-presigned would change the body under an unchanged
    // Idempotency-Key and be answered 409 instead of replaying the 202.
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await screen.findByText(/We will send it when you are back online/);

    const { listOutboxItems } = await import("@/features/pwa/outbox");
    const [item] = await listOutboxItems();
    expect(item?.image_path).toBe(IMAGE_PATH);
  });

  it("stores no image_path when the capture never reached the network", async () => {
    // The other side of the boundary: nothing was uploaded, so the drain has to
    // presign for itself rather than replay a path that does not exist.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await screen.findByText(/We will send it when you are back online/);

    const { listOutboxItems } = await import("@/features/pwa/outbox");
    const [item] = await listOutboxItems();
    expect(item?.image_path).toBeNull();
  });

  it("CRITICAL: stamps captured_at when the photo was taken, not when sending failed", async () => {
    // Doc 41 section 3: "minted at capture". It is also the outbox's FIFO key,
    // so a stamp taken at enqueue time would order the queue by when
    // submissions gave up rather than by when photos were taken, and would show
    // the consumer a time they never took a photo at.
    vi.setSystemTime(new Date("2026-08-16T09:00:00.000Z"));
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReceiptCapture />);
    await captureAPhoto();

    // Ten minutes pass on the confirm screen before they tap send.
    vi.setSystemTime(new Date("2026-08-16T09:10:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await screen.findByText(/We will send it when you are back online/);

    const { listOutboxItems } = await import("@/features/pwa/outbox");
    const [item] = await listOutboxItems();
    expect(item?.captured_at).toBe("2026-08-16T09:00:00.000Z");
    vi.useRealTimers();
  });

  it("does NOT queue a 4xx, because a domain answer is not a missing connection", async () => {
    fetchMock
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce(putOk())
      .mockResolvedValueOnce(jsonResponse(422, { error: { code: "RECEIPT_DUPLICATE" } }));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Already scanned");
    const { listOutboxItems } = await import("@/features/pwa/outbox");
    expect(await listOutboxItems()).toHaveLength(0);
  });

  it("refuses the 11th capture with the cap sentence and never says it was saved", async () => {
    const { putOutboxItem, listOutboxItems } = await import("@/features/pwa/outbox");
    for (let index = 0; index < 10; index += 1) {
      await putOutboxItem({
        id: `row-${index}`,
        image: new NodeBlob(["x"], { type: "image/jpeg" }) as unknown as Blob,
        client_sha256: null,
        business_id: null,
        captured_at: `2026-08-16T09:0${index}:00.000Z`,
        idempotency_key: `key-${index}`,
        image_path: null,
        attempts: 0,
        last_error: null,
        status: "queued",
      });
    }
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Upload your pending receipts first.");
    expect(screen.queryByText(/We will send it when you are back online/)).not.toBeInTheDocument();
    expect(await listOutboxItems()).toHaveLength(10);
  });

  it("asks for a Background Sync replay once the receipt is queued", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      onLine: true,
      serviceWorker: { ready: Promise.resolve({ sync: { register } }) },
    });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await screen.findByText(/We will send it when you are back online/);

    await waitFor(() => expect(register).toHaveBeenCalledWith("receipt-outbox"));
  });

  it("still queues on a browser with no Background Sync, and says so anyway", async () => {
    // Doc 41 section 6: unsupported on iOS Safari. The receipt is on the phone
    // either way, so the confirmation must not depend on the registration.
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: { ready: Promise.resolve({}) } });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReceiptCapture />);
    await captureAPhoto();

    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));

    expect(await screen.findByText(/We will send it when you are back online/)).toBeInTheDocument();
    const { listOutboxItems } = await import("@/features/pwa/outbox");
    expect(await listOutboxItems()).toHaveLength(1);
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Realtime-to-poll fallback, tested at the seam that matters: what the
// hook does when the socket misbehaves, and what it does when the socket says
// everything is fine but delivers nothing (the exact failure mode a table
// missing from the `supabase_realtime` publication produces, which is what
// `receipts` looked like before 0020_realtime_receipts.sql).

interface ChannelConfig {
  event: string;
  schema: string;
  table: string;
  filter: string;
}

const mocks = vi.hoisted(() => ({
  channelNames: [] as string[],
  configs: [] as ChannelConfig[],
  changeHandlers: [] as ((payload: { new?: unknown }) => void)[],
  subscribeCallbacks: [] as ((status: string) => void)[],
  removeChannel: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const channel = {
      on(_event: string, config: ChannelConfig, handler: (payload: { new?: unknown }) => void) {
        mocks.configs.push(config);
        mocks.changeHandlers.push(handler);
        return channel;
      },
      subscribe(callback: (status: string) => void) {
        mocks.subscribeCallbacks.push(callback);
        return channel;
      },
    };

    return {
      channel(name: string) {
        mocks.channelNames.push(name);
        return channel;
      },
      removeChannel: mocks.removeChannel,
    };
  },
}));

const { useReceiptRealtime, RECEIPT_FALLBACK_POLL_DELAY_MS, RECEIPT_POLL_INTERVAL_MS } =
  await import("./use-receipt-realtime");

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";

interface HookArgs {
  enabled?: boolean;
  onRow?: (row: Record<string, unknown>) => void;
  onPoll?: () => void;
}

function renderSubject(args: HookArgs = {}) {
  const onRow = args.onRow ?? vi.fn();
  const onPoll = args.onPoll ?? vi.fn();

  const result = renderHook(
    (props: { enabled: boolean }) =>
      useReceiptRealtime({
        channelName: `receipt-${RECEIPT_ID}`,
        filter: `id=eq.${RECEIPT_ID}`,
        enabled: props.enabled,
        onRow,
        onPoll,
      }),
    { initialProps: { enabled: args.enabled ?? true } },
  );

  return { ...result, onRow, onPoll };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function emitSubscribeStatus(status: string): void {
  act(() => {
    for (const callback of mocks.subscribeCallbacks) callback(status);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.channelNames.length = 0;
  mocks.configs.length = 0;
  mocks.changeHandlers.length = 0;
  mocks.subscribeCallbacks.length = 0;
  mocks.removeChannel.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useReceiptRealtime subscription", () => {
  it("subscribes to postgres_changes on public.receipts with the caller's filter", () => {
    renderSubject();

    expect(mocks.channelNames).toEqual([`receipt-${RECEIPT_ID}`]);
    expect(mocks.configs[0]).toEqual({
      event: "UPDATE",
      schema: "public",
      table: "receipts",
      filter: `id=eq.${RECEIPT_ID}`,
    });
  });

  it("hands a changed row to onRow", () => {
    const { onRow } = renderSubject();

    act(() => {
      mocks.changeHandlers[0]?.({ new: { id: RECEIPT_ID, status: "approved" } });
    });

    expect(onRow).toHaveBeenCalledWith({ id: RECEIPT_ID, status: "approved" });
  });

  it("ignores a payload with no usable row (a DELETE, or a stripped payload)", () => {
    const { onRow } = renderSubject();

    act(() => {
      mocks.changeHandlers[0]?.({ new: {} });
      mocks.changeHandlers[0]?.({});
    });

    expect(onRow).not.toHaveBeenCalled();
  });

  it("does not subscribe at all while disabled", () => {
    renderSubject({ enabled: false });

    expect(mocks.channelNames).toEqual([]);
  });

  it("tears the channel down on unmount", () => {
    const { unmount } = renderSubject();

    unmount();

    expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("tears the channel down when the caller stops watching", () => {
    const { rerender } = renderSubject();

    rerender({ enabled: false });

    expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
  });
});

describe("useReceiptRealtime poll fallback", () => {
  it("starts polling every 5s when the channel errors", () => {
    const { onPoll } = renderSubject();

    emitSubscribeStatus("CHANNEL_ERROR");
    expect(onPoll).not.toHaveBeenCalled();

    advance(RECEIPT_POLL_INTERVAL_MS);
    expect(onPoll).toHaveBeenCalledTimes(1);

    advance(RECEIPT_POLL_INTERVAL_MS * 2);
    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  it.each(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"])(
    "starts polling on a %s subscription status",
    (status) => {
      const { onPoll } = renderSubject();

      emitSubscribeStatus(status);
      advance(RECEIPT_POLL_INTERVAL_MS);

      expect(onPoll).toHaveBeenCalledTimes(1);
    },
  );

  it("does not poll immediately on a clean SUBSCRIBED", () => {
    const { onPoll } = renderSubject();

    emitSubscribeStatus("SUBSCRIBED");
    advance(RECEIPT_POLL_INTERVAL_MS);

    expect(onPoll).not.toHaveBeenCalled();
  });

  it("CRITICAL: polls anyway if a cleanly SUBSCRIBED channel goes silent, which is exactly what an unpublished table looks like", () => {
    const { onPoll } = renderSubject();

    emitSubscribeStatus("SUBSCRIBED");

    advance(RECEIPT_FALLBACK_POLL_DELAY_MS - 1);
    expect(onPoll).not.toHaveBeenCalled();

    advance(1 + RECEIPT_POLL_INTERVAL_MS);
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it("never runs two poll loops at once when the channel errors after the fallback already armed", () => {
    const { onPoll } = renderSubject();

    advance(RECEIPT_FALLBACK_POLL_DELAY_MS);
    emitSubscribeStatus("CHANNEL_ERROR");

    advance(RECEIPT_POLL_INTERVAL_MS);

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it("stops polling on unmount", () => {
    const { onPoll, unmount } = renderSubject();

    emitSubscribeStatus("CHANNEL_ERROR");
    advance(RECEIPT_POLL_INTERVAL_MS);
    expect(onPoll).toHaveBeenCalledTimes(1);

    unmount();
    advance(RECEIPT_POLL_INTERVAL_MS * 5);

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the caller stops watching, so a settled receipt is not a heartbeat", () => {
    const { onPoll, rerender } = renderSubject();

    emitSubscribeStatus("CHANNEL_ERROR");
    advance(RECEIPT_POLL_INTERVAL_MS);
    expect(onPoll).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    advance(RECEIPT_POLL_INTERVAL_MS * 10);

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it("does not poll at all while disabled, even long past the fallback delay", () => {
    const { onPoll } = renderSubject({ enabled: false });

    advance(RECEIPT_FALLBACK_POLL_DELAY_MS + RECEIPT_POLL_INTERVAL_MS * 10);

    expect(onPoll).not.toHaveBeenCalled();
  });
});

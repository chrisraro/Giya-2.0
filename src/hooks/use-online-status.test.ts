import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOnlineStatus } from "./use-online-status";

describe("useOnlineStatus", () => {
  it("defaults to true on navigator.onLine", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("updates state on online and offline window events", () => {
    let onlineStatus = true;
    Object.defineProperty(navigator, "onLine", {
      get: () => onlineStatus,
      configurable: true,
    });

    const { result } = renderHook(() => useOnlineStatus());

    act(() => {
      onlineStatus = false;
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);

    act(() => {
      onlineStatus = true;
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });
});

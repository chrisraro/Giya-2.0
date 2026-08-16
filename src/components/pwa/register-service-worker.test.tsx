import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterServiceWorker } from "./register-service-worker";

// The update flow, wired up (doc 41 section 7).
//
// The decisions are proved in src/lib/pwa/register.test.ts. What is proved here
// is that this component reaches them from the browser events that actually
// happen, in the order they actually happen - because the failure this guards
// is not a wrong decision, it is a decision nothing ever asks for. A toast that
// never appears and a Refresh button wired to nothing both look exactly like a
// working PWA until a deploy goes out.

class FakeWorker extends EventTarget {
  public state: ServiceWorkerState = "installing";
  public readonly postMessage = vi.fn();

  becomeInstalled(): void {
    this.state = "installed";
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  public waiting: FakeWorker | null = null;
  public installing: FakeWorker | null = null;

  /** What the browser does on a deploy: a new worker installs, then waits. */
  installUpdate(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
    this.waiting = worker;
    worker.becomeInstalled();
    return worker;
  }
}

class FakeContainer extends EventTarget {
  public controller: object | null = null;
  public readonly registration = new FakeRegistration();
  public readonly register = vi.fn(async () => this.registration);
}

let container: FakeContainer;
let reload: ReturnType<typeof vi.fn>;

function installNavigator(value: FakeContainer | undefined): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  container = new FakeContainer();
  installNavigator(container);

  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RegisterServiceWorker", () => {
  it("registers the worker on mount", async () => {
    render(<RegisterServiceWorker />);
    await waitFor(() => expect(container.register).toHaveBeenCalledWith("/sw.js", { scope: "/" }));
  });

  it("renders nothing when there is no update", async () => {
    render(<RegisterServiceWorker />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("CRITICAL: offers the update when a new worker starts waiting mid-session", async () => {
    container.controller = {};
    render(<RegisterServiceWorker />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    container.registration.installUpdate();

    expect(await screen.findByText("A new version of Giya is ready.")).toBeInTheDocument();
  });

  it("CRITICAL: Refresh tells the waiting worker to take over", async () => {
    // The whole flow's payoff. If this posts nothing, or posts the wrong thing,
    // the button is inert and there is no error anywhere to notice.
    container.controller = {};
    render(<RegisterServiceWorker />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const worker = container.registration.installUpdate();
    await screen.findByText("A new version of Giya is ready.");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("lets the offer be declined, and does not activate anything on the way out", async () => {
    // "Not now" is a real choice, not a delay. Nothing is posted; the update
    // waits for the next launch, where it activates silently.
    container.controller = {};
    render(<RegisterServiceWorker />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const worker = container.registration.installUpdate();
    await screen.findByText("A new version of Giya is ready.");

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("CRITICAL: activates silently, with no toast, when a worker was already waiting at launch", async () => {
    // Doc 41 section 7 step 4. Nothing is in flight before the first
    // interaction, so there is nothing to ask permission to interrupt.
    container.controller = {};
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;

    render(<RegisterServiceWorker />);

    await waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("CRITICAL: reloads when a new worker takes control, but not on a first install", async () => {
    // `clientsClaim` fires controllerchange for the very first worker too,
    // where a reload is a blank flash on someone's first visit.
    render(<RegisterServiceWorker />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads exactly once when an update takes control", async () => {
    container.controller = {};
    render(<RegisterServiceWorker />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange"));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: renders nothing and throws nothing where service workers do not exist", async () => {
    // iOS in a tab below 16.4, insecure origins, some private windows. The
    // consumer shell mounts this on every page; it must be inert, not fatal.
    installNavigator(undefined);
    expect(() => render(<RegisterServiceWorker />)).not.toThrow();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

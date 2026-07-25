import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The Server Action the rows post to. Mocked so this suite renders the list
// without pulling the whole server read path into a DOM environment; what is
// under test here is the markup, the grouping and the tone rules.
vi.mock("../actions", () => ({ openNotification: vi.fn() }));

import type { NotificationDTO } from "../types";
import { NotificationList, dayHeading, groupByDay } from "./notification-list";

const NOW = new Date("2026-07-26T09:00:00.000Z"); // 2026-07-26 17:00 Manila

function notification(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: "n1",
    kind: "points_awarded",
    title: "Points added",
    body: "120 points are now in your Kape Diaria wallet.",
    route: "/scan/r1",
    businessId: "b1",
    readAt: null,
    createdAt: "2026-07-26T02:00:00.000Z", // same Manila day as NOW
    ...overrides,
  };
}

describe("empty state", () => {
  it("says you are all caught up rather than showing an empty list", () => {
    render(<NotificationList notifications={[]} now={NOW} />);

    expect(screen.getByText("You are all caught up")).toBeInTheDocument();
  });

  it("offers the one thing worth doing next", () => {
    render(<NotificationList notifications={[]} now={NOW} />);

    expect(screen.getByRole("link", { name: /Scan a receipt/ })).toHaveAttribute(
      "href",
      "/scan",
    );
  });
});

describe("day grouping (doc 30 section 5.6)", () => {
  it("labels the current Manila day Today", () => {
    expect(dayHeading("2026-07-26T02:00:00.000Z", NOW)).toBe("Today");
  });

  it("labels the previous Manila day Yesterday", () => {
    expect(dayHeading("2026-07-25T02:00:00.000Z", NOW)).toBe("Yesterday");
  });

  it("uses a date beyond that", () => {
    expect(dayHeading("2026-07-20T02:00:00.000Z", NOW)).toBe("July 20");
  });

  it("groups by Manila day, not UTC day", () => {
    // 2026-07-25T17:30Z is 2026-07-26 01:30 in Manila, so it belongs with the
    // rows above it, not with the previous day.
    expect(dayHeading("2026-07-25T17:30:00.000Z", NOW)).toBe("Today");
  });

  it("keeps the newest-first order and never reorders within a group", () => {
    const groups = groupByDay(
      [
        notification({ id: "a", createdAt: "2026-07-26T02:00:00.000Z" }),
        notification({ id: "b", createdAt: "2026-07-26T01:00:00.000Z" }),
        notification({ id: "c", createdAt: "2026-07-25T01:00:00.000Z" }),
      ],
      NOW,
    );

    expect(groups.map((g) => g.heading)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["c"]);
  });
});

describe("rows", () => {
  it("renders the stored title and body, which is what was sent", () => {
    render(<NotificationList notifications={[notification()]} now={NOW} />);

    expect(screen.getByText("Points added")).toBeInTheDocument();
    expect(
      screen.getByText("120 points are now in your Kape Diaria wallet."),
    ).toBeInTheDocument();
  });

  it("posts the notification id and nothing else", () => {
    const { container } = render(
      <NotificationList notifications={[notification()]} now={NOW} />,
    );

    const fields = container.querySelectorAll("input");
    expect(fields).toHaveLength(1);
    expect(fields[0]?.getAttribute("name")).toBe("id");
    expect(fields[0]?.getAttribute("value")).toBe("n1");
  });

  it("CRITICAL: never posts the destination, so the open handler cannot be redirected", () => {
    const { container } = render(
      <NotificationList
        notifications={[notification({ route: "https://evil.example" })]}
        now={NOW}
      />,
    );

    expect(container.querySelector('input[name="route"]')).toBeNull();
    expect(container.innerHTML).not.toContain("evil.example");
  });

  it("marks an unread row for a screen reader, not only with a coloured dot", () => {
    render(<NotificationList notifications={[notification()]} now={NOW} />);

    expect(screen.getByText("Unread")).toBeInTheDocument();
  });

  it("shows no unread marker once the row is read", () => {
    render(
      <NotificationList
        notifications={[notification({ readAt: "2026-07-26T03:00:00.000Z" })]}
        now={NOW}
      />,
    );

    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
  });

  it("renders a row whose kind this build does not know rather than dropping it", () => {
    render(
      <NotificationList
        notifications={[notification({ kind: "announcement", title: "Scheduled downtime" })]}
        now={NOW}
      />,
    );

    expect(screen.getByText("Scheduled downtime")).toBeInTheDocument();
  });
});

describe("Mango stays rewards language (doc 16)", () => {
  function plateClasses(container: HTMLElement): string {
    // The icon plate is the first span inside the row button.
    return container.querySelector("button > span")?.className ?? "";
  }

  it("an award wears the tertiary container", () => {
    const { container } = render(
      <NotificationList notifications={[notification()]} now={NOW} />,
    );

    expect(plateClasses(container)).toContain("bg-tertiary-container");
  });

  it("CRITICAL: a rejection does not", () => {
    const { container } = render(
      <NotificationList
        notifications={[
          notification({
            kind: "receipt_rejected",
            title: "Already scanned",
            body: "This receipt is already on your account.",
          }),
        ]}
        now={NOW}
      />,
    );

    expect(plateClasses(container)).not.toContain("tertiary");
  });

  it("CRITICAL: neither does a receipt waiting on a person", () => {
    const { container } = render(
      <NotificationList
        notifications={[
          notification({
            kind: "receipt_in_review",
            title: "The store is checking this",
            body: "Some receipts get a quick look from a person.",
          }),
        ]}
        now={NOW}
      />,
    );

    expect(plateClasses(container)).not.toContain("tertiary");
  });
});

describe("no raw colours", () => {
  it("uses MD3 token classes only, never a hex value", () => {
    const { container } = render(
      <NotificationList notifications={[notification()]} now={NOW} />,
    );

    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

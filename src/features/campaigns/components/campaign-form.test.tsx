import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { CampaignForm } from "./campaign-form";

describe("CampaignForm", () => {
  it("renders the three campaign type options in the type picker", () => {
    render(<CampaignForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("button", { name: /^Promotion/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reward/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Loyalty/ })).toBeInTheDocument();
  });

  it("shows required-field errors for the promotion form when submitted empty", async () => {
    const onSubmit = vi.fn();
    render(<CampaignForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Promotion/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(await screen.findByText("Enter a percent between 1 and 100")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("parses a peso amount_off field into integer centavos on submit", async () => {
    const onSubmit = vi.fn();
    render(<CampaignForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Promotion/ }));
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Summer Sale" } });
    fireEvent.change(screen.getByLabelText("Offer kind"), { target: { value: "amount_off" } });
    fireEvent.change(screen.getByLabelText("Amount off"), { target: { value: "50.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "promotion",
        data: expect.objectContaining({
          name: "Summer Sale",
          promotion: expect.objectContaining({
            offerKind: "amount_off",
            amountOffCentavos: 5000,
          }),
        }),
      }),
    );
  });

  it("goes back to the type picker from a type-specific step", () => {
    render(<CampaignForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Reward/ }));
    expect(screen.getByLabelText("Reward name")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /^Promotion/ })).toBeInTheDocument();
  });
});

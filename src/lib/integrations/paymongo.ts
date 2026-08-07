import "server-only";

export interface CheckoutSessionInput {
  businessId: string;
  plan: "starter" | "growth" | "enterprise";
  amountCentavos: number;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionResult {
  sessionId: string;
  checkoutUrl: string;
}

export async function createCheckoutSession(
  input: CheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const secretKey = process.env.PAYMONGO_SECRET_KEY;

  if (!secretKey) {
    // Dormant fallback / test stub URL when key is unconfigured
    return {
      sessionId: `cs_stub_${input.businessId}_${Date.now()}`,
      checkoutUrl: `https://checkout.paymongo.com/stub_${input.plan}?business=${input.businessId}`,
    };
  }

  const response = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(secretKey + ":").toString("base64")}`,
    },
    body: JSON.stringify({
      data: {
        attributes: {
          send_email_receipt: true,
          show_description: true,
          show_line_items: true,
          line_items: [
            {
              currency: "PHP",
              amount: input.amountCentavos,
              description: `Giya 2.0 ${input.plan.toUpperCase()} Plan Subscription`,
              name: `Plan: ${input.plan}`,
              quantity: 1,
            },
          ],
          payment_method_types: ["card", "gcash", "paymaya", "grab_pay"],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: {
            business_id: input.businessId,
            plan: input.plan,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`PayMongo API error: ${response.statusText}`);
  }

  const json = await response.json();
  return {
    sessionId: json.data.id,
    checkoutUrl: json.data.attributes.checkout_url,
  };
}

import { describe, expect, it, vi } from "vitest";
import { PaystackProvider } from "@/server/billing/paystack";

describe("Paystack documented HTTP contracts with test doubles", () => {
  it("initializes trusted integer money and redirects only to Paystack checkout", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/fixture",
          access_code: "fixture",
          reference: "atelier-test",
        },
      }),
    );
    const provider = new PaystackProvider("sk_test_fixture", false, transport);
    const result = await provider.initialize({
      email: "owner@example.test",
      amount: 1500000,
      currency: "NGN",
      reference: "atelier-test",
      callbackUrl: "https://example.test/app/billing",
      organizationId: "org-fixture",
    });
    expect(result.authorizationUrl).toBe("https://checkout.paystack.com/fixture");
    expect(transport).toHaveBeenCalledWith(
      "https://api.paystack.co/transaction/initialize",
      expect.objectContaining({ method: "POST", body: expect.any(String), cache: "no-store" }),
    );
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(body.amount).toBe("1500000");
    expect(body.reference).toBe("atelier-test");
  });
  it("rejects a checkout redirect to an arbitrary host", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: true,
        data: {
          authorization_url: "https://evil.example/checkout",
          access_code: "fixture",
          reference: "atelier-test",
        },
      }),
    );
    await expect(
      new PaystackProvider("sk_test_fixture", false, transport).initialize({
        email: "owner@example.test",
        amount: 100,
        currency: "NGN",
        reference: "atelier-test",
        callbackUrl: "https://example.test/app/billing",
        organizationId: "org-fixture",
      }),
    ).rejects.toThrow(/Invalid payment checkout/i);
  });
  it("verifies through the server endpoint and never treats API response status as payment status", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: true, data: { status: "pending" } }));
    expect(
      await new PaystackProvider("sk_test_fixture", false, transport).verify("atelier/escaped"),
    ).toEqual({ status: "pending" });
    expect(transport.mock.calls[0][0]).toBe(
      "https://api.paystack.co/transaction/verify/atelier%2Fescaped",
    );
  });
  it("does not retry an ambiguous initialization or refund network failure", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("network timeout"));
    await expect(
      new PaystackProvider("sk_test_fixture", false, transport).createRefund({
        reference: "fixture",
        amount: 100,
        currency: "NGN",
        reason: "Synthetic refund request",
      }),
    ).rejects.toThrow(/timeout/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

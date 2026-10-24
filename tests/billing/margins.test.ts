import { describe, expect, it } from "vitest";
import { calculateGenerationMargin } from "@/server/billing/margins";

describe("integer monetary margin accounting", () => {
  it("keeps unknown provider cost and foreign exchange unknown", () => {
    expect(
      calculateGenerationMargin({
        revenueKobo: 100000n,
        providerCreditsMilli: 2000n,
        providerUnitCostMicrousd: null,
        ngnPerUsdMicros: null,
      }),
    ).toEqual({ revenueKobo: 100000n, providerCostKobo: null, grossMarginKobo: null });
  });
  it("computes margins from synthetic integer cost inputs without floating point", () => {
    expect(
      calculateGenerationMargin({
        revenueKobo: 180000n,
        providerCreditsMilli: 2000n,
        providerUnitCostMicrousd: 75000n,
        ngnPerUsdMicros: 1600000000n,
      }),
    ).toEqual({ revenueKobo: 180000n, providerCostKobo: 24000n, grossMarginKobo: 156000n });
  });
  it("rounds fractional subunits up conservatively", () => {
    expect(
      calculateGenerationMargin({
        revenueKobo: 100n,
        providerCreditsMilli: 1n,
        providerUnitCostMicrousd: 1n,
        ngnPerUsdMicros: 1n,
      }).providerCostKobo,
    ).toBe(1n);
  });
});

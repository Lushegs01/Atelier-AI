/** Monetary inputs are integers. Null cost means unknown, never a zero-cost generation. */
export function calculateGenerationMargin(input: {
  revenueKobo: bigint;
  providerCreditsMilli: bigint;
  providerUnitCostMicrousd: bigint | null;
  ngnPerUsdMicros: bigint | null;
}) {
  if (input.revenueKobo < 0n || input.providerCreditsMilli < 0n)
    throw new Error("Negative revenue or provider usage.");
  if (input.providerUnitCostMicrousd === null || input.ngnPerUsdMicros === null)
    return { revenueKobo: input.revenueKobo, providerCostKobo: null, grossMarginKobo: null };
  if (input.providerUnitCostMicrousd < 0n || input.ngnPerUsdMicros <= 0n)
    throw new Error("Invalid unit cost or exchange rate.");
  const providerCostMicrousd =
    (input.providerCreditsMilli * input.providerUnitCostMicrousd + 999n) / 1000n;
  // micro USD * micro NGN/USD * 100 kobo/NGN / 10^12, rounded up.
  const providerCostKobo =
    (providerCostMicrousd * input.ngnPerUsdMicros + 9_999_999_999n) / 10_000_000_000n;
  return {
    revenueKobo: input.revenueKobo,
    providerCostKobo,
    grossMarginKobo: input.revenueKobo - providerCostKobo,
  };
}

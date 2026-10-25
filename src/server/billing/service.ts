import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";
import { aiProviderCredential, getServerEnv } from "@/lib/env";
import { getProviderCapabilities } from "@/server/ai/provider";
import {
  BillingError,
  normalizeGenerationOptions,
  pricingOptionKey,
  operationSchema,
  safeBillingDatabaseError,
  validateVerifiedPayment,
  verifyPaystackSignature,
  type Operation,
} from "./domain";
import { PaystackProvider } from "./paystack";

export interface GenerationRequest {
  organizationId: string;
  actorId: string | null;
  operation: Operation;
  garmentId?: string;
  sourceAssetId?: string;
  inputAssetIds?: string[];
  options?: Record<string, unknown>;
  idempotencyKey: string;
  tryOnSessionId?: string;
  expectedCredits?: number;
  expectedPriceRuleId?: string;
}

function assertOperationEnabled(operation: Operation) {
  const env = getServerEnv();
  const enabled =
    operation === "photo"
      ? env.ENABLE_PHOTO_GENERATION
      : operation === "video"
        ? env.ENABLE_VIDEO_GENERATION
        : env.ENABLE_TRY_ON;
  if (!enabled || !env[aiProviderCredential(env.AI_PROVIDER)])
    throw new BillingError(
      503,
      "This generation capability is not enabled.",
      "GENERATION_DISABLED",
    );
}

export async function quoteGeneration(input: {
  organizationId: string;
  operation: Operation;
  options?: Record<string, unknown>;
}) {
  const operation = operationSchema.parse(input.operation);
  assertOperationEnabled(operation);
  const options = normalizeGenerationOptions(operation, input.options);
  const optionKey = pricingOptionKey(operation, input.options);
  const db = getAdminClient();
  const { data: rule, error } = await db
    .from("generation_price_rules")
    .select("*")
    .eq("operation", operation)
    .eq("option_key", optionKey)
    .eq("enabled", true)
    .not("reviewed_at", "is", null)
    .single();
  if (error || !rule)
    throw new BillingError(
      503,
      "Pricing is awaiting review. This operation is unavailable.",
      "PRICING_DISABLED",
    );
  const { data: account, error: balanceError } = await db
    .from("credit_accounts")
    .select("available,reserved")
    .eq("organization_id", input.organizationId)
    .single();
  if (balanceError || !account) throw new Error("Credit account unavailable.");
  return {
    credits: rule.credits as number,
    available: account.available as number,
    reserved: account.reserved as number,
    sufficient: account.available >= rule.credits,
    operation,
    options,
    optionKey,
    priceRuleId: rule.id as string,
    providerCreditsMilli: rule.provider_credits_milli as number,
    estimatedProviderCostMicrousd: rule.estimated_provider_cost_microusd as number | null,
    lifecycle: (
      getProviderCapabilities().find((item) => item.operation === operation)?.lifecycle ??
      "Experimental"
    ).toLowerCase(),
  };
}

export async function reserveGeneration(input: GenerationRequest) {
  const operation = operationSchema.parse(input.operation);
  assertOperationEnabled(operation);
  const options = normalizeGenerationOptions(operation, input.options);
  const db = getAdminClient();
  const { data, error } = await db.rpc("reserve_generation", {
    p_organization_id: input.organizationId,
    p_actor_id: input.actorId,
    p_operation: operation,
    p_garment_id: input.garmentId ?? null,
    p_source_asset_id: input.sourceAssetId ?? null,
    p_input_asset_ids: input.inputAssetIds ?? [],
    p_options: options,
    p_idempotency_key: input.idempotencyKey,
    p_option_key: pricingOptionKey(operation, input.options),
    p_try_on_session_id: input.tryOnSessionId ?? null,
    p_expected_credits: input.expectedCredits ?? null,
    p_expected_price_rule_id: input.expectedPriceRuleId ?? null,
  });
  if (error) throw safeBillingDatabaseError(error.message);
  return data;
}

/** Outputs must already be copied to private storage and recorded before success. */
export async function settleGeneration(
  jobId: string,
  success: boolean,
  errorCode?: string,
  errorMessage?: string,
) {
  const { data, error } = await getAdminClient().rpc("finalize_generation", {
    p_job_id: jobId,
    p_success: success,
    p_error_code: errorCode ?? null,
    p_error_message: errorMessage?.slice(0, 500) ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}

function paystack() {
  const env = getServerEnv();
  if (!env.PAYSTACK_SECRET_KEY)
    throw new BillingError(503, "Payment provider is not configured.", "PAYMENTS_UNAVAILABLE");
  return new PaystackProvider(env.PAYSTACK_SECRET_KEY, env.ALLOW_LIVE_PAYMENTS);
}

export async function initializePayment(input: {
  organizationId: string;
  actorId: string;
  email: string;
  packageId: string;
}) {
  const provider = paystack();
  const db = getAdminClient();
  const { data: membership } = await db
    .from("organization_members")
    .select("role")
    .eq("organization_id", input.organizationId)
    .eq("user_id", input.actorId)
    .single();
  if (!membership || !["owner", "admin"].includes(membership.role))
    throw new BillingError(
      403,
      "Only a workspace owner or admin can purchase credits.",
      "BILLING_FORBIDDEN",
    );
  const { data: pack, error } = await db
    .from("credit_packages")
    .select("*")
    .eq("id", input.packageId)
    .eq("enabled", true)
    .single();
  if (error || !pack)
    throw new BillingError(503, "Credit package is unavailable.", "PACKAGE_DISABLED");
  const reference = `atelier-${randomUUID()}`;
  const { error: insertError } = await db.from("payment_transactions").insert({
    organization_id: input.organizationId,
    package_id: pack.id,
    reference,
    amount_kobo: pack.amount_kobo,
    credits: pack.credits,
    currency: pack.currency,
    expected_domain: provider.domain,
    buyer_email: input.email,
    created_by: input.actorId,
  });
  if (insertError) throw new Error("Could not record payment intent.");
  // An initialization timeout leaves a pending transaction to reconcile; never grant value here.
  const result = await provider.initialize({
    email: input.email,
    amount: pack.amount_kobo,
    currency: pack.currency,
    reference,
    callbackUrl: new URL("/app/billing", getServerEnv().NEXT_PUBLIC_APP_URL).toString(),
    organizationId: input.organizationId,
  });
  const { error: updateError } = await db
    .from("payment_transactions")
    .update({
      status: "initialized",
      authorization_url: result.authorizationUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("reference", reference)
    .eq("status", "pending");
  if (updateError)
    throw new Error("Payment checkout could not be recorded. Contact support with your reference.");
  return result;
}

export async function verifyPayment(reference: string) {
  const db = getAdminClient();
  const { data: expected, error } = await db
    .from("payment_transactions")
    .select("*")
    .eq("reference", reference)
    .single();
  if (error || !expected) throw new Error("Payment not found.");
  const verified = validateVerifiedPayment(expected, await paystack().verify(reference));
  const { data, error: settlementError } = await db.rpc("settle_payment", {
    p_reference: reference,
    p_amount_kobo: verified.amount,
    p_currency: verified.currency,
    p_domain: verified.domain,
    p_buyer_email: verified.customer.email,
    p_provider_transaction_id: String(verified.id),
    p_receipt_number: verified.receipt_number ?? null,
  });
  if (settlementError) throw new Error(settlementError.message);
  return { status: "success" as const, reference, credits: data.credits as number };
}

export async function handlePaystackWebhook(rawBody: string, signature: string | null) {
  const env = getServerEnv();
  if (
    !env.PAYSTACK_SECRET_KEY ||
    !verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY)
  ) {
    throw new Error("Invalid webhook signature.");
  }
  const event = JSON.parse(rawBody) as { event?: unknown; data?: { reference?: unknown } };
  if (typeof event.event !== "string") throw new Error("Invalid webhook payload.");
  const eventKey = createHash("sha256").update(rawBody).digest("hex");
  const db = getAdminClient();
  const { data: existing } = await db
    .from("webhook_events")
    .select("processed_at")
    .eq("provider", "paystack")
    .eq("event_key", eventKey)
    .maybeSingle();
  if (existing?.processed_at) return { accepted: true, duplicate: true };
  const reference = typeof event.data?.reference === "string" ? event.data.reference : null;
  const { error: recordError } = await db
    .from("webhook_events")
    .upsert(
      { provider: "paystack", event_key: eventKey, event_type: event.event, reference },
      { onConflict: "provider,event_key", ignoreDuplicates: true },
    );
  if (recordError) throw new Error("Could not durably record payment event.");
  if (event.event === "charge.success") {
    if (!reference) throw new Error("Payment reference missing.");
    await verifyPayment(reference);
  }
  // Reversals/refunds are visible in the audit queue and need a controlled compensating entry.
  if (["charge.dispute.create", "refund.processed"].includes(event.event)) {
    const { error: auditError } = await db.from("audit_logs").insert({
      action: `paystack.${event.event}`,
      target_type: "payment",
      target_id: reference,
      metadata: { eventKey, needsReconciliation: true },
    });
    if (auditError) throw new Error("Could not record reconciliation alert.");
  }
  const { error: processedError } = await db
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("provider", "paystack")
    .eq("event_key", eventKey);
  if (processedError) throw new Error("Could not acknowledge payment event.");
  return { accepted: true, duplicate: false };
}

export async function reconcilePendingPayments(limit = 25) {
  const { data, error } = await getAdminClient()
    .from("payment_transactions")
    .select("reference")
    .in("status", ["pending", "initialized"])
    .order("created_at")
    .limit(Math.min(limit, 100));
  if (error) throw new Error("Could not load pending payments.");
  const outcomes = await Promise.allSettled(
    (data ?? []).map((payment) => verifyPayment(payment.reference)),
  );
  return {
    checked: outcomes.length,
    settled: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
  };
}

export async function requestPaymentRefund(input: {
  adminId: string;
  reference: string;
  reason: string;
  idempotencyKey: string;
}) {
  const provider = paystack();
  const db = getAdminClient();
  const { data: intendedPayment } = await db
    .from("payment_transactions")
    .select("expected_domain")
    .eq("reference", input.reference)
    .single();
  if (!intendedPayment || intendedPayment.expected_domain !== provider.domain)
    throw new BillingError(
      409,
      "The configured payment environment does not match this transaction.",
      "PAYMENT_ENVIRONMENT_MISMATCH",
    );
  const { data: prepared, error } = await db.rpc("prepare_payment_refund", {
    p_admin_id: input.adminId,
    p_reference: input.reference,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error)
    throw new BillingError(
      409,
      "The refund could not be prepared. Verify the payment, administrator permission and unspent package credits.",
      "REFUND_UNAVAILABLE",
    );
  if (!prepared.should_submit)
    return {
      status: prepared.payment.status as string,
      reference: input.reference,
      submitted: false,
    };
  // No automatic retries: acceptance may have happened if this call times out.
  const refund = await provider.createRefund({
    reference: input.reference,
    amount: prepared.payment.amount_kobo,
    currency: prepared.payment.currency,
    reason: input.reason,
  });
  if (
    refund.amount !== prepared.payment.amount_kobo ||
    refund.currency !== prepared.payment.currency ||
    refund.domain !== prepared.payment.expected_domain
  )
    throw new Error("Refund provider response mismatch; reconciliation required.");
  const { error: saveError } = await db
    .from("payment_transactions")
    .update({ refund_provider_id: String(refund.id), updated_at: new Date().toISOString() })
    .eq("reference", input.reference)
    .eq("status", "refund_pending");
  if (saveError)
    throw new Error("Refund identifier could not be saved; reconcile before retrying.");
  return { status: "refund_pending", reference: input.reference, submitted: true };
}

/** A candidate provider id can recover a lost response, but must match verified original payment data. */
export async function reconcilePaymentRefund(reference: string, providerRefundId?: string) {
  const db = getAdminClient();
  const { data: expected, error } = await db
    .from("payment_transactions")
    .select("*")
    .eq("reference", reference)
    .in("status", ["refund_pending", "refunded"])
    .single();
  if (error || !expected)
    throw new BillingError(404, "No refund is pending for this payment.", "REFUND_NOT_FOUND");
  const refundId = expected.refund_provider_id ?? providerRefundId;
  if (!refundId)
    throw new BillingError(
      409,
      "Find the accepted refund in Paystack before reconciliation. Do not submit another refund.",
      "REFUND_REQUIRES_RECONCILIATION",
    );
  const refund = await paystack().fetchRefund(refundId);
  const transactionId =
    typeof refund.transaction === "object"
      ? String(refund.transaction.id)
      : String(refund.transaction);
  if (
    transactionId !== expected.provider_transaction_id ||
    refund.amount !== expected.amount_kobo ||
    refund.currency !== expected.currency ||
    refund.domain !== expected.expected_domain ||
    String(refund.id) !== String(refundId)
  ) {
    throw new Error("Refund verification mismatch.");
  }
  if (refund.status !== "processed")
    return { status: "refund_pending", providerStatus: refund.status, reference };
  const { error: settleError } = await db.rpc("finalize_payment_refund", {
    p_reference: reference,
    p_provider_refund_id: String(refund.id),
    p_amount_kobo: refund.amount,
    p_currency: refund.currency,
    p_domain: refund.domain,
  });
  if (settleError) throw new Error("Could not record verified refund.");
  return { status: "refunded", providerStatus: refund.status, reference };
}

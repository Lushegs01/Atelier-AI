import "server-only";
import { captureMessage } from "@sentry/nextjs";
import { NonRetriableError, RetryAfterError } from "inngest";
import { getAdminClient } from "@/lib/supabase/admin";
import {
  createProviderForJob,
  assertCapabilityEnabled,
  getProviderCapabilities,
  type ProviderId,
} from "@/server/ai/registry";
import {
  GenerationOperation,
  type Prediction,
  ProviderError,
  imageOptionsSchema,
  tryOnOptionsSchema,
  videoOptionsSchema,
} from "@/server/ai/contracts";
import {
  HF_FIRST_READ_DELAY_SECONDS,
  HF_PROCESSING_DISCLOSURE_VERSION,
  huggingFacePredictionId,
} from "@/server/ai/huggingface";
import {
  deletePrivateAsset,
  deterministicOutputId,
  downloadAssetForProvider,
  transferProviderOutput,
} from "@/server/storage/media";
import { MediaValidationError, ProviderOutputGoneError } from "@/server/storage/validation";
import { huggingFaceQuotaCooldownActive } from "@/server/services/provider-health";
import {
  inngest,
  generationRequested,
  generationRecoveryRequested,
  dispatchGenerationRecovery,
} from "./client";
import { retryDelaySeconds, submissionDecision } from "./policy";

interface Job {
  id: string;
  organization_id: string;
  status: string;
  operation: GenerationOperation;
  provider: ProviderId;
  provider_model: string;
  garment_id: string | null;
  source_asset_id: string | null;
  input_asset_ids: string[];
  options: Record<string, unknown>;
  provider_reference: string | null;
  retry_count: number;
  created_by: string | null;
  error_code: string | null;
  lease_until: string | null;
}

async function loadJob(id: string, organizationId?: string): Promise<Job> {
  let query = getAdminClient().from("generation_jobs").select("*").eq("id", id);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query.single();
  if (error || !data) throw new NonRetriableError("Generation job not found.");
  return data as Job;
}

async function updateJob(id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await getAdminClient()
    .from("generation_jobs")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", id)
    .not("status", "in", "(succeeded,failed,cancelled)");
  if (error) throw new Error("Generation state could not be persisted.");
}

async function finishJob(
  id: string,
  success: boolean,
  code?: string,
  detail?: string,
): Promise<string> {
  const { data, error } = await getAdminClient().rpc("finalize_generation", {
    p_job_id: id,
    p_success: success,
    p_error_code: code ?? null,
    p_error_message: code
      ? `Generation could not complete. Your reserved credits have been released.${detail ? ` Provider reported: ${detail}` : ""}`
      : null,
  });
  if (error) throw new Error("Generation accounting could not be reconciled.");
  // A finished job no longer needs the provider's temporary output location. Best effort only:
  // the row is service-only and accounting is already final.
  try {
    await getAdminClient().from("generation_provider_results").delete().eq("job_id", id);
  } catch {
    // Ignored; a leftover row grants no access and is never read for a terminal job.
  }
  return String(data.status);
}

/** A completed Space result is persisted so a failed copy never needs another inference. */
async function loadProviderResult(job: Job): Promise<string | null> {
  const { data, error } = await getAdminClient()
    .from("generation_provider_results")
    .select("output_url")
    .eq("job_id", job.id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  if (error) throw new Error("The provider result could not be loaded.");
  return typeof data?.output_url === "string" ? data.output_url : null;
}

async function saveProviderResult(job: Job, url: string): Promise<void> {
  const { error } = await getAdminClient().from("generation_provider_results").upsert(
    {
      job_id: job.id,
      organization_id: job.organization_id,
      output_url: url,
    },
    { onConflict: "job_id", ignoreDuplicates: true },
  );
  if (error) throw new Error("The provider result could not be recorded.");
}

async function checkTryOnConsent(job: Job): Promise<void> {
  if (job.operation !== "try_on") return;
  const sessionId = job.options.tryOnSessionId;
  if (typeof sessionId !== "string") throw new NonRetriableError("Try-on consent session missing.");
  const admin = getAdminClient();
  const { data: session } = await admin
    .from("try_on_sessions")
    .select("id,revoked_at,deleted_at,expires_at,customer_asset_id,job_id")
    .eq("id", sessionId)
    .eq("organization_id", job.organization_id)
    .single();
  if (
    !session ||
    session.revoked_at ||
    session.deleted_at ||
    new Date(session.expires_at).getTime() <= Date.now() ||
    session.job_id !== job.id ||
    session.customer_asset_id !== job.source_asset_id
  )
    throw new NonRetriableError("Try-on permission was revoked.");
  const { data: consent } = await admin
    .from("consents")
    .select("id")
    .eq("try_on_session_id", sessionId)
    .eq("organization_id", job.organization_id)
    .is("withdrawn_at", null)
    .limit(1)
    .maybeSingle();
  if (!consent) throw new NonRetriableError("Try-on consent was withdrawn.");
}

async function resolveGarmentSource(job: Job): Promise<string> {
  if (!job.garment_id) throw new NonRetriableError("A garment is required.");
  let query = getAdminClient()
    .from("assets")
    .select("id,view")
    .eq("organization_id", job.organization_id)
    .eq("garment_id", job.garment_id)
    .in("kind", ["original", "garment_original"])
    .is("deleted_at", null)
    .in("view", ["front", "mannequin", "hanger", "flat-lay"]);
  if (job.operation === "photo" && job.source_asset_id) query = query.eq("id", job.source_asset_id);
  if (job.provider === "qwen")
    query = query
      .gte("width", 256)
      .gte("height", 256)
      .lte("byte_size", 4 * 1024 * 1024);
  const { data: asset } = await query.order("created_at").limit(1).maybeSingle();
  if (!asset)
    throw new NonRetriableError(
      "Upload a compatible front, mannequin, hanger or flat-lay garment photograph.",
    );
  return downloadAssetForProvider({
    organizationId: job.organization_id,
    assetId: asset.id,
    minDimension:
      getProviderCapabilities(job.provider).find(
        (capability) => capability.operation === job.operation,
      )?.minInputDimension ?? 15,
  });
}

async function garmentCategory(job: Job): Promise<string | undefined> {
  const { data } = await getAdminClient()
    .from("garments")
    .select("category")
    .eq("organization_id", job.organization_id)
    .eq("id", job.garment_id)
    .maybeSingle();
  return typeof data?.category === "string" ? data.category : undefined;
}

export async function submitGenerationOnce(
  jobId: string,
  organizationId: string,
): Promise<{
  id: string | null;
  terminal?: boolean;
  waiting?: boolean;
  pollAfterSeconds?: number;
}> {
  const job = await loadJob(jobId, organizationId);
  const decision = submissionDecision(job);
  if (decision === "terminal") return { id: job.provider_reference, terminal: true };
  if (decision === "resume") return { id: job.provider_reference };
  if (decision === "reconcile") {
    if (job.provider === "qwen") {
      await checkTryOnConsent(job);
      try {
        // Qwen's durable service uses this application UUID as its idempotent prediction id.
        // A worker can recover acceptance without guessing or sending another inference request.
        await createProviderForJob(job).getGenerationStatus(job.id);
        return { id: job.id };
      } catch (error) {
        if (error instanceof ProviderError && error.code === "qwen_job_not_found") {
          await updateJob(job.id, {
            status: "retry_wait",
            error_code: null,
            error_message: null,
            lease_until: null,
          });
        } else {
          await updateJob(job.id, {
            status: "retry_wait",
            error_code: "submission_ambiguous",
            lease_until: null,
          });
          throw new RetryAfterError(
            "The private service receipt is being recovered. No new inference was submitted.",
            "30s",
          );
        }
      }
    } else if (job.provider === "huggingface") {
      // Hugging Face receipts are recorded before the POST, so a job without one never reached
      // the Space and can be claimed again without duplicating inference.
      await updateJob(job.id, {
        status: "retry_wait",
        error_code: null,
        error_message: null,
        lease_until: null,
      });
    } else {
      await updateJob(job.id, {
        status: "retry_wait",
        error_code: "submission_ambiguous",
        error_message:
          "The provider submission needs operator reconciliation. A second paid request has not been submitted.",
        lease_until: null,
      });
      throw new NonRetriableError("Provider submission requires reconciliation.");
    }
  }
  if (decision === "wait") return { id: null, waiting: true };
  assertCapabilityEnabled(job.operation, job.provider);
  await checkTryOnConsent(job);
  if (job.provider === "huggingface") {
    if (job.created_by && job.options.processingDisclosure !== HF_PROCESSING_DISCLOSURE_VERSION) {
      await finishJob(job.id, false, "processing_acknowledgement_missing");
      throw new NonRetriableError("Third-party processing was not acknowledged.");
    }
    // Every job shares one token's daily GPU quota; do not send work that cannot run. A distinct
    // code keeps these local refusals from extending the cooldown, which counts Space refusals only.
    if (await huggingFaceQuotaCooldownActive()) {
      await finishJob(job.id, false, "provider_quota_cooldown");
      throw new NonRetriableError("The free provider quota is exhausted; credits were released.");
    }
  }
  const admin = getAdminClient();
  // A persistent rolling circuit breaker avoids a provider outage draining queued work.
  const { count, error: circuitError } = await admin
    .from("generation_jobs")
    .select("id", { count: "exact", head: true })
    .like(
      "error_code",
      job.provider === "qwen"
        ? "qwen_http_5%"
        : job.provider === "huggingface"
          ? "provider_unavailable"
          : "provider_http_5%",
    )
    .eq("provider", job.provider)
    .gte("updated_at", new Date(Date.now() - 120_000).toISOString());
  if (circuitError) throw new Error("Provider health could not be checked.");
  if ((count ?? 0) >= 5) throw new RetryAfterError("Provider circuit is cooling down.", "2m");
  const { data: claimed, error: claimError } = await admin.rpc("claim_generation", {
    p_job_id: job.id,
    p_lease_seconds: 90,
  });
  if (claimError) throw new Error("The generation could not be claimed.");
  if (!claimed || !Array.isArray(claimed) || !claimed.length) return { id: null, waiting: true };
  const receipt =
    job.provider === "huggingface"
      ? huggingFacePredictionId(job.operation, job.id, job.retry_count)
      : null;
  const accepted = (result: { id: string }) =>
    receipt
      ? { id: receipt, pollAfterSeconds: HF_FIRST_READ_DELAY_SECONDS[job.operation] }
      : result;
  const context = { requestId: job.id, ...(receipt ? { attempt: job.retry_count } : {}) };
  try {
    const provider = createProviderForJob(job);
    if (job.operation === "photo") {
      const source = await resolveGarmentSource(job);
      // The deterministic receipt is durable before the request leaves, so any outcome can be read.
      if (receipt) await updateJob(job.id, { provider_reference: receipt });
      return accepted(
        await provider.generateFashionImage(source, imageOptionsSchema.parse(job.options), context),
      );
    }
    if (job.operation === "video") {
      if (!job.source_asset_id) throw new NonRetriableError("Select an image to animate.");
      const capability = getProviderCapabilities(job.provider).find(
        (item) => item.operation === "video",
      );
      const source = await downloadAssetForProvider({
        organizationId: job.organization_id,
        assetId: job.source_asset_id,
        minDimension: capability?.minInputDimension ?? 301,
        minAspectRatio: capability?.minAspectRatio,
        maxAspectRatio: capability?.maxAspectRatio,
      });
      if (receipt) await updateJob(job.id, { provider_reference: receipt });
      return accepted(
        await provider.generateFashionVideo(source, videoOptionsSchema.parse(job.options), context),
      );
    }
    if (!job.source_asset_id)
      throw new NonRetriableError("A consented customer photograph is required.");
    const product = await resolveGarmentSource(job);
    const capability = getProviderCapabilities(job.provider).find(
      (item) => item.operation === "try_on",
    );
    const person = await downloadAssetForProvider({
      organizationId: job.organization_id,
      assetId: job.source_asset_id,
      minAspectRatio: capability?.minAspectRatio,
      maxAspectRatio: capability?.maxAspectRatio,
    });
    const category = job.provider === "huggingface" ? await garmentCategory(job) : undefined;
    if (receipt) await updateJob(job.id, { provider_reference: receipt });
    return accepted(
      await provider.generateVirtualTryOn(product, person, tryOnOptionsSchema.parse(job.options), {
        ...context,
        ...(job.provider === "huggingface" ? { garmentCategory: category } : {}),
      }),
    );
  } catch (error) {
    if (receipt) {
      // An unconfirmed POST is reconciled by reading the receipt; it is never sent again.
      if (error instanceof ProviderError && error.ambiguous) return accepted({ id: receipt });
      // Anything else was rejected before acceptance, so the unused receipt is withdrawn.
      await updateJob(job.id, { provider_reference: null });
    }
    if (error instanceof ProviderError && error.ambiguous) {
      await updateJob(job.id, {
        status: "retry_wait",
        error_code: "submission_ambiguous",
        error_message: error.message,
        lease_until: null,
      });
      throw new NonRetriableError(error.message);
    }
    if (error instanceof ProviderError && error.retryable && job.retry_count < 3) {
      await updateJob(job.id, {
        status: "retry_wait",
        error_code: error.code,
        retry_count: job.retry_count + 1,
        lease_until: null,
      });
      throw new RetryAfterError(
        "Provider temporarily rejected the request.",
        `${retryDelaySeconds(job.retry_count)}s`,
      );
    }
    if (job.provider === "qwen" && error instanceof ProviderError && error.retryable) {
      try {
        await createProviderForJob(job).getGenerationStatus(job.id);
        return { id: job.id };
      } catch (receiptError) {
        if (!(
          receiptError instanceof ProviderError && receiptError.code === "qwen_job_not_found"
        )) {
          await updateJob(job.id, {
            status: "retry_wait",
            error_code: "submission_ambiguous",
            lease_until: null,
          });
          throw new NonRetriableError(
            "The private service receipt needs recovery. Credits remain reserved until acceptance is known.",
          );
        }
      }
    }
    await finishJob(
      job.id,
      false,
      error instanceof ProviderError ? error.code : "invalid_generation_input",
    );
    throw new NonRetriableError("Generation submission failed; reserved credits were released.");
  }
}

export async function pollGenerationAndTransfer(
  jobId: string,
  reference: string,
): Promise<{ state: string }> {
  const job = await loadJob(jobId);
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return { state: job.status };
  await checkTryOnConsent(job);
  const persisted = job.provider === "huggingface" ? await loadProviderResult(job) : null;
  const prediction: Prediction = persisted
    ? { id: reference, status: "completed", outputs: [persisted] }
    : await createProviderForJob(job).getGenerationStatus(reference);
  if (job.provider === "huggingface" && !persisted && prediction.status === "completed")
    for (const url of prediction.outputs.slice(0, 1)) await saveProviderResult(job, url);
  if (prediction.creditsUsed !== undefined)
    await updateJob(job.id, { provider_credits_milli: prediction.creditsUsed * 1000 });
  if (prediction.status === "failed") {
    const state = await finishJob(
      job.id,
      false,
      prediction.errorCode ?? "provider_failed",
      prediction.errorDetail,
    );
    return { state };
  }
  if (prediction.status !== "completed") {
    if (job.status === "retry_wait")
      await updateJob(job.id, { status: "processing", error_code: null, error_message: null });
    return { state: "processing" };
  }
  if (prediction.outputs.length !== 1) throw new Error("Unexpected provider output count.");
  for (const [index, url] of prediction.outputs.entries()) {
    let asset: Awaited<ReturnType<typeof transferProviderOutput>>;
    try {
      asset = await transferProviderOutput({
        organizationId: job.organization_id,
        jobId: job.id,
        index,
        url,
        provider: job.provider,
        providerReference: reference,
        isVideo: job.operation === "video",
        garmentId: job.garment_id ?? undefined,
        actorId: job.created_by,
        expiresAt:
          job.operation === "try_on"
            ? new Date(
                Date.now() + (Number(process.env.CUSTOMER_PHOTO_RETENTION_HOURS) || 24) * 3_600_000,
              ).toISOString()
            : undefined,
      });
    } catch (error) {
      // Untrusted, expired, oversized or unplayable media is final; it can never become a success.
      if (error instanceof MediaValidationError) {
        const state = await finishJob(
          job.id,
          false,
          error instanceof ProviderOutputGoneError
            ? "provider_output_expired"
            : "provider_invalid_output",
        );
        return { state };
      }
      throw error;
    }
    const { error } = await getAdminClient()
      .from("generation_outputs")
      .upsert(
        {
          id: deterministicOutputId(job.id, index, "output"),
          organization_id: job.organization_id,
          job_id: job.id,
          asset_id: asset.id,
          output_index: index,
        },
        { onConflict: "job_id,output_index", ignoreDuplicates: true },
      );
    if (error) throw new Error("Generation output could not be recorded.");
    if (job.operation === "try_on") {
      try {
        await checkTryOnConsent(job);
      } catch {
        await deletePrivateAsset({ organizationId: job.organization_id, assetId: asset.id });
        const state = await finishJob(job.id, false, "consent_withdrawn");
        return { state };
      }
      const { error: expiryError } = await getAdminClient()
        .from("assets")
        .update({
          expires_at: new Date(
            Date.now() + (Number(process.env.CUSTOMER_PHOTO_RETENTION_HOURS) || 24) * 3_600_000,
          ).toISOString(),
        })
        .eq("id", asset.id)
        .eq("organization_id", job.organization_id);
      if (expiryError) throw new Error("Try-on retention could not be applied.");
    }
  }
  const state = await finishJob(job.id, true);
  return { state };
}

export async function recordAcceptedPrediction(jobId: string, reference: string): Promise<void> {
  await updateJob(jobId, {
    provider_reference: reference,
    status: "processing",
    error_code: null,
    error_message: null,
    lease_until: null,
  });
}

export async function reconcileExhaustedGeneration(
  jobId: string,
): Promise<"terminal" | "manual" | "failed" | "recovered"> {
  const job = await loadJob(jobId);
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return "terminal";
  const recoverAcceptedPrediction = async (reference: string): Promise<"manual" | "recovered"> => {
    // Persist the receipt and the recovery intent together. A queue outage or a process crash
    // after this write must leave a row that maintenance can enqueue without another POST.
    await updateJob(job.id, {
      provider_reference: reference,
      status: "retry_wait",
      error_code: "recovery_dispatch_pending",
      error_message: "The accepted provider result is waiting for recovery.",
      lease_until: null,
    });
    try {
      await dispatchGenerationRecovery(job.id, job.organization_id);
      // The recovery poll clears the marker when it makes progress. Keeping it until then
      // also covers successful queue delivery followed by a lost worker invocation.
      return "recovered";
    } catch {
      captureMessage("Known prediction recovery dispatch requires retry", {
        level: "error",
        tags: { component: "generation-recovery" },
        extra: { jobId: job.id },
      });
      return "manual";
    }
  };
  if (
    job.provider_reference &&
    (job.provider === "qwen" ||
      job.provider === "huggingface" ||
      job.error_code === "recovery_dispatch_pending")
  )
    return recoverAcceptedPrediction(job.provider_reference);
  if (job.provider === "huggingface" && !job.provider_reference) {
    // Receipts are recorded before the POST, so this job never reached the Space.
    await finishJob(job.id, false, "provider_not_submitted");
    return "failed";
  }
  if (
    job.provider === "qwen" &&
    !job.provider_reference &&
    (job.status === "submitting" || job.error_code === "submission_ambiguous")
  ) {
    let receiptAccepted = false;
    try {
      await createProviderForJob(job).getGenerationStatus(job.id);
      receiptAccepted = true;
    } catch (error) {
      if (error instanceof ProviderError && error.code === "qwen_job_not_found") {
        await finishJob(job.id, false, "qwen_not_accepted");
        return "failed";
      }
      // An unavailable service cannot prove rejection; retain the reservation for recovery.
    }
    // Keep persistence and queue errors outside the receipt lookup catch. Neither is evidence
    // that the service rejected this generation, even if the loaded row has no reference yet.
    if (receiptAccepted) return recoverAcceptedPrediction(job.id);
  }
  if (
    !job.provider_reference &&
    (job.status === "submitting" || job.error_code === "submission_ambiguous")
  ) {
    await updateJob(job.id, {
      status: "retry_wait",
      error_code: "submission_ambiguous",
      error_message: "Operator reconciliation is required before resubmission or release.",
      lease_until: null,
    });
    captureMessage("Generation submission requires reconciliation", {
      level: "error",
      tags: { component: "generation" },
      extra: { jobId: job.id },
    });
    return "manual";
  }
  await finishJob(
    job.id,
    false,
    job.provider_reference ? "output_transfer_exhausted" : "generation_exhausted",
  );
  return "failed";
}

export const generateFashionContent = inngest.createFunction(
  {
    id: "generate-fashion-content",
    triggers: generationRequested,
    concurrency: [{ limit: 3 }, { limit: 1, key: "event.data.organizationId" }],
    idempotency: "event.data.jobId",
    retries: 3,
    onFailure: async ({ event, logger }) => {
      const original = event.data.event.data as { jobId?: string };
      if (!original.jobId) return;
      const state = await reconcileExhaustedGeneration(original.jobId);
      if (state === "recovered") {
        logger.info("generation.receipt_recovered", { jobId: original.jobId });
        return;
      }
      if (state !== "terminal")
        logger.error(
          state === "manual" ? "generation.reconciliation_required" : "generation.failed",
          { jobId: original.jobId },
        );
    },
  },
  async ({ event, step }) => {
    const { jobId, organizationId } = event.data;
    let submitted = await step.run("submit-once", () =>
      submitGenerationOnce(jobId, organizationId),
    );
    // Durable capacity waits do not spend retry attempts or accept more paid predictions.
    for (let capacityWait = 0; submitted.waiting && capacityWait < 120; capacityWait++) {
      await step.sleep(`capacity-wait-${capacityWait}`, "30s");
      submitted = await step.run(`capacity-claim-${capacityWait}`, () =>
        submitGenerationOnce(jobId, organizationId),
      );
    }
    if (submitted.waiting) {
      await step.run("release-capacity-timeout", () =>
        finishJob(jobId, false, "provider_capacity_timeout"),
      );
      return { jobId, state: "failed" };
    }
    if (submitted.terminal) return { jobId, state: "already_finished" };
    if (!submitted.id) throw new NonRetriableError("Provider prediction identifier missing.");
    await step.run("persist-prediction", async () => {
      await recordAcceptedPrediction(jobId, submitted.id!);
      return { persisted: true };
    });
    // Durable sleeps do not occupy a Vercel invocation. Status + transfer step returns only safe ids/state.
    for (let poll = 0; poll < 100; poll++) {
      await step.sleep(
        `wait-${poll}`,
        poll === 0 && submitted.pollAfterSeconds
          ? `${submitted.pollAfterSeconds}s`
          : poll < 4
            ? "15s"
            : "30s",
      );
      const result = await step.run(`poll-and-transfer-${poll}`, async () => {
        try {
          return await pollGenerationAndTransfer(jobId, submitted.id!);
        } catch (error) {
          const current = await loadJob(jobId);
          await updateJob(jobId, {
            status: "retry_wait",
            retry_count: current.retry_count + 1,
            error_code: error instanceof ProviderError ? error.code : "transfer_retry",
            error_message:
              "The provider result is being recovered. No new generation was submitted.",
          });
          throw error;
        }
      });
      if (result.state !== "processing") return { jobId, state: result.state };
    }
    await step.run("release-timeout", () => finishJob(jobId, false, "provider_timeout"));
    return { jobId, state: "failed" };
  },
);

/** A separate event bypasses initial-submission dedupe without ever calling the paid POST endpoint. */
export const recoverKnownPrediction = inngest.createFunction(
  {
    id: "recover-known-fashion-prediction",
    triggers: generationRecoveryRequested,
    singleton: { key: "event.data.jobId", mode: "skip" },
    concurrency: 2,
    retries: 3,
    onFailure: async ({ event, logger }) => {
      const original = event.data.event.data as { jobId?: string };
      logger.error("generation.recovery_failed", { jobId: original.jobId });
      captureMessage("Known prediction recovery failed", {
        level: "error",
        tags: { component: "generation-recovery" },
        extra: { jobId: original.jobId },
      });
    },
  },
  async ({ event, step }) => {
    const job = await step.run("load-existing-prediction", async () => {
      const current = await loadJob(event.data.jobId, event.data.organizationId);
      if (!current.provider_reference)
        throw new NonRetriableError(
          "Recovery requires a known provider prediction. It cannot submit another request.",
        );
      return { id: current.id, reference: current.provider_reference, status: current.status };
    });
    if (["succeeded", "failed", "cancelled"].includes(job.status))
      return { jobId: job.id, state: job.status };
    for (let poll = 0; poll < 100; poll++) {
      if (poll) await step.sleep(`recovery-wait-${poll}`, "30s");
      const result = await step.run(`recover-and-transfer-${poll}`, () =>
        pollGenerationAndTransfer(job.id, job.reference),
      );
      if (result.state !== "processing") return { jobId: job.id, state: result.state };
    }
    return { jobId: job.id, state: "processing", needsOperatorAttention: true };
  },
);

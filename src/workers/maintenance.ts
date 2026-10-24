import "server-only";
import { captureMessage } from "@sentry/nextjs";
import { getAdminClient } from "@/lib/supabase/admin";
import { cleanAbandonedUploads, deletePrivateAsset } from "@/server/storage/media";
import { inngest, generationRequested } from "./client";

/** The SQL transaction writes this outbox with the reservation. A failed HTTP enqueue loses no job. */
export const dispatchOutbox = inngest.createFunction(
  { id: "dispatch-generation-outbox", triggers: { cron: "* * * * *" }, concurrency: 1, retries: 3 },
  async ({ step, logger }) => {
    const rows = await step.run("load-undelivered", async () => {
      const { data, error } = await getAdminClient()
        .from("job_outbox")
        .select("id,job_id,organization_id,attempts,created_at")
        .is("delivered_at", null)
        .lte("available_at", new Date().toISOString())
        .order("created_at")
        .limit(50);
      if (error) throw new Error("Outbox inspection failed.");
      return data ?? [];
    });
    for (const row of rows) {
      await step.sendEvent(`dispatch-${row.id}`, {
        id: `generation:${row.job_id}`,
        name: generationRequested.name,
        data: { jobId: row.job_id, organizationId: row.organization_id },
      });
      await step.run(`acknowledge-${row.id}`, async () => {
        const { error } = await getAdminClient()
          .from("job_outbox")
          .update({ delivered_at: new Date().toISOString(), attempts: row.attempts + 1 })
          .eq("id", row.id)
          .is("delivered_at", null);
        if (error) throw new Error("Outbox acknowledgement failed.");
        return true;
      });
    }
    if (rows.some((row) => Date.now() - new Date(row.created_at).getTime() > 300_000))
      logger.warn("queue.age_exceeded", { thresholdSeconds: 300 });
    return { dispatched: rows.length };
  },
);

export const recoverStuckGenerations = inngest.createFunction(
  {
    id: "recover-stuck-generations",
    triggers: { cron: "*/5 * * * *" },
    concurrency: 1,
    retries: 3,
  },
  async ({ step, logger }) => {
    const stuck = await step.run("inspect-jobs", async () => {
      const admin = getAdminClient();
      // A worker may have crashed after FASHN accepted a POST but before it persisted the id.
      // Preserve the reservation and prevent another POST; an operator reviews provider history.
      const { data, error } = await admin
        .from("generation_jobs")
        .update({
          status: "retry_wait",
          error_code: "submission_ambiguous",
          error_message:
            "Submission lease expired without a prediction id. Operator reconciliation required.",
          lease_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq("status", "submitting")
        .is("provider_reference", null)
        .lt("lease_until", new Date().toISOString())
        .select("id");
      if (error) throw new Error("Submission reconciliation check failed.");
      const { data: aged, error: agedError } = await admin
        .from("generation_jobs")
        .select("id,status,provider_reference,error_code")
        .in("status", ["queued", "processing", "retry_wait"])
        .lt("created_at", new Date(Date.now() - 3_600_000).toISOString())
        .limit(100);
      if (agedError) throw new Error("Stuck generation inspection failed.");
      return { ambiguous: data ?? [], aged: aged ?? [] };
    });
    for (const row of stuck.ambiguous) logger.error("generation.ambiguous", { jobId: row.id });
    for (const row of stuck.aged)
      logger.error("generation.stuck", {
        jobId: row.id,
        state: row.status,
        requiresReconciliation: row.error_code === "submission_ambiguous",
      });
    if (stuck.ambiguous.length || stuck.aged.length)
      captureMessage("Generation queue requires operator attention", {
        level: "error",
        tags: { component: "generation-recovery" },
        extra: {
          ambiguousJobIds: stuck.ambiguous.map((row) => row.id),
          agedJobIds: stuck.aged.map((row) => row.id),
        },
      });
    const expiredUnsubmitted = await step.run("release-expired-unsubmitted", async () => {
      const { data, error } = await getAdminClient().rpc("expire_unsubmitted_generations", {
        p_older_than: new Date(Date.now() - 24 * 3_600_000).toISOString(),
      });
      if (error) throw new Error("Unsubmitted reservation cleanup failed.");
      return Number(data ?? 0);
    });
    // Inngest persists retries for known predictions. If a run was lost for over one day,
    // refund after the documented output retrieval window is about to lapse, rather than strand credits.
    const reconciled = await step.run("release-expired-known-reservations", async () => {
      const admin = getAdminClient();
      const cutoff = new Date(Date.now() - 48 * 3_600_000).toISOString();
      const { data, error } = await admin
        .from("generation_jobs")
        .select("id")
        .in("status", ["processing", "retry_wait"])
        .not("provider_reference", "is", null)
        .lt("created_at", cutoff)
        .limit(50);
      if (error) throw new Error("Expired reservation check failed.");
      for (const job of data ?? []) {
        const { error: settledError } = await admin.rpc("finalize_generation", {
          p_job_id: job.id,
          p_success: false,
          p_error_code: "recovery_window_expired",
          p_error_message:
            "The result could not be delivered within the recovery window. Reserved credits released.",
        });
        if (settledError) throw new Error("Expired reservation reconciliation failed.");
      }
      return data?.length ?? 0;
    });
    return {
      ambiguous: stuck.ambiguous.length,
      aged: stuck.aged.length,
      reconciled,
      expiredUnsubmitted,
    };
  },
);

export const cleanPrivateMedia = inngest.createFunction(
  { id: "clean-private-media", triggers: { cron: "15 * * * *" }, concurrency: 1, retries: 3 },
  async ({ step }) => {
    const expired = await step.run("delete-expired-photos", async () => {
      const admin = getAdminClient();
      const { data, error } = await admin
        .from("assets")
        .select("id,organization_id")
        .is("deleted_at", null)
        .not("expires_at", "is", null)
        .lt("expires_at", new Date().toISOString())
        .limit(100);
      if (error) throw new Error("Media retention inspection failed.");
      for (const asset of data ?? [])
        await deletePrivateAsset({ organizationId: asset.organization_id, assetId: asset.id });
      return { deleted: data?.length ?? 0 };
    });
    const requests = await step.run("retry-session-deletions", async () => {
      const admin = getAdminClient();
      const { data, error } = await admin
        .from("privacy_requests")
        .select("id,organization_id,try_on_session_id")
        .eq("type", "delete_session")
        .in("status", ["pending", "processing"])
        .order("created_at")
        .limit(50);
      if (error) throw new Error("Privacy cleanup inspection failed.");
      for (const request of data ?? []) {
        if (!request.organization_id || !request.try_on_session_id) continue;
        const { data: session, error: sessionError } = await admin
          .from("try_on_sessions")
          .select("customer_asset_id,job_id")
          .eq("id", request.try_on_session_id)
          .eq("organization_id", request.organization_id)
          .single();
        if (sessionError || !session) throw new Error("Privacy cleanup session is missing.");
        if (session.customer_asset_id)
          await deletePrivateAsset({
            organizationId: request.organization_id,
            assetId: session.customer_asset_id,
          });
        if (session.job_id) {
          const { data: outputs, error: outputsError } = await admin
            .from("assets")
            .select("id")
            .eq("generation_job_id", session.job_id)
            .eq("organization_id", request.organization_id);
          if (outputsError) throw new Error("Privacy cleanup outputs could not be inspected.");
          for (const output of outputs ?? [])
            await deletePrivateAsset({
              organizationId: request.organization_id,
              assetId: output.id,
            });
        }
        const { error: completedError } = await admin
          .from("privacy_requests")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", request.id);
        if (completedError) throw new Error("Privacy cleanup completion could not be recorded.");
      }
      return { completed: data?.length ?? 0 };
    });
    const abandoned = await step.run("clean-abandoned-uploads", () => cleanAbandonedUploads());
    const failedOutputs = await step.run("clean-failed-generation-assets", async () => {
      const admin = getAdminClient();
      const { data: assets, error: assetError } = await admin
        .from("assets")
        .select(
          "id,organization_id,parent:generation_jobs!assets_generation_job_tenant_fk!inner(status,completed_at)",
        )
        .in("parent.status", ["failed", "cancelled"])
        .lt("parent.completed_at", new Date(Date.now() - 3_600_000).toISOString())
        .is("deleted_at", null)
        .limit(100);
      if (assetError) throw new Error("Failed generation asset inspection failed.");
      for (const asset of assets ?? [])
        await deletePrivateAsset({ organizationId: asset.organization_id, assetId: asset.id });
      return assets?.length ?? 0;
    });
    return { ...expired, ...requests, abandoned, failedOutputs };
  },
);

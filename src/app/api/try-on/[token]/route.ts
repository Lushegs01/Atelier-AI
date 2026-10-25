import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { consumeRateLimit } from "@/server/auth/context";
import { ApiError, hashToken } from "@/server/auth/security";
import { assertDatabaseResult, readImageForm, readJson, route } from "@/server/services/http";
import {
  getConsentVersion,
  getGuestSession,
  providerDisclosure,
  requireSessionProvider,
} from "@/server/services/try-on";
import {
  getActiveProviderId,
  getProviderCapabilities,
  type ProviderId,
} from "@/server/ai/registry";
import { getServerEnv } from "@/lib/env";
import { purgeQwenPrediction } from "@/server/ai/cleanup";
import { requireCapability } from "@/server/services/generations";
import { reserveGeneration } from "@/server/billing/service";
import { getAssetSignedUrl, uploadPrivateImage, deletePrivateAsset } from "@/server/storage/media";
import { dispatchGeneration } from "@/workers/client";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context) {
  return route(request, async () => {
    const { token } = await context.params;
    const session = await getGuestSession(token);
    await consumeRateLimit(`guest-read:${hashToken(token)}`, 90, 60);
    const admin = getAdminClient();
    const capability = getProviderCapabilities(session.provider as ProviderId).find(
      (item) => item.operation === "try_on",
    );
    let originalQuery = admin
      .from("assets")
      .select("id")
      .eq("garment_id", session.garment_id)
      .eq("organization_id", session.organization_id)
      .in("kind", ["original", "garment_original"])
      .in("view", [...(capability?.supportedViews || [])])
      .gte("width", capability?.minInputDimension || 256)
      .gte("height", capability?.minInputDimension || 256)
      .is("deleted_at", null);
    if (session.provider === "qwen")
      originalQuery = originalQuery.lte("byte_size", 4 * 1024 * 1024);
    const [orgResult, garmentResult, originalResult] = await Promise.all([
      admin
        .from("organizations")
        .select("name,brand_name,brand_color,deleted_at")
        .eq("id", session.organization_id)
        .maybeSingle(),
      admin
        .from("garments")
        .select("name,description,deleted_at")
        .eq("id", session.garment_id)
        .eq("organization_id", session.organization_id)
        .maybeSingle(),
      originalQuery.order("created_at").limit(1).maybeSingle(),
    ]);
    if (
      !orgResult.data ||
      orgResult.data.deleted_at ||
      !garmentResult.data ||
      garmentResult.data.deleted_at
    )
      throw new ApiError(410, "This garment is no longer available.", "LINK_REVOKED");
    let job = null;
    let outputs: { id: string; url: string }[] = [];
    if (session.job_id) {
      const { data } = await admin
        .from("generation_jobs")
        .select("id,status,created_at,completed_at")
        .eq("id", session.job_id)
        .eq("organization_id", session.organization_id)
        .maybeSingle();
      job = data;
      if (data?.status === "succeeded") {
        const { data: rows } = await admin
          .from("generation_outputs")
          .select("id,asset_id")
          .eq("job_id", session.job_id)
          .eq("organization_id", session.organization_id);
        outputs = await Promise.all(
          (rows || []).map(async (row) => ({
            id: row.id,
            url: await getAssetSignedUrl({
              assetId: row.asset_id,
              organizationId: session.organization_id,
            }),
          })),
        );
      }
    }
    return {
      session: {
        id: session.id,
        expiresAt: session.expires_at,
        completed: Boolean(session.job_id),
        uses: session.uses,
        maxUses: session.max_uses,
      },
      brand: {
        name: orgResult.data.brand_name || orgResult.data.name,
        color: orgResult.data.brand_color,
      },
      garment: {
        name: garmentResult.data.name,
        description: garmentResult.data.description,
        imageUrl: originalResult.data
          ? await getAssetSignedUrl({
              assetId: originalResult.data.id,
              organizationId: session.organization_id,
            })
          : null,
      },
      job,
      outputs,
      provider: {
        ...providerDisclosure(session.provider as ProviderId, "try_on"),
        model: session.provider_model,
      },
      consentVersion: getConsentVersion(session.provider as ProviderId),
      retentionHours: getServerEnv().CUSTOMER_PHOTO_RETENTION_HOURS,
      available:
        session.provider === getActiveProviderId() &&
        Boolean(
          getProviderCapabilities(session.provider as ProviderId).find(
            (capability) => capability.operation === "try_on",
          )?.enabled,
        ),
    };
  });
}

export async function POST(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const { token } = await context.params;
      const session = await getGuestSession(token, true);
      const provider = requireSessionProvider(session.provider);
      const capability = requireCapability("try_on");
      await consumeRateLimit(`guest-submit:${hashToken(token)}`, 5, 3600);
      await consumeRateLimit(`guest-org:${session.organization_id}`, 30, 3600);
      const { form, file } = await readImageForm(request);
      const consentVersion = getConsentVersion(provider);
      if (form.get("consent") !== "true" || form.get("consentVersion") !== consentVersion)
        throw new ApiError(
          422,
          "Read the disclosure and give explicit consent before uploading.",
          "CONSENT_REQUIRED",
        );
      const admin = getAdminClient();
      const { error: consentError } = await admin.from("consents").insert({
        organization_id: session.organization_id,
        try_on_session_id: session.id,
        version: consentVersion,
        purpose: "virtual_try_on",
      });
      assertDatabaseResult(consentError);
      const asset = await uploadPrivateImage({
        organizationId: session.organization_id,
        actorId: null,
        file,
        kind: "customer_photo",
      });
      try {
        if (
          (asset.width || 0) < capability.minInputDimension ||
          (asset.height || 0) < capability.minInputDimension ||
          (provider === "qwen" && asset.byte_size > 4 * 1024 * 1024)
        )
          throw new ApiError(
            422,
            `Choose a photograph at least ${capability.minInputDimension} pixels wide and high${provider === "qwen" ? ", up to 4 MB" : ""}.`,
            "SOURCE_INCOMPATIBLE",
          );
        const job = await reserveGeneration({
          organizationId: session.organization_id,
          actorId: null,
          operation: "try_on",
          garmentId: session.garment_id,
          sourceAssetId: asset.id,
          inputAssetIds: [asset.id],
          options: { tryOnSessionId: session.id },
          idempotencyKey: `tryon:${session.id}`,
          tryOnSessionId: session.id,
          provider,
          expectedCredits: session.quoted_credits ?? undefined,
          expectedPriceRuleId: session.price_rule_id ?? undefined,
        });
        // Reuse is accepted only for the same immutable inputs; conflicting races are rejected by SQL.
        if (job.source_asset_id !== asset.id)
          await deletePrivateAsset({ assetId: asset.id, organizationId: session.organization_id });
        await dispatchGeneration(job.id, session.organization_id).catch(() => undefined);
        return {
          job: { id: job.id, status: job.status },
          message: "Your photo is being processed privately.",
        };
      } catch (error) {
        await deletePrivateAsset({
          assetId: asset.id,
          organizationId: session.organization_id,
        }).catch(() => undefined);
        throw error;
      }
    },
    true,
  );
}

export async function DELETE(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const { token } = await context.params;
      const session = await getGuestSession(token, false, true);
      await consumeRateLimit(`guest-delete:${hashToken(token)}`, 5, 3600);
      const { reason } = z
        .object({ reason: z.string().trim().max(1000).optional() })
        .parse(await readJson(request));
      const admin = getAdminClient();
      // Keep a durable request even if object deletion fails or a running provider cannot be cancelled.
      const { data: deletion, error } = await admin
        .from("privacy_requests")
        .insert({
          organization_id: session.organization_id,
          try_on_session_id: session.id,
          type: "delete_session",
          reason,
        })
        .select("id")
        .single();
      assertDatabaseResult(error);
      if (!deletion)
        throw new ApiError(
          503,
          "Your request could not be recorded. Please try again.",
          "DATABASE_ERROR",
        );
      const now = new Date().toISOString();
      const { error: revokeError } = await admin
        .from("try_on_sessions")
        .update({ revoked_at: now, deleted_at: now })
        .eq("id", session.id)
        .eq("organization_id", session.organization_id);
      assertDatabaseResult(revokeError);
      await admin
        .from("consents")
        .update({ withdrawn_at: now })
        .eq("try_on_session_id", session.id)
        .eq("organization_id", session.organization_id);
      if (session.customer_asset_id)
        await deletePrivateAsset({
          assetId: session.customer_asset_id,
          organizationId: session.organization_id,
        }).catch(() => undefined);
      if (session.job_id) {
        await purgeQwenPrediction({
          organizationId: session.organization_id,
          jobId: session.job_id,
        }).catch(() => undefined);
        const { data: outputs } = await admin
          .from("generation_outputs")
          .select("asset_id")
          .eq("job_id", session.job_id)
          .eq("organization_id", session.organization_id);
        for (const output of outputs || [])
          await deletePrivateAsset({
            assetId: output.asset_id,
            organizationId: session.organization_id,
          }).catch(() => undefined);
      }
      return {
        ok: true,
        requestId: deletion.id,
        message:
          "Access has been revoked. Your deletion request is recorded; upstream provider retention is described in the privacy notice.",
      };
    },
    true,
  );
}

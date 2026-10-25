import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin, consumeRateLimit } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";
import { getProviderCapabilities } from "@/server/ai/provider";
import {
  reconcilePendingPayments,
  requestPaymentRefund,
  reconcilePaymentRefund,
} from "@/server/billing/service";
import { dispatchGenerationRecovery } from "@/workers/client";

type Context = { params: Promise<{ resource: string }> };

export async function GET(request: Request, context: Context) {
  return route(request, async () => {
    const { user } = await requirePlatformAdmin();
    const { resource } = await context.params;
    await consumeRateLimit(`admin-read:${user.id}`, 120, 60);
    const admin = getAdminClient();
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .parse(new URL(request.url).searchParams.get("page") || 1);
    const start = (page - 1) * 50;
    if (resource === "providers")
      return { records: getProviderCapabilities(), environmentManaged: true };
    if (resource === "users") {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 50 });
      assertDatabaseResult(error);
      const { error: auditError } = await admin.from("audit_logs").insert({
        actor_id: user.id,
        action: "admin.users.viewed",
        target_type: "users",
        metadata: { page },
      });
      assertDatabaseResult(auditError);
      return {
        records: data.users.map((account) => ({
          id: account.id,
          email: account.email,
          created_at: account.created_at,
          last_sign_in_at: account.last_sign_in_at,
          email_confirmed: Boolean(account.email_confirmed_at),
        })),
        page,
      };
    }
    if (resource === "overview") {
      const [organizations, jobs, payments, failures, privacy] = await Promise.all([
        admin
          .from("organizations")
          .select("id", { count: "exact", head: true })
          .is("deleted_at", null),
        admin
          .from("generation_jobs")
          .select("id", { count: "exact", head: true })
          .in("status", ["queued", "submitting", "processing", "retry_wait"]),
        admin
          .from("payment_transactions")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "initialized", "refund_pending"]),
        admin
          .from("generation_jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", "failed"),
        admin
          .from("privacy_requests")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "blocked"]),
      ]);
      assertDatabaseResult(
        [organizations, jobs, payments, failures, privacy].find((item) => item.error)?.error,
      );
      return {
        organizations: organizations.count,
        activeJobs: jobs.count,
        pendingPayments: payments.count,
        failedJobs: failures.count,
        privacyRequests: privacy.count,
        providers: getProviderCapabilities(),
      };
    }
    const resources = {
      organizations: {
        table: "organizations",
        columns: "id,name,created_at,daily_spending_limit,deleted_at",
      },
      jobs: {
        table: "generation_jobs",
        columns:
          "id,organization_id,operation,status,provider_model,provider_reference,retry_count,error_code,created_at,started_at,completed_at",
      },
      payments: {
        table: "payment_transactions",
        columns:
          "id,organization_id,reference,amount_kobo,currency,credits,status,expected_domain,paid_at,created_at",
      },
      pricing: { table: "generation_price_rules", columns: "*" },
      audit: {
        table: "audit_logs",
        columns: "id,organization_id,actor_id,action,target_type,target_id,metadata,created_at",
      },
      privacy: {
        table: "privacy_requests",
        columns: "id,organization_id,user_id,try_on_session_id,type,reason,status,created_at",
      },
    } as const;
    const definition = resources[resource as keyof typeof resources];
    if (!definition)
      throw new ApiError(404, "This administrative resource was not found.", "NOT_FOUND");
    const { data, error } = await admin
      .from(definition.table)
      .select(definition.columns)
      .order("created_at", { ascending: false })
      .range(start, start + 49);
    assertDatabaseResult(error);
    return { records: data, page, pageSize: 50 };
  });
}

export async function POST(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const { user } = await requirePlatformAdmin();
      const { resource } = await context.params;
      await consumeRateLimit(`admin-write:${user.id}`, 30, 60);
      const body = z
        .object({ action: z.string().min(1).max(60), reason: z.string().trim().min(10).max(1000) })
        .passthrough()
        .parse(await readJson(request));
      const admin = getAdminClient();
      // Write an attempted action before operational mutations. Financial RPCs also audit atomically.
      const { error: auditError } = await admin.from("audit_logs").insert({
        actor_id: user.id,
        action: `admin.${resource}.${body.action}.requested`,
        target_type: resource,
        metadata: { reason: body.reason },
      });
      assertDatabaseResult(auditError);
      if (resource === "payments") {
        if (body.action === "reconcile") return reconcilePendingPayments();
        if (body.action === "request_refund") {
          const input = z
            .object({
              reference: z.string().min(8).max(200),
              idempotencyKey: z.string().min(8).max(200),
            })
            .parse(body);
          return requestPaymentRefund({
            adminId: user.id,
            reference: input.reference,
            reason: body.reason,
            idempotencyKey: input.idempotencyKey,
          });
        }
        if (body.action === "reconcile_refund") {
          const { reference, providerRefundId } = z
            .object({
              reference: z.string().min(8).max(200),
              providerRefundId: z
                .string()
                .min(1)
                .max(100)
                .regex(/^[A-Za-z0-9_-]+$/)
                .optional(),
            })
            .parse(body);
          return reconcilePaymentRefund(reference, providerRefundId);
        }
      }
      if (resource === "credits" && body.action === "adjust") {
        const input = z
          .object({
            organizationId: z.string().uuid(),
            delta: z
              .number()
              .int()
              .min(-100000)
              .max(100000)
              .refine((amount) => amount !== 0),
            idempotencyKey: z.string().min(8).max(200),
          })
          .parse(body);
        const { data, error } = await admin.rpc("admin_adjust_credits", {
          p_admin_id: user.id,
          p_organization_id: input.organizationId,
          p_delta: input.delta,
          p_reason: body.reason,
          p_idempotency_key: input.idempotencyKey,
        });
        assertDatabaseResult(error);
        return { account: data };
      }
      if (resource === "pricing" && body.action === "update") {
        const input = z
          .object({
            id: z.string().uuid(),
            credits: z.number().int().min(1).max(100000),
            enabled: z.boolean(),
            reviewed: z.literal(true),
            estimatedProviderCostMicrousd: z
              .number()
              .int()
              .min(0)
              .max(10000000000)
              .nullable()
              .optional(),
          })
          .parse(body);
        const { data, error } = await admin
          .from("generation_price_rules")
          .update({
            credits: input.credits,
            enabled: input.enabled,
            reviewed_at: new Date().toISOString(),
            ...(input.estimatedProviderCostMicrousd !== undefined
              ? { estimated_provider_cost_microusd: input.estimatedProviderCostMicrousd }
              : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", input.id)
          .select()
          .maybeSingle();
        assertDatabaseResult(error);
        if (!data) throw new ApiError(404, "This pricing rule was not found.", "NOT_FOUND");
        return { rule: data };
      }
      if (resource === "organizations" && body.action === "set_spending_limit") {
        const input = z
          .object({ organizationId: z.string().uuid(), limit: z.number().int().min(0).max(100000) })
          .parse(body);
        const { error } = await admin
          .from("organizations")
          .update({ daily_spending_limit: input.limit, updated_at: new Date().toISOString() })
          .eq("id", input.organizationId);
        assertDatabaseResult(error);
        return { ok: true };
      }
      if (resource === "users" && ["suspend", "unsuspend"].includes(body.action)) {
        const { userId } = z.object({ userId: z.string().uuid() }).parse(body);
        if (userId === user.id)
          throw new ApiError(
            422,
            "You cannot suspend your own administrative account.",
            "SELF_CHANGE_FORBIDDEN",
          );
        const { error } = await admin.auth.admin.updateUserById(userId, {
          ban_duration: body.action === "suspend" ? "876000h" : "none",
        });
        assertDatabaseResult(error);
        return { ok: true };
      }
      if (resource === "jobs" && body.action === "resume") {
        const { jobId } = z.object({ jobId: z.string().uuid() }).parse(body);
        const { data: job, error } = await admin
          .from("generation_jobs")
          .select("id,organization_id,status,provider_reference")
          .eq("id", jobId)
          .maybeSingle();
        assertDatabaseResult(error);
        if (!job) throw new ApiError(404, "This job was not found.", "NOT_FOUND");
        if (!job.provider_reference || !["processing", "retry_wait"].includes(job.status))
          throw new ApiError(
            409,
            "Only an existing provider prediction can be resumed. Reconcile ambiguous submissions with the provider first.",
            "MANUAL_RECONCILIATION_REQUIRED",
          );
        await dispatchGenerationRecovery(job.id, job.organization_id);
        return { ok: true, message: "The existing prediction has been queued for reconciliation." };
      }
      throw new ApiError(422, "This administrative action is not supported.", "ACTION_UNSUPPORTED");
    },
    true,
  );
}

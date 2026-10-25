import "server-only";
import { hasSupabaseConfig } from "@/lib/supabase/admin";
import { requireUser } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { getAssetSignedUrl } from "@/server/storage/media";
import { getActiveProviderId, getProviderCapabilities } from "@/server/ai/registry";
import { providerDisclosure } from "./try-on";

export async function getWorkspace(organizationId?: string, page = 1) {
  const empty = {
    provider: providerDisclosure(getActiveProviderId()),
    capabilities: getProviderCapabilities(),
    organization: null,
    role: null,
    garments: [],
    jobs: [],
    outputs: [],
    balance: { available: 0, reserved: 0 },
    ledger: [],
    payments: [],
    customers: [],
    tryOnSessions: [],
    packages: [],
  };
  if (!hasSupabaseConfig()) return { configured: false, ...empty };
  const { user, client } = await requireUser();
  let membership = client
    .from("organization_members")
    .select("organization_id,role")
    .eq("user_id", user.id);
  if (organizationId) membership = membership.eq("organization_id", organizationId);
  const { data: member, error: membershipError } = await membership
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (membershipError)
    throw new ApiError(503, "Workspace membership is unavailable.", "DATABASE_ERROR");
  if (!member) {
    if (organizationId)
      throw new ApiError(403, "You do not have access to this workspace.", "FORBIDDEN");
    return {
      configured: true,
      ...empty,
      user: {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.display_name || "",
        fullName: user.user_metadata?.display_name || "",
      },
    };
  }
  const org = member.organization_id as string;
  const start = (page - 1) * 24;
  const queries = await Promise.all([
    client.from("organizations").select("*").eq("id", org).single(),
    client
      .from("garments")
      .select("*")
      .eq("organization_id", org)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(start, start + 23),
    client
      .from("generation_jobs")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .range(start, start + 23),
    client
      .from("generation_outputs")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .range(start, start + 23),
    client.from("credit_accounts").select("*").eq("organization_id", org).maybeSingle(),
    client
      .from("credit_ledger")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .range(start, start + 23),
    client
      .from("payment_transactions")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .range(start, start + 23),
    client
      .from("customers")
      .select("*")
      .eq("organization_id", org)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(start, start + 23),
    client
      .from("try_on_sessions")
      .select("*")
      .eq("organization_id", org)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(start, start + 23),
    client.from("credit_packages").select("*").eq("enabled", true).order("credits"),
  ]);
  const failed = queries.find((result) => result.error);
  if (failed)
    throw new ApiError(
      503,
      "Workspace records could not be loaded. Verify that database migrations are installed.",
      "DATABASE_ERROR",
    );
  const [
    organization,
    garments,
    jobs,
    outputs,
    account,
    ledger,
    payments,
    customers,
    sessions,
    packages,
  ] = queries.map((result) => result.data);
  const garmentRows = (garments || []) as Record<string, unknown>[];
  const outputRows = (outputs || []) as Record<string, unknown>[];
  const garmentIds = garmentRows.map((row) => String(row.id));
  const outputIds = outputRows.map((row) => String(row.asset_id));
  const parentIds = outputRows.map((row) => String(row.job_id));
  const selectedColumns = "id,garment_id,kind,view,mime_type,width,height,created_at";
  const [originalAssets, outputAssets, outputParents] = await Promise.all([
    garmentIds.length
      ? client
          .from("assets")
          .select(selectedColumns)
          .eq("organization_id", org)
          .in("garment_id", garmentIds)
          .in("kind", ["original", "garment_original"])
          .is("deleted_at", null)
          .order("created_at")
          .limit(1000)
      : Promise.resolve({ data: [], error: null }),
    outputIds.length
      ? client
          .from("assets")
          .select(selectedColumns)
          .eq("organization_id", org)
          .in("id", outputIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    parentIds.length
      ? client
          .from("generation_jobs")
          .select("id,operation")
          .eq("organization_id", org)
          .in("id", parentIds)
          .eq("status", "succeeded")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (originalAssets.error || outputAssets.error || outputParents.error)
    throw new ApiError(503, "Media records could not be loaded.", "DATABASE_ERROR");
  const assetRows = [...(originalAssets.data || []), ...(outputAssets.data || [])] as Record<
    string,
    unknown
  >[];
  const succeededIds = new Set((outputParents.data || []).map((row) => row.id));
  const signedGarments = await Promise.all(
    garmentRows.map(async (garment) => {
      const originals = assetRows.filter(
        (asset) =>
          asset.garment_id === garment.id &&
          ["original", "garment_original"].includes(String(asset.kind)),
      );
      const first = originals[0];
      return {
        ...garment,
        assets: originals,
        imageUrl: first
          ? await getAssetSignedUrl({ assetId: String(first.id), organizationId: org }).catch(
              () => null,
            )
          : null,
      };
    }),
  );
  const signedOutputs = await Promise.all(
    outputRows
      .filter(
        (output) =>
          succeededIds.has(String(output.job_id)) &&
          assetRows.some((asset) => asset.id === output.asset_id),
      )
      .map(async (output) => ({
        ...output,
        operation: outputParents.data?.find((job) => job.id === output.job_id)?.operation,
        asset: assetRows.find((asset) => asset.id === output.asset_id),
        url: output.asset_id
          ? await getAssetSignedUrl({
              assetId: String(output.asset_id),
              organizationId: org,
            }).catch(() => null)
          : null,
      })),
  );
  const accountRow = account as Record<string, unknown> | null;
  const orgRow = organization as Record<string, unknown>;
  return {
    configured: true,
    provider: providerDisclosure(getActiveProviderId()),
    capabilities: getProviderCapabilities(),
    user: {
      id: user.id,
      email: user.email,
      name: user.user_metadata?.display_name || "",
      fullName: user.user_metadata?.display_name || "",
    },
    organization: {
      id: orgRow.id,
      name: orgRow.name,
      slug: orgRow.slug,
      brand_name: orgRow.brand_name,
      brand_color: orgRow.brand_color,
      daily_spending_limit: orgRow.daily_spending_limit,
    },
    role: member.role,
    garments: signedGarments,
    jobs: ((jobs || []) as Record<string, unknown>[]).map((job) => ({
      id: job.id,
      garment_id: job.garment_id,
      operation: job.operation,
      provider: job.provider,
      provider_model: job.provider_model,
      status: job.status,
      estimated_credits: job.estimated_credits,
      settled_credits: job.settled_credits,
      created_at: job.created_at,
      updated_at: job.updated_at,
      error:
        job.status === "failed"
          ? "This generation failed. Any eligible reservation has been released."
          : null,
    })),
    outputs: signedOutputs,
    balance: {
      available: Number(accountRow?.available || 0),
      reserved: Number(accountRow?.reserved || 0),
    },
    ledger: ((ledger || []) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      type: row.kind,
      amount: row.available_delta,
      delta_reserved: row.reserved_delta,
      description: row.reason,
      created_at: row.created_at,
    })),
    payments: ((payments || []) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      reference: row.reference,
      amount_kobo: row.amount_kobo,
      currency: row.currency,
      status: row.status,
      credits: row.credits,
      created_at: row.created_at,
      paid_at: row.paid_at,
    })),
    customers,
    tryOnSessions: ((sessions || []) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      garment_id: row.garment_id,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      max_uses: row.max_uses,
      uses: row.uses,
      job_id: row.job_id,
      provider: row.provider,
      provider_model: row.provider_model,
      created_at: row.created_at,
    })),
    packages: ((packages || []) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      name: row.name,
      credits: row.credits,
      amount_kobo: row.amount_kobo,
      currency: row.currency,
    })),
    pagination: {
      page,
      pageSize: 24,
      hasMore: [garments, jobs, outputs, ledger, payments, customers, sessions].some(
        (rows) => Array.isArray(rows) && rows.length === 24,
      ),
    },
  };
}

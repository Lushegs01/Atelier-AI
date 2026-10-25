import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type QueryResult = { data: Row[] | Row | null; error: null | { message: string }; count?: number };
const { state, provider, media } = vi.hoisted(() => ({
  state: {
    tables: {} as Record<string, Row[]>,
    capacityAvailable: true,
    failNextUpdate: false,
    finalizations: 0,
    available: 0,
    reserved: 12,
  },
  provider: {
    generateFashionImage: vi.fn(),
    generateFashionVideo: vi.fn(),
    generateVirtualTryOn: vi.fn(),
    getGenerationStatus: vi.fn(),
  },
  media: {
    transferProviderOutput: vi.fn(),
    downloadAssetForProvider: vi.fn(),
    deletePrivateAsset: vi.fn(),
  },
}));

function fakeQuery(table: string) {
  const filters: ((row: Row) => boolean)[] = [];
  let values: Row | null = null;
  let upsert: Row | null = null;
  let count = false;
  const result = (): QueryResult => {
    const rows = (state.tables[table] ?? []).filter((row) =>
      filters.every((filter) => filter(row)),
    );
    if (values) {
      if (state.failNextUpdate) {
        state.failNextUpdate = false;
        return { data: null, error: { message: "synthetic database outage" } };
      }
      for (const row of rows) Object.assign(row, values);
    }
    if (upsert && !(state.tables[table] ?? []).some((row) => row.id === upsert!.id))
      (state.tables[table] ??= []).push(upsert);
    return { data: rows.map((row) => ({ ...row })), error: null, ...(count ? { count: 0 } : {}) };
  };
  const query = {
    select(_columns?: string, options?: { count?: string }) {
      count = Boolean(options?.count);
      return query;
    },
    eq(key: string, value: unknown) {
      filters.push((row) => row[key] === value);
      return query;
    },
    is(key: string, value: unknown) {
      filters.push((row) => (row[key] ?? null) === value);
      return query;
    },
    in(key: string, values: unknown[]) {
      filters.push((row) => values.includes(row[key]));
      return query;
    },
    not(key: string, _operator: string, value: string) {
      const excluded = value.replace(/[()]/g, "").split(",");
      filters.push((row) => !excluded.includes(String(row[key])));
      return query;
    },
    like() {
      return query;
    },
    gte() {
      return query;
    },
    lte() {
      return query;
    },
    order() {
      return query;
    },
    limit() {
      return query;
    },
    update(value: Row) {
      values = value;
      return query;
    },
    upsert(value: Row) {
      upsert = value;
      return query;
    },
    async single() {
      const value = result();
      return { ...value, data: Array.isArray(value.data) ? (value.data[0] ?? null) : value.data };
    },
    async maybeSingle() {
      return query.single();
    },
    then(resolve: (value: QueryResult) => unknown) {
      return Promise.resolve(result()).then(resolve);
    },
  };
  return query;
}

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    from: fakeQuery,
    async rpc(name: string, args: Row) {
      const job = (state.tables.generation_jobs ?? []).find((row) => row.id === args.p_job_id)!;
      if (name === "claim_generation") {
        if (!state.capacityAvailable || !["queued", "retry_wait"].includes(String(job.status)))
          return { data: [], error: null };
        job.status = "submitting";
        job.lease_until = new Date(Date.now() + 90_000).toISOString();
        return { data: [{ ...job }], error: null };
      }
      if (name === "finalize_generation") {
        if (["succeeded", "failed", "cancelled"].includes(String(job.status)))
          return { data: job, error: null };
        state.finalizations++;
        state.reserved -= 12;
        if (!args.p_success) state.available += 12;
        job.status = args.p_success ? "succeeded" : "failed";
        job.error_code = args.p_error_code;
        return { data: job, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  }),
}));
vi.mock("@/server/ai/registry", () => ({
  createProviderForJob: vi.fn(() => provider),
  assertCapabilityEnabled: vi.fn(),
  getProviderCapabilities: () => [
    { operation: "photo", minInputDimension: 15 },
    { operation: "try_on", minInputDimension: 15 },
  ],
}));
vi.mock("@/server/storage/media", () => ({
  ...media,
  deterministicOutputId: (jobId: string, index: number, kind = "asset") =>
    `${jobId}:${index}:${kind}`,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/workers/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workers/client")>()),
  dispatchGenerationRecovery: vi.fn().mockResolvedValue(undefined),
}));

import { ProviderError } from "@/server/ai/contracts";
import { dispatchGenerationRecovery } from "@/workers/client";
import {
  pollGenerationAndTransfer,
  reconcileExhaustedGeneration,
  recordAcceptedPrediction,
  submitGenerationOnce,
} from "@/workers/generation";

const jobId = "b10f30d0-67cf-467a-9a39-e19c56392c71";
const organizationId = "467219f3-84c1-4423-a709-2d68ed8f10de";
function job(): Row {
  return state.tables.generation_jobs[0];
}

describe("generation lifecycle integration (database, queue, media and HTTP test doubles)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.capacityAvailable = true;
    state.failNextUpdate = false;
    state.finalizations = 0;
    state.available = 0;
    state.reserved = 12;
    state.tables = {
      generation_jobs: [
        {
          id: jobId,
          organization_id: organizationId,
          status: "queued",
          operation: "photo",
          provider: "fashn",
          provider_model: "product-to-model",
          garment_id: "garment",
          source_asset_id: "source",
          input_asset_ids: ["source"],
          options: {},
          provider_reference: null,
          retry_count: 0,
          created_by: "owner",
          error_code: null,
          lease_until: null,
        },
      ],
      assets: [
        {
          id: "source",
          garment_id: "garment",
          organization_id: organizationId,
          kind: "original",
          view: "front",
          deleted_at: null,
        },
      ],
      generation_outputs: [],
      try_on_sessions: [
        {
          id: "session",
          organization_id: organizationId,
          job_id: jobId,
          customer_asset_id: "customer",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          revoked_at: null,
          deleted_at: null,
        },
      ],
      consents: [
        {
          id: "consent",
          try_on_session_id: "session",
          organization_id: organizationId,
          withdrawn_at: null,
        },
      ],
    };
    provider.generateFashionImage.mockResolvedValue({ id: "known-prediction" });
    provider.getGenerationStatus.mockResolvedValue({
      id: "known-prediction",
      status: "completed",
      creditsUsed: 2,
      outputs: ["https://cdn.fashn.ai/synthetic/output.png"],
    });
    media.downloadAssetForProvider.mockResolvedValue("https://storage.example/short-lived-source");
    media.transferProviderOutput.mockResolvedValue({ id: "output-asset" });
    media.deletePrivateAsset.mockResolvedValue(undefined);
    vi.mocked(dispatchGenerationRecovery).mockResolvedValue(undefined);
  });

  it("submits once, persists acceptance in a separate step, and resumes without a second paid POST", async () => {
    const accepted = await submitGenerationOnce(jobId, organizationId);
    expect(accepted).toEqual({ id: "known-prediction" });
    expect(job().status).toBe("submitting");
    await recordAcceptedPrediction(jobId, accepted.id!);
    await expect(submitGenerationOnce(jobId, organizationId)).resolves.toEqual({
      id: "known-prediction",
    });
    expect(provider.generateFashionImage).toHaveBeenCalledTimes(1);
    await expect(pollGenerationAndTransfer(jobId, "known-prediction")).resolves.toEqual({
      state: "succeeded",
    });
    expect(state.reserved).toBe(0);
    expect(state.available).toBe(0);
    expect(state.finalizations).toBe(1);
  });

  it("retries persistence after a database crash using the durable accepted id", async () => {
    const accepted = await submitGenerationOnce(jobId, organizationId);
    state.failNextUpdate = true;
    await expect(recordAcceptedPrediction(jobId, accepted.id!)).rejects.toThrow("persisted");
    await recordAcceptedPrediction(jobId, accepted.id!);
    expect(job().provider_reference).toBe("known-prediction");
    expect(provider.generateFashionImage).toHaveBeenCalledTimes(1);
  });

  it("recovers Qwen acceptance by the stable UUID after a crash without another POST", async () => {
    Object.assign(job(), {
      provider: "qwen",
      provider_model: "Qwen/Qwen-Image-Edit-2511",
      status: "submitting",
      lease_until: new Date(Date.now() - 1000).toISOString(),
    });
    provider.getGenerationStatus.mockResolvedValueOnce({
      id: jobId,
      status: "processing",
      outputs: [],
    });
    await expect(submitGenerationOnce(jobId, organizationId)).resolves.toEqual({ id: jobId });
    expect(provider.generateFashionImage).not.toHaveBeenCalled();
    expect(provider.getGenerationStatus).toHaveBeenCalledWith(jobId);
    expect(state.reserved).toBe(12);
  });
  it("replays only the same Qwen UUID when the durable service confirms no accepted job", async () => {
    Object.assign(job(), {
      provider: "qwen",
      provider_model: "Qwen/Qwen-Image-Edit-2511",
      status: "submitting",
      lease_until: new Date(Date.now() - 1000).toISOString(),
    });
    provider.getGenerationStatus.mockRejectedValueOnce(
      new ProviderError("not accepted", "qwen_job_not_found"),
    );
    provider.generateFashionImage.mockResolvedValueOnce({ id: jobId });
    await expect(submitGenerationOnce(jobId, organizationId)).resolves.toEqual({ id: jobId });
    expect(provider.generateFashionImage.mock.calls[0][2]).toEqual({ requestId: jobId });
    expect(state.finalizations).toBe(0);
  });
  it("keeps an uncertain Qwen receipt reserved when the retry budget is exhausted", async () => {
    Object.assign(job(), {
      provider: "qwen",
      provider_model: "Qwen/Qwen-Image-Edit-2511",
      retry_count: 3,
    });
    provider.generateFashionImage.mockRejectedValueOnce(
      new ProviderError("no response", "qwen_submission_unavailable", true),
    );
    provider.getGenerationStatus.mockRejectedValueOnce(
      new ProviderError("offline", "qwen_status_unavailable", true),
    );
    await expect(submitGenerationOnce(jobId, organizationId)).rejects.toThrow(
      "receipt needs recovery",
    );
    expect(job().error_code).toBe("submission_ambiguous");
    expect(state.reserved).toBe(12);
    expect(state.finalizations).toBe(0);
  });
  it("dispatches recovery for a deterministic Qwen receipt rather than refunding an accepted job", async () => {
    Object.assign(job(), {
      provider: "qwen",
      provider_model: "Qwen/Qwen-Image-Edit-2511",
      status: "retry_wait",
      error_code: "submission_ambiguous",
    });
    provider.getGenerationStatus.mockResolvedValueOnce({
      id: jobId,
      status: "processing",
      outputs: [],
    });
    await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("recovered");
    expect(job().provider_reference).toBe(jobId);
    expect(state.reserved).toBe(12);
    expect(provider.generateFashionImage).not.toHaveBeenCalled();
  });

  it.each(["submitting", "retry_wait"])(
    "keeps an accepted Qwen receipt recoverable when dispatch fails from %s",
    async (status) => {
      Object.assign(job(), {
        provider: "qwen",
        provider_model: "Qwen/Qwen-Image-Edit-2511",
        status,
        error_code: status === "retry_wait" ? "submission_ambiguous" : null,
      });
      provider.getGenerationStatus.mockResolvedValueOnce({
        id: jobId,
        status: "processing",
        outputs: [],
      });
      vi.mocked(dispatchGenerationRecovery).mockRejectedValueOnce(new Error("queue unavailable"));

      await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("manual");
      expect(job()).toMatchObject({
        provider_reference: jobId,
        status: "retry_wait",
        error_code: "recovery_dispatch_pending",
        lease_until: null,
      });
      expect(state.reserved).toBe(12);
      expect(state.available).toBe(0);
      expect(state.finalizations).toBe(0);

      // A later failure callback or maintenance replay can dispatch the saved receipt directly.
      await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("recovered");
      expect(dispatchGenerationRecovery).toHaveBeenNthCalledWith(2, jobId, organizationId);
      expect(provider.getGenerationStatus).toHaveBeenCalledTimes(1);
      expect(provider.generateFashionImage).not.toHaveBeenCalled();
      expect(state.finalizations).toBe(0);

      await expect(pollGenerationAndTransfer(jobId, jobId)).resolves.toEqual({
        state: "succeeded",
      });
      expect(state.finalizations).toBe(1);
      expect(state.available).toBe(0);
    },
  );

  it("retains ambiguous receipt recovery when persisting acceptance fails before dispatch", async () => {
    Object.assign(job(), {
      provider: "qwen",
      provider_model: "Qwen/Qwen-Image-Edit-2511",
      status: "retry_wait",
      error_code: "submission_ambiguous",
    });
    state.failNextUpdate = true;
    await expect(reconcileExhaustedGeneration(jobId)).rejects.toThrow("persisted");
    expect(job()).toMatchObject({
      provider_reference: null,
      status: "retry_wait",
      error_code: "submission_ambiguous",
    });
    expect(dispatchGenerationRecovery).not.toHaveBeenCalled();
    expect(state.finalizations).toBe(0);
    expect(state.reserved).toBe(12);

    await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("recovered");
    expect(job()).toMatchObject({
      provider_reference: jobId,
      error_code: "recovery_dispatch_pending",
    });
  });

  it.each(["processing", "retry_wait"])(
    "dispatches stale known Qwen receipts from %s without refunding accepted inference",
    async (status) => {
      Object.assign(job(), {
        provider: "qwen",
        provider_model: "Qwen/Qwen-Image-Edit-2511",
        provider_reference: jobId,
        status,
        error_code: status === "retry_wait" ? "transfer_retry" : null,
      });
      await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("recovered");
      expect(job()).toMatchObject({
        provider_reference: jobId,
        status: "retry_wait",
        error_code: "recovery_dispatch_pending",
      });
      expect(dispatchGenerationRecovery).toHaveBeenCalledWith(jobId, organizationId);
      expect(provider.getGenerationStatus).not.toHaveBeenCalled();
      expect(provider.generateFashionImage).not.toHaveBeenCalled();
      expect(state.finalizations).toBe(0);
      expect(state.reserved).toBe(12);
    },
  );

  it("releases a Qwen reservation only when receipt lookup confirms it was not accepted", async () => {
    Object.assign(job(), {
      provider: "qwen",
      provider_model: "Qwen/Qwen-Image-Edit-2511",
      status: "retry_wait",
      error_code: "submission_ambiguous",
    });
    provider.getGenerationStatus.mockRejectedValueOnce(
      new ProviderError("not accepted", "qwen_job_not_found"),
    );
    await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("failed");
    expect(job()).toMatchObject({ status: "failed", error_code: "qwen_not_accepted" });
    expect(dispatchGenerationRecovery).not.toHaveBeenCalled();
    expect(state.finalizations).toBe(1);
    expect(state.reserved).toBe(0);
    expect(state.available).toBe(12);
  });

  it("holds an ambiguous POST for reconciliation and never repeats it after exhausted retries", async () => {
    provider.generateFashionImage.mockRejectedValueOnce(
      new ProviderError("Unknown acceptance", "submission_ambiguous", false, true),
    );
    await expect(submitGenerationOnce(jobId, organizationId)).rejects.toThrow("Unknown acceptance");
    expect(job()).toMatchObject({ status: "retry_wait", error_code: "submission_ambiguous" });
    await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("manual");
    await expect(submitGenerationOnce(jobId, organizationId)).rejects.toThrow("reconciliation");
    expect(provider.generateFashionImage).toHaveBeenCalledTimes(1);
    expect(state.reserved).toBe(12);
    expect(state.finalizations).toBe(0);
  });

  it("recovers an expired submission lease as ambiguous even if the process died before recording a response", async () => {
    Object.assign(job(), {
      status: "submitting",
      lease_until: new Date(Date.now() - 1_000).toISOString(),
    });
    await expect(submitGenerationOnce(jobId, organizationId)).rejects.toThrow("reconciliation");
    expect(provider.generateFashionImage).not.toHaveBeenCalled();
    expect(job().error_code).toBe("submission_ambiguous");
  });

  it("retries a definite pre-acceptance rejection and keeps only one reservation", async () => {
    provider.generateFashionImage.mockRejectedValueOnce(
      new ProviderError("rate limit", "provider_http_429", true),
    );
    await expect(submitGenerationOnce(jobId, organizationId)).rejects.toThrow(
      "temporarily rejected",
    );
    expect(job()).toMatchObject({ status: "retry_wait", retry_count: 1, lease_until: null });
    await expect(submitGenerationOnce(jobId, organizationId)).resolves.toEqual({
      id: "known-prediction",
    });
    expect(state.reserved).toBe(12);
    expect(state.finalizations).toBe(0);
  });

  it("waits durably without a POST or refund when the persistent provider slots are occupied", async () => {
    state.capacityAvailable = false;
    await expect(submitGenerationOnce(jobId, organizationId)).resolves.toEqual({
      id: null,
      waiting: true,
    });
    expect(provider.generateFashionImage).not.toHaveBeenCalled();
    expect(state.finalizations).toBe(0);
    state.capacityAvailable = true;
    await expect(submitGenerationOnce(jobId, organizationId)).resolves.toEqual({
      id: "known-prediction",
    });
  });

  it("releases a runtime failure once even if failure delivery and polling repeat", async () => {
    Object.assign(job(), { status: "processing", provider_reference: "known-prediction" });
    provider.getGenerationStatus.mockResolvedValueOnce({
      status: "failed",
      outputs: [],
      errorCode: "ImageLoadError",
    });
    await expect(pollGenerationAndTransfer(jobId, "known-prediction")).resolves.toEqual({
      state: "failed",
    });
    await reconcileExhaustedGeneration(jobId);
    await pollGenerationAndTransfer(jobId, "known-prediction");
    expect(state.finalizations).toBe(1);
    expect(state.available).toBe(12);
    expect(state.reserved).toBe(0);
    expect(media.transferProviderOutput).not.toHaveBeenCalled();
  });

  it("recovers a failed output transfer by polling the same prediction and settles once", async () => {
    Object.assign(job(), { status: "processing", provider_reference: "known-prediction" });
    media.transferProviderOutput.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(pollGenerationAndTransfer(jobId, "known-prediction")).rejects.toThrow(
      "storage unavailable",
    );
    expect(state.reserved).toBe(12);
    await pollGenerationAndTransfer(jobId, "known-prediction");
    await pollGenerationAndTransfer(jobId, "known-prediction");
    expect(state.tables.generation_outputs).toHaveLength(1);
    expect(state.finalizations).toBe(1);
    expect(provider.generateFashionImage).not.toHaveBeenCalled();
    expect(
      provider.getGenerationStatus.mock.calls.every(
        ([reference]) => reference === "known-prediction",
      ),
    ).toBe(true);
  });

  it("releases exhausted output transfer reservations while retaining the provider reference for cost review", async () => {
    Object.assign(job(), { status: "retry_wait", provider_reference: "known-prediction" });
    await expect(reconcileExhaustedGeneration(jobId)).resolves.toBe("failed");
    expect(job()).toMatchObject({
      status: "failed",
      provider_reference: "known-prediction",
      error_code: "output_transfer_exhausted",
    });
    expect(state.available).toBe(12);
  });
  it("does not report success if an operator already finalized failure during the output copy", async () => {
    Object.assign(job(), { status: "processing", provider_reference: "known-prediction" });
    media.transferProviderOutput.mockImplementationOnce(async () => {
      job().status = "failed";
      return { id: "late-output" };
    });
    await expect(pollGenerationAndTransfer(jobId, "known-prediction")).resolves.toEqual({
      state: "failed",
    });
    expect(state.finalizations).toBe(0);
  });

  it.each(["revoked", "expired", "withdrawn"])(
    "blocks %s customer permission before any output is copied",
    async (condition) => {
      Object.assign(job(), {
        operation: "try_on",
        status: "processing",
        provider_reference: "known-prediction",
        source_asset_id: "customer",
        options: { tryOnSessionId: "session" },
      });
      if (condition === "revoked")
        state.tables.try_on_sessions[0].revoked_at = new Date().toISOString();
      if (condition === "expired")
        state.tables.try_on_sessions[0].expires_at = new Date(Date.now() - 1000).toISOString();
      if (condition === "withdrawn")
        state.tables.consents[0].withdrawn_at = new Date().toISOString();
      await expect(pollGenerationAndTransfer(jobId, "known-prediction")).rejects.toThrow();
      expect(media.transferProviderOutput).not.toHaveBeenCalled();
      await reconcileExhaustedGeneration(jobId);
      expect(state.available).toBe(12);
    },
  );

  it("deletes a copied result when consent is withdrawn during the transfer", async () => {
    Object.assign(job(), {
      operation: "try_on",
      status: "processing",
      provider_reference: "known-prediction",
      source_asset_id: "customer",
      options: { tryOnSessionId: "session" },
    });
    media.transferProviderOutput.mockImplementationOnce(async () => {
      state.tables.consents[0].withdrawn_at = new Date().toISOString();
      return { id: "output-asset" };
    });
    await expect(pollGenerationAndTransfer(jobId, "known-prediction")).resolves.toEqual({
      state: "failed",
    });
    expect(media.deletePrivateAsset).toHaveBeenCalledWith({
      organizationId,
      assetId: "output-asset",
    });
    expect(state.available).toBe(12);
    expect(job().status).toBe("failed");
  });
});

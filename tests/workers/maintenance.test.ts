import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Result = { data: Row[]; error: null };
const mock = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  queries: [] as { table: string; filters: unknown[][] }[],
  from: vi.fn(),
  rpc: vi.fn(),
  reconcile: vi.fn(),
  purge: vi.fn(),
  removeAsset: vi.fn(),
  abandoned: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({ from: mock.from, rpc: mock.rpc }),
}));
vi.mock("@/workers/client", () => ({
  inngest: { createFunction: (config: unknown, handler: unknown) => ({ config, handler }) },
  generationRequested: { name: "atelier/generation.requested" },
}));
vi.mock("@/workers/generation", () => ({ reconcileExhaustedGeneration: mock.reconcile }));
vi.mock("@/server/ai/cleanup", () => ({ purgeQwenPrediction: mock.purge }));
vi.mock("@/server/storage/media", () => ({
  deletePrivateAsset: mock.removeAsset,
  cleanAbandonedUploads: mock.abandoned,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: mock.capture }));
import { cleanPrivateMedia, recoverStuckGenerations } from "@/workers/maintenance";

function field(row: Row, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as Row)[key] : undefined),
      row,
    );
}

/** In-memory records are actually filtered/updated, so a stale selector cannot return a fixture accidentally. */
class Query implements PromiseLike<Result> {
  private predicates: ((row: Row) => boolean)[] = [];
  private changes: Row | null = null;
  private maximum = Infinity;
  private trace: { table: string; filters: unknown[][] };
  constructor(private table: string) {
    this.trace = { table, filters: [] };
    mock.queries.push(this.trace);
  }
  select() {
    return this;
  }
  update(values: Row) {
    this.changes = values;
    return this;
  }
  eq(column: string, value: unknown) {
    this.trace.filters.push(["eq", column, value]);
    this.predicates.push((row) => field(row, column) === value);
    return this;
  }
  is(column: string, value: unknown) {
    this.trace.filters.push(["is", column, value]);
    this.predicates.push((row) =>
      value === null ? field(row, column) == null : field(row, column) === value,
    );
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    this.trace.filters.push(["not", column, operator, value]);
    if (operator !== "is") throw new Error(`Unsupported test filter: ${operator}`);
    this.predicates.push((row) =>
      value === null ? field(row, column) != null : field(row, column) !== value,
    );
    return this;
  }
  in(column: string, values: unknown[]) {
    this.trace.filters.push(["in", column, values]);
    this.predicates.push((row) => values.includes(field(row, column)));
    return this;
  }
  lt(column: string, value: string) {
    this.trace.filters.push(["lt", column, value]);
    this.predicates.push(
      (row) => typeof field(row, column) === "string" && String(field(row, column)) < value,
    );
    return this;
  }
  lte(column: string, value: string) {
    this.predicates.push(
      (row) => typeof field(row, column) === "string" && String(field(row, column)) <= value,
    );
    return this;
  }
  order() {
    return this;
  }
  limit(value: number) {
    this.maximum = value;
    return this;
  }
  private evaluate(): Result {
    const rows = (mock.tables[this.table] || [])
      .filter((row) => this.predicates.every((predicate) => predicate(row)))
      .slice(0, this.maximum);
    if (this.changes) for (const row of rows) Object.assign(row, this.changes);
    return { data: rows.map((row) => ({ ...row })), error: null };
  }
  async single() {
    return { data: this.evaluate().data[0] ?? null, error: null };
  }
  async maybeSingle() {
    return this.single();
  }
  then<T1 = Result, T2 = never>(
    resolve?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    reject?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.evaluate()).then(resolve, reject);
  }
}

const context = () => ({
  step: {
    run: async <T>(_name: string, callback: () => Promise<T>) => callback(),
    sendEvent: vi.fn(),
  },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
});
type Context = ReturnType<typeof context>;
type Captured = { handler: (context: Context) => Promise<Record<string, unknown>> };
const recovery = recoverStuckGenerations as unknown as Captured;
const cleanup = cleanPrivateMedia as unknown as Captured;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
  mock.tables = { generation_jobs: [], assets: [], privacy_requests: [], try_on_sessions: [] };
  mock.queries = [];
  mock.from.mockImplementation((table: string) => new Query(table));
  mock.rpc.mockResolvedValue({ data: 0, error: null });
  mock.abandoned.mockResolvedValue(2);
  mock.reconcile.mockResolvedValue("recovered");
  mock.purge.mockResolvedValue(undefined);
  mock.removeAsset.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("durable maintenance regressions (filtered Supabase and Inngest test doubles)", () => {
  it("retries persistent unknown and known Qwen receipts on later cron runs after a service outage", async () => {
    mock.tables.generation_jobs = [
      {
        id: "ambiguous",
        provider: "qwen",
        status: "retry_wait",
        error_code: "submission_ambiguous",
        provider_reference: null,
        created_at: ago(120),
        updated_at: ago(10),
      },
      {
        id: "lost-enqueue",
        provider: "qwen",
        status: "retry_wait",
        error_code: "recovery_dispatch_pending",
        provider_reference: "lost-enqueue",
        created_at: ago(120),
        updated_at: ago(10),
      },
      {
        id: "known-stale",
        provider: "qwen",
        status: "processing",
        error_code: null,
        provider_reference: "known-stale",
        created_at: ago(120),
        updated_at: ago(10),
      },
      {
        id: "known-recent",
        provider: "qwen",
        status: "processing",
        error_code: null,
        provider_reference: "known-recent",
        created_at: ago(30),
        updated_at: ago(1),
      },
      {
        id: "legacy-unknown",
        provider: "fashn",
        status: "retry_wait",
        error_code: "submission_ambiguous",
        provider_reference: null,
        created_at: ago(120),
        updated_at: ago(10),
      },
    ];
    mock.reconcile
      .mockResolvedValueOnce("manual")
      .mockResolvedValueOnce("manual")
      .mockResolvedValueOnce("manual");
    await recovery.handler(context());
    expect(mock.reconcile.mock.calls.map((call) => call[0]).sort()).toEqual([
      "ambiguous",
      "known-stale",
      "lost-enqueue",
    ]);
    // A new cron execution must inspect persisted state again, even though no lease expired this time.
    await recovery.handler(context());
    expect(
      mock.reconcile.mock.calls
        .slice(3)
        .map((call) => call[0])
        .sort(),
    ).toEqual(["ambiguous", "known-stale", "lost-enqueue"]);
    expect(mock.reconcile).not.toHaveBeenCalledWith("known-recent");
    expect(mock.reconcile).not.toHaveBeenCalledWith("legacy-unknown");
    expect(
      mock.queries.some((query) =>
        query.filters.some(
          (filter) =>
            filter[0] === "in" &&
            filter[1] === "error_code" &&
            Array.isArray(filter[2]) &&
            filter[2].includes("submission_ambiguous") &&
            filter[2].includes("recovery_dispatch_pending"),
        ),
      ),
    ).toBe(true);
    expect(
      mock.queries.some((query) =>
        query.filters.some(
          (filter) => filter[0] === "lt" && filter[1] === "updated_at" && filter[2] === ago(5),
        ),
      ),
    ).toBe(true);
  });

  it("isolates failed local/privacy/GPU deletions and continues other tenants and durable pending work", async () => {
    mock.tables.assets = [
      { id: "expired-failure", organization_id: "org-a", expires_at: ago(1), deleted_at: null },
      { id: "expired-success", organization_id: "org-b", expires_at: ago(1), deleted_at: null },
      { id: "customer-a", organization_id: "org-a", deleted_at: null },
      { id: "customer-b", organization_id: "org-b", deleted_at: null },
      {
        id: "failed-output-failure",
        organization_id: "org-a",
        deleted_at: null,
        parent: { status: "failed", completed_at: ago(120) },
      },
      {
        id: "failed-output-success",
        organization_id: "org-b",
        deleted_at: null,
        parent: { status: "failed", completed_at: ago(120) },
      },
    ];
    mock.tables.privacy_requests = [
      {
        id: "privacy-a",
        organization_id: "org-a",
        try_on_session_id: "session-a",
        type: "delete_session",
        status: "pending",
        created_at: ago(60),
      },
      {
        id: "privacy-b",
        organization_id: "org-b",
        try_on_session_id: "session-b",
        type: "delete_session",
        status: "pending",
        created_at: ago(60),
      },
    ];
    mock.tables.try_on_sessions = [
      {
        id: "session-a",
        organization_id: "org-a",
        customer_asset_id: "customer-a",
        job_id: "privacy-job-failure",
      },
      {
        id: "session-b",
        organization_id: "org-b",
        customer_asset_id: "customer-b",
        job_id: "privacy-job-success",
      },
    ];
    mock.tables.generation_jobs = [
      {
        id: "gpu-failure",
        organization_id: "org-a",
        provider: "qwen",
        inference_delete_requested_at: ago(60),
        inference_delete_completed_at: null,
      },
      {
        id: "gpu-success",
        organization_id: "org-b",
        provider: "qwen",
        inference_delete_requested_at: ago(60),
        inference_delete_completed_at: null,
      },
    ];
    mock.removeAsset.mockImplementation(async ({ assetId }: { assetId: string }) => {
      if (assetId.endsWith("failure")) throw new Error("Object storage temporarily unavailable");
      const asset = mock.tables.assets.find((row) => row.id === assetId);
      if (asset) asset.deleted_at = new Date().toISOString();
    });
    mock.purge.mockImplementation(async ({ jobId }: { jobId: string }) => {
      if (jobId.endsWith("failure")) throw new Error("GPU service temporarily unavailable");
      const job = mock.tables.generation_jobs.find((row) => row.id === jobId);
      if (job) job.inference_delete_completed_at = new Date().toISOString();
    });
    const run = context();
    const result = await cleanup.handler(run);
    expect(result).toMatchObject({
      deleted: 1,
      completed: 1,
      inferenceDeleted: 1,
      abandoned: 2,
      failedOutputs: 1,
    });
    expect(mock.tables.privacy_requests.find((row) => row.id === "privacy-a")?.status).toBe(
      "pending",
    );
    expect(mock.tables.privacy_requests.find((row) => row.id === "privacy-b")?.status).toBe(
      "completed",
    );
    expect(mock.purge).toHaveBeenCalledWith({ organizationId: "org-b", jobId: "gpu-success" });
    expect(mock.removeAsset).toHaveBeenCalledWith({
      organizationId: "org-b",
      assetId: "failed-output-success",
    });
    expect(
      mock.tables.generation_jobs.find((row) => row.id === "gpu-failure")
        ?.inference_delete_completed_at,
    ).toBeNull();
    expect(mock.abandoned).toHaveBeenCalledTimes(1);
    expect(run.logger.warn).toHaveBeenCalledWith("privacy.deletion_pending", {
      requestId: "privacy-a",
    });
  });
});

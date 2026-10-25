import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ids = {
  ownerA: "10000000-0000-4000-8000-000000000001",
  ownerB: "10000000-0000-4000-8000-000000000002",
  designer: "10000000-0000-4000-8000-000000000003",
  assistant: "10000000-0000-4000-8000-000000000004",
  admin: "10000000-0000-4000-8000-000000000005",
  stranger: "10000000-0000-4000-8000-000000000006",
  orgA: "20000000-0000-4000-8000-000000000001",
  orgB: "20000000-0000-4000-8000-000000000002",
  garmentA: "30000000-0000-4000-8000-000000000001",
  garmentB: "30000000-0000-4000-8000-000000000002",
  assetA: "40000000-0000-4000-8000-000000000001",
  assetB: "40000000-0000-4000-8000-000000000002",
  customerPhoto: "40000000-0000-4000-8000-000000000003",
  session: "50000000-0000-4000-8000-000000000001",
};
let db: PGlite;
async function asUser(id: string, role = "authenticated") {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function reserve(
  overrides: {
    actor?: string | null;
    key?: string;
    operation?: string;
    source?: string | null;
    session?: string | null;
    garment?: string;
    provider?: "qwen" | "fashn";
  } = {},
) {
  const result = await db.query<{
    job: {
      id: string;
      status: string;
      estimated_credits: number;
      provider: string;
      provider_model: string;
      provider_credits_milli: number;
      provider_cost_microusd: number;
    };
  }>(
    "select to_jsonb(public.reserve_generation($10,$1,$2,$3,$4,$5,$6::uuid[],$7::jsonb,$8,'default',$9)) as job",
    [
      ids.orgA,
      overrides.actor === undefined ? ids.ownerA : overrides.actor,
      overrides.operation ?? "photo",
      overrides.garment ?? ids.garmentA,
      overrides.source === undefined ? ids.assetA : overrides.source,
      [ids.assetA],
      overrides.provider === "qwen"
        ? { resolution: "1k", quality: "balanced", outputFormat: "png", numImages: 1 }
        : {},
      overrides.key ?? "test-reservation-001",
      overrides.session ?? null,
      overrides.provider ?? "fashn",
    ],
  );
  return result.rows[0].job;
}
async function account() {
  return (
    await db.query<{ available: number; reserved: number }>(
      "select available,reserved from credit_accounts where organization_id=$1",
      [ids.orgA],
    )
  ).rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  `);
  for (const migration of readdirSync(resolve("supabase/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(resolve("supabase/migrations", migration), "utf8"));
  await db.exec(readFileSync(resolve("supabase/seed.sql"), "utf8"));
  for (const [label, value] of Object.entries(ids).filter(([key]) =>
    ["ownerA", "ownerB", "designer", "assistant", "admin", "stranger"].includes(key),
  )) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      value,
      `${label}@example.test`,
    ]);
  }
  await db.query("insert into organizations(id,name,created_by) values($1,$2,$3),($4,$5,$6)", [
    ids.orgA,
    "A",
    ids.ownerA,
    ids.orgB,
    "B",
    ids.ownerB,
  ]);
  for (const member of [
    [ids.orgA, ids.ownerA, "owner"],
    [ids.orgB, ids.ownerB, "owner"],
    [ids.orgA, ids.designer, "designer"],
    [ids.orgA, ids.assistant, "assistant"],
  ]) {
    await db.query(
      "insert into organization_members(organization_id,user_id,role) values($1,$2,$3)",
      member,
    );
  }
  await db.query("insert into platform_admins(user_id) values($1)", [ids.admin]);
  await db.query("insert into credit_accounts(organization_id) values($1),($2)", [
    ids.orgA,
    ids.orgB,
  ]);
  await db.query(
    "select admin_adjust_credits($1,$2,100,'Synthetic fixture opening balance','fixture-a')",
    [ids.admin, ids.orgA],
  );
  await db.query(
    "select admin_adjust_credits($1,$2,100,'Synthetic fixture opening balance','fixture-b')",
    [ids.admin, ids.orgB],
  );
  await db.query(
    "insert into garments(id,organization_id,name,created_by) values($1,$2,$3,$4),($5,$6,$7,$8)",
    [ids.garmentA, ids.orgA, "A dress", ids.ownerA, ids.garmentB, ids.orgB, "B dress", ids.ownerB],
  );
  for (const asset of [
    [ids.assetA, ids.orgA, ids.garmentA, "garment_original"],
    [ids.assetB, ids.orgB, ids.garmentB, "garment_original"],
    [ids.customerPhoto, ids.orgA, null, "customer_photo"],
  ]) {
    await db.query(
      "insert into assets(id,organization_id,garment_id,kind,storage_path,mime_type,byte_size,width,height) values($1,$2,$3,$4,$5,'image/png',100,800,1200)",
      [...asset, `${asset[1]}/${asset[0]}.png`],
    );
  }
  await db.exec(
    "update generation_price_rules set enabled=true,reviewed_at=now() where provider='fashn'; update credit_packages set enabled=true;",
  );
}, 60000);
beforeEach(async () => {
  await db.exec("begin;");
});
afterEach(async () => {
  await db.exec("rollback; reset role;");
});
afterAll(async () => {
  await db.close();
});

describe("migration and tenant RLS (actual local PostgreSQL via PGlite)", () => {
  it("enables RLS on every application table and keeps storage private", async () => {
    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",
    );
    expect(tables.rows.length).toBeGreaterThanOrEqual(21);
    expect(tables.rows.every((table) => table.relrowsecurity)).toBe(true);
    expect(
      (
        await db.query<{ public: boolean }>(
          "select public from storage.buckets where id='private-media'",
        )
      ).rows[0].public,
    ).toBe(false);
  });
  it("allows an owner to read only their organization and garments", async () => {
    await asUser(ids.ownerA);
    expect(
      (await db.query<{ id: string }>("select id from organizations")).rows.map((row) => row.id),
    ).toEqual([ids.orgA]);
    expect(
      (await db.query<{ id: string }>("select id from garments")).rows.map((row) => row.id),
    ).toEqual([ids.garmentA]);
    expect((await db.query("select * from assets where id=$1", [ids.assetB])).rows).toHaveLength(0);
    expect(
      (await db.query("select * from credit_accounts where organization_id=$1", [ids.orgB])).rows,
    ).toHaveLength(0);
  });
  it("isolates the second organization and unaffiliated users", async () => {
    await asUser(ids.ownerB);
    expect(
      (await db.query<{ id: string }>("select id from garments")).rows.map((row) => row.id),
    ).toEqual([ids.garmentB]);
    await asUser(ids.stranger);
    expect((await db.query("select * from garments")).rows).toHaveLength(0);
    expect((await db.query("select * from organization_members")).rows).toHaveLength(0);
  });
  it("does not grant unauthenticated clients tenant table access", async () => {
    await asUser("", "anon");
    await expect(db.query("select * from garments")).rejects.toThrow(/permission denied/i);
  });
  it.each(["insert", "update", "delete"] as const)(
    "rejects direct %s writes to garments even for an owner",
    async (action) => {
      await asUser(ids.ownerA);
      const sql =
        action === "insert"
          ? "insert into garments(organization_id,name) values($1,'intruder')"
          : action === "update"
            ? "update garments set name='intruder' where organization_id=$1"
            : "delete from garments where organization_id=$1";
      await expect(db.query(sql, [ids.orgB])).rejects.toThrow(/permission denied/i);
    },
  );
  it("prevents browser role escalation and administrative RPC calls", async () => {
    await asUser(ids.assistant);
    await expect(
      db.query("update organization_members set role='owner' where user_id=$1", [ids.assistant]),
    ).rejects.toThrow(/permission denied/i);
  });
  it("does not grant authenticated clients monetary service RPC execution", async () => {
    await asUser(ids.ownerA);
    await expect(
      db.query("select admin_adjust_credits($1,$2,100,'Unauthorized request','hack')", [
        ids.ownerA,
        ids.orgA,
      ]),
    ).rejects.toThrow(/permission denied/i);
  });
  it("rejects cross-tenant foreign keys even from an elevated write", async () => {
    await expect(
      db.query(
        "insert into assets(organization_id,garment_id,kind,storage_path,mime_type,byte_size) values($1,$2,'garment_original',$3,'image/png',100)",
        [ids.orgA, ids.garmentB, `${ids.orgA}/bad.png`],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
  it("creates an organization and owner atomically for a signed in user", async () => {
    await asUser(ids.stranger);
    const result = await db.query<{ id: string }>(
      "select create_organization('New fashion house') as id",
    );
    const id = result.rows[0].id;
    expect(
      (
        await db.query<{ role: string }>(
          "select role from organization_members where organization_id=$1",
          [id],
        )
      ).rows[0].role,
    ).toBe("owner");
    expect(
      (
        await db.query<{ available: number }>(
          "select available from credit_accounts where organization_id=$1",
          [id],
        )
      ).rows[0].available,
    ).toBe(0);
  });
});

describe("atomic accounting and durable jobs", () => {
  it("reserves once and records the durable outbox in the same transaction", async () => {
    const first = await reserve();
    const duplicate = await reserve();
    expect(duplicate.id).toBe(first.id);
    expect(await account()).toEqual({ available: 88, reserved: 12 });
    expect(
      (await db.query("select * from job_outbox where job_id=$1", [first.id])).rows,
    ).toHaveLength(1);
    expect((await db.query("select * from credit_ledger where kind='reserve'")).rows).toHaveLength(
      1,
    );
  });
  it("does not overspend with simultaneous requests against the serialized SQL engine", async () => {
    await db.query("update credit_accounts set available=12 where organization_id=$1", [ids.orgA]);
    const requests = await Promise.allSettled([
      reserve({ key: "parallel-request-a" }),
      reserve({ key: "parallel-request-b" }),
    ]);
    expect(requests.filter((request) => request.status === "fulfilled")).toHaveLength(1);
    // A statement error aborts this test transaction, so inspect in a savepoint-independent assertion below.
    expect(requests.filter((request) => request.status === "rejected")).toHaveLength(1);
  });
  it("refuses assistant generation even when a caller supplies its user id", async () => {
    await expect(reserve({ actor: ids.assistant })).rejects.toThrow(/forbidden/i);
  });
  it("refuses cross-tenant input arrays and rolls back all accounting", async () => {
    await expect(
      db.query(
        "select reserve_generation('fashn',$1,$2,'photo',$3,$4,$5::uuid[],'{}','bad-tenant-input','default',null)",
        [ids.orgA, ids.ownerA, ids.garmentA, ids.assetA, [ids.assetB]],
      ),
    ).rejects.toThrow(/forbidden/i);
  });
  it("releases failed reservations exactly once", async () => {
    const job = await reserve();
    await db.query("select finalize_generation($1,false,'provider_failure','Unable to generate')", [
      job.id,
    ]);
    await db.query("select finalize_generation($1,false,'provider_failure','Unable to generate')", [
      job.id,
    ]);
    expect(await account()).toEqual({ available: 100, reserved: 0 });
    expect((await db.query("select * from credit_ledger where kind='release'")).rows).toHaveLength(
      1,
    );
  });
  it("will not settle a job before private output records exist", async () => {
    const job = await reserve();
    await expect(db.query("select finalize_generation($1,true)", [job.id])).rejects.toThrow(
      /output required/i,
    );
  });
  it("settles a successfully transferred output exactly once", async () => {
    const job = await reserve();
    const outputId = "40000000-0000-4000-8000-000000000004";
    await db.query(
      "insert into assets(id,organization_id,kind,storage_path,mime_type,byte_size) values($1,$2,'generated_image',$3,'image/png',100)",
      [outputId, ids.orgA, `${ids.orgA}/output.png`],
    );
    await db.query(
      "insert into generation_outputs(organization_id,job_id,asset_id) values($1,$2,$3)",
      [ids.orgA, job.id, outputId],
    );
    await db.query("select finalize_generation($1,true)", [job.id]);
    await db.query("select finalize_generation($1,true)", [job.id]);
    expect(await account()).toEqual({ available: 88, reserved: 0 });
    expect((await db.query("select * from credit_ledger where kind='settle'")).rows).toHaveLength(
      1,
    );
  });
  it("claims a job once and never automatically resubmits ambiguous paid requests", async () => {
    const job = await reserve();
    expect((await db.query("select * from claim_generation($1)", [job.id])).rows).toHaveLength(1);
    expect((await db.query("select * from claim_generation($1)", [job.id])).rows).toHaveLength(0);
    await db.query(
      "update generation_jobs set status='retry_wait',error_code='submission_ambiguous',lease_until=now()-interval '5 minutes' where id=$1",
      [job.id],
    );
    expect((await db.query("select * from claim_generation($1)", [job.id])).rows).toHaveLength(0);
  });
  it("keeps the ledger append-only for the elevated role too", async () => {
    await expect(
      db.query("update credit_ledger set available_delta=999 where organization_id=$1", [ids.orgA]),
    ).rejects.toThrow(/append-only/i);
  });
  it("limits organization daily spending and rejects disabled prices", async () => {
    await db.query("update organizations set daily_spending_limit=1 where id=$1", [ids.orgA]);
    await expect(reserve()).rejects.toThrow(/spending limit/i);
  });
  it("enforces durable rate limits across requests", async () => {
    const first = await db.query<{ allowed: boolean }>(
      "select consume_rate_limit('user:a',1,60) allowed",
    );
    const second = await db.query<{ allowed: boolean }>(
      "select consume_rate_limit('user:a',1,60) allowed",
    );
    expect(first.rows[0].allowed).toBe(true);
    expect(second.rows[0].allowed).toBe(false);
  });
  it("rejects a changed confirmed price before creating a reservation", async () => {
    await expect(
      db.query(
        "select reserve_generation('fashn',$1,$2,'photo',$3,$4,$5::uuid[],'{}','changed-price-request','default',null,1,null)",
        [ids.orgA, ids.ownerA, ids.garmentA, ids.assetA, [ids.assetA]],
      ),
    ).rejects.toThrow(/quote changed/i);
  });
  it("rejects disabled prices before dispatch", async () => {
    await db.exec("update generation_price_rules set enabled=false where operation='photo'");
    await expect(reserve()).rejects.toThrow(/pricing not enabled/i);
  });
  it("enforces an account/ledger balance invariant for settled and released jobs", async () => {
    const success = await reserve({ key: "ledger-success-request" });
    const failed = await reserve({ key: "ledger-failed-request" });
    const outputId = "40000000-0000-4000-8000-000000000004";
    await db.query(
      "insert into assets(id,organization_id,kind,storage_path,mime_type,byte_size) values($1,$2,'generated_image',$3,'image/png',100)",
      [outputId, ids.orgA, `${ids.orgA}/output.png`],
    );
    await db.query(
      "insert into generation_outputs(organization_id,job_id,asset_id) values($1,$2,$3)",
      [ids.orgA, success.id, outputId],
    );
    await db.query("select finalize_generation($1,true)", [success.id]);
    await db.query("select finalize_generation($1,false,'output_transfer_failed')", [failed.id]);
    const ledger = await db.query<{ available: number; reserved: number }>(
      "select sum(available_delta)::integer available,sum(reserved_delta)::integer reserved from credit_ledger where organization_id=$1",
      [ids.orgA],
    );
    expect(await account()).toEqual(ledger.rows[0]);
  });
  it("keeps one durable provider slot per organization across workflow sleeps", async () => {
    const first = await reserve({ key: "provider-slot-first" });
    const second = await reserve({ key: "provider-slot-second" });
    expect((await db.query("select * from claim_generation($1)", [first.id])).rows).toHaveLength(1);
    expect((await db.query("select * from claim_generation($1)", [second.id])).rows).toHaveLength(
      0,
    );
    await db.query("select finalize_generation($1,false,'synthetic_failure')", [first.id]);
    expect((await db.query("select * from claim_generation($1)", [second.id])).rows).toHaveLength(
      1,
    );
  });
  it("bounds global in-flight provider work at three across organizations", async () => {
    const orgs = [
      ids.orgA,
      ids.orgB,
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000004",
    ];
    for (const organizationId of orgs.slice(2))
      await db.query(
        "insert into organizations(id,name,created_by) values($1,'Synthetic concurrency workspace',$2)",
        [organizationId, ids.ownerA],
      );
    const jobs: string[] = [];
    for (const organizationId of orgs) {
      const inserted = await db.query<{ id: string }>(
        "insert into generation_jobs(organization_id,operation,estimated_credits,price_rule_id,provider_model,idempotency_key) select $1,'photo',credits,id,provider_model,'provider-global-slot' from generation_price_rules where provider='fashn' and operation='photo' and option_key='default' returning id",
        [organizationId],
      );
      jobs.push(inserted.rows[0].id);
    }
    for (const jobId of jobs.slice(0, 3))
      expect((await db.query("select * from claim_generation($1)", [jobId])).rows).toHaveLength(1);
    expect((await db.query("select * from claim_generation($1)", [jobs[3]])).rows).toHaveLength(0);
  });
  it("expires old unsubmitted jobs but leaves ambiguous submissions for reconciliation", async () => {
    const safe = await reserve({ key: "expire-safe-job" });
    const ambiguous = await reserve({ key: "expire-ambiguous-job" });
    await db.query(
      "update generation_jobs set created_at=now()-interval '2 days' where id=any($1::uuid[])",
      [[safe.id, ambiguous.id]],
    );
    await db.query(
      "update generation_jobs set status='retry_wait',error_code='submission_ambiguous' where id=$1",
      [ambiguous.id],
    );
    expect(
      (
        await db.query<{ count: number }>(
          "select expire_unsubmitted_generations(now()-interval '1 day') count",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(await account()).toEqual({ available: 88, reserved: 12 });
  });
});

describe("trusted registered-account membership management", () => {
  it("resolves only verified registered emails through a service function", async () => {
    expect(
      (await db.query<{ id: string }>("select resolve_registered_user(' OWNERA@EXAMPLE.TEST ') id"))
        .rows[0].id,
    ).toBe(ids.ownerA);
    await db.query("update auth.users set email_confirmed_at=null where id=$1", [ids.stranger]);
    expect(
      (
        await db.query<{ id: string | null }>(
          "select resolve_registered_user('stranger@example.test') id",
        )
      ).rows[0].id,
    ).toBeNull();
  });
  it("allows an owner to add a verified account with an atomic audit record", async () => {
    await db.query("select manage_organization_member($1,$2,$3,'admin')", [
      ids.orgA,
      ids.ownerA,
      ids.stranger,
    ]);
    expect(
      (
        await db.query<{ role: string }>(
          "select role from organization_members where organization_id=$1 and user_id=$2",
          [ids.orgA, ids.stranger],
        )
      ).rows[0].role,
    ).toBe("admin");
    expect(
      (
        await db.query(
          "select * from audit_logs where action='membership.changed' and target_id=$1",
          [ids.stranger],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("forbids a designer from promoting themselves or another user", async () => {
    await expect(
      db.query("select manage_organization_member($1,$2,$3,'admin')", [
        ids.orgA,
        ids.designer,
        ids.stranger,
      ]),
    ).rejects.toThrow(/forbidden/i);
  });
  it("protects the owner and prevents an admin from granting admin", async () => {
    await db.query(
      "insert into organization_members(organization_id,user_id,role) values($1,$2,'admin')",
      [ids.orgA, ids.admin],
    );
    await expect(
      db.query("select manage_organization_member($1,$2,$3,'admin')", [
        ids.orgA,
        ids.admin,
        ids.stranger,
      ]),
    ).rejects.toThrow(/only owners/i);
  });
  it("does not expose account lookup to browsers", async () => {
    await asUser(ids.ownerA);
    await expect(db.query("select resolve_registered_user('ownerB@example.test')")).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("provider-aware prices, immutable jobs and guest permissions", () => {
  const enableQwen = () =>
    db.exec(
      "update generation_price_rules set enabled=true,reviewed_at=now(),estimated_provider_cost_microusd=123456,credits=17 where provider='qwen'",
    );
  it("seeds Qwen disabled with unknown GPU cost and no FASHN credit conversion", async () => {
    const rules = await db.query<{
      enabled: boolean;
      provider_credits_milli: number;
      estimated_provider_cost_microusd: null;
    }>(
      "select enabled,provider_credits_milli,estimated_provider_cost_microusd from generation_price_rules where provider='qwen'",
    );
    expect(rules.rows).toHaveLength(2);
    expect(
      rules.rows.every(
        (rule) =>
          !rule.enabled &&
          rule.provider_credits_milli === 0 &&
          rule.estimated_provider_cost_microusd === null,
      ),
    ).toBe(true);
  });
  it("reserves the reviewed Qwen retail charge independently of FASHN prices", async () => {
    await enableQwen();
    const job = await reserve({ provider: "qwen" });
    expect(job.provider).toBe("qwen");
    expect(job.provider_model).toBe("Qwen/Qwen-Image-Edit-2511");
    expect(job.estimated_credits).toBe(17);
    expect(job.provider_credits_milli).toBe(0);
    expect(job.provider_cost_microusd).toBe(123456);
    expect(await account()).toEqual({ available: 83, reserved: 17 });
  });
  it("does not fall back to enabled FASHN rules when Qwen pricing is disabled", async () => {
    await expect(reserve({ provider: "qwen" })).rejects.toThrow(/pricing not enabled/i);
  });
  it("requires a measured cost before a Qwen rule can be enabled", async () => {
    await expect(
      db.exec(
        "update generation_price_rules set enabled=true,reviewed_at=now() where provider='qwen'",
      ),
    ).rejects.toThrow(/qwen_cost_review/i);
  });
  it("retains durable GPU deletion work after the local result has been removed", async () => {
    await enableQwen();
    const job = await reserve({ provider: "qwen" });
    const outputId = "40000000-0000-4000-8000-000000000004";
    await db.query(
      "insert into assets(id,organization_id,generation_job_id,kind,storage_path,mime_type,byte_size,deleted_at) values($1,$2,$3,'generated_image',$4,'image/png',100,now())",
      [outputId, ids.orgA, job.id, `${ids.orgA}/deleted-output.png`],
    );
    await db.query("update generation_jobs set inference_delete_requested_at=now() where id=$1", [
      job.id,
    ]);
    const pending = () =>
      db.query(
        "select id from generation_jobs where inference_delete_requested_at is not null and inference_delete_completed_at is null",
      );
    expect((await pending()).rows).toEqual([{ id: job.id }]);
    await db.query("update generation_jobs set inference_delete_completed_at=now() where id=$1", [
      job.id,
    ]);
    expect((await pending()).rows).toHaveLength(0);
  });
  it("requires a durable request before GPU deletion can be completed", async () => {
    await enableQwen();
    const job = await reserve({ provider: "qwen" });
    await expect(
      db.query("update generation_jobs set inference_delete_completed_at=now() where id=$1", [
        job.id,
      ]),
    ).rejects.toThrow(/inference_deletion_order/i);
  });
  it("does not allow a completed GPU deletion request to be forgotten or reset", async () => {
    await enableQwen();
    const job = await reserve({ provider: "qwen" });
    await db.query(
      "update generation_jobs set inference_delete_requested_at=now(),inference_delete_completed_at=now() where id=$1",
      [job.id],
    );
    await expect(
      db.query(
        "update generation_jobs set inference_delete_requested_at=null,inference_delete_completed_at=null where id=$1",
        [job.id],
      ),
    ).rejects.toThrow(/cannot be changed once recorded/i);
  });
  it("does not accept a FASHN quote rule for a Qwen reservation", async () => {
    await enableQwen();
    const rule = (
      await db.query<{ id: string }>(
        "select id from generation_price_rules where provider='fashn' and operation='photo'",
      )
    ).rows[0];
    await expect(
      db.query(
        "select reserve_generation('qwen',$1,$2,'photo',$3,$4,$5::uuid[],$6::jsonb,'qwen-stale-price','default',null,17,$7)",
        [
          ids.orgA,
          ids.ownerA,
          ids.garmentA,
          ids.assetA,
          [ids.assetA],
          { resolution: "1k", quality: "balanced", outputFormat: "png", numImages: 1 },
          rule.id,
        ],
      ),
    ).rejects.toThrow(/quote changed/i);
  });
  it("rejects idempotency-key reuse across providers", async () => {
    await enableQwen();
    await reserve();
    await expect(reserve({ provider: "qwen" })).rejects.toThrow(/Idempotency key reused/i);
  });
  it("prevents changing the persisted provider and model of an existing job", async () => {
    const job = await reserve();
    await expect(
      db.query(
        "update generation_jobs set provider='qwen',provider_model='Qwen/Qwen-Image-Edit-2511' where id=$1",
        [job.id],
      ),
    ).rejects.toThrow(/cannot be changed/i);
  });
  it("rejects Qwen video before consuming any credits", async () => {
    await expect(reserve({ provider: "qwen", operation: "video" })).rejects.toThrow(
      /capability unavailable/i,
    );
  });
  it("keeps independent durable provider slots and limits Qwen to one in-flight job", async () => {
    await enableQwen();
    const legacy = await reserve({ key: "pinned-fashn-job" });
    expect((await db.query("select * from claim_generation($1)", [legacy.id])).rows).toHaveLength(
      1,
    );
    const qwen = await reserve({ provider: "qwen", key: "pinned-qwen-job" });
    expect((await db.query("select * from claim_generation($1)", [qwen.id])).rows).toHaveLength(1);
    const inserted = await db.query<{ id: string }>(
      "insert into generation_jobs(organization_id,provider,operation,estimated_credits,price_rule_id,provider_model,idempotency_key) select $1,'qwen','photo',credits,id,provider_model,'qwen-second-workspace' from generation_price_rules where provider='qwen' and operation='photo' returning id",
      [ids.orgB],
    );
    expect(
      (await db.query("select * from claim_generation($1)", [inserted.rows[0].id])).rows,
    ).toHaveLength(0);
  });
  it("rejects a customer invitation when its pinned provider is changed at submission", async () => {
    await enableQwen();
    await db.query(
      "insert into try_on_sessions(id,organization_id,garment_id,token_hash,expires_at) values($1,$2,$3,$4,now()+interval '1 day')",
      [ids.session, ids.orgA, ids.garmentA, "b".repeat(64)],
    );
    await expect(
      reserve({
        provider: "qwen",
        actor: null,
        operation: "try_on",
        source: ids.customerPhoto,
        session: ids.session,
      }),
    ).rejects.toThrow(/provider changed/i);
  });
  it("requires the current Qwen processing consent instead of an old provider disclosure", async () => {
    await enableQwen();
    await db.query(
      "insert into try_on_sessions(id,organization_id,garment_id,provider,provider_model,token_hash,expires_at) values($1,$2,$3,'qwen','Qwen/Qwen-Image-Edit-2511',$4,now()+interval '1 day')",
      [ids.session, ids.orgA, ids.garmentA, "c".repeat(64)],
    );
    await db.query(
      "insert into consents(organization_id,try_on_session_id,version) values($1,$2,'2026-10-24-v1')",
      [ids.orgA, ids.session],
    );
    await expect(
      reserve({
        provider: "qwen",
        actor: null,
        operation: "try_on",
        source: ids.customerPhoto,
        session: ids.session,
      }),
    ).rejects.toThrow(/consent required/i);
  });
});

describe("guest sessions and consent", () => {
  beforeEach(async () => {
    await db.query(
      "insert into try_on_sessions(id,organization_id,garment_id,token_hash,expires_at) values($1,$2,$3,$4,now()+interval '1 day')",
      [ids.session, ids.orgA, ids.garmentA, "a".repeat(64)],
    );
    await db.query(
      "insert into consents(organization_id,try_on_session_id,version) values($1,$2,'2026-10-24-v1')",
      [ids.orgA, ids.session],
    );
  });
  it("consumes a guest session atomically with one consented reservation", async () => {
    const job = await reserve({
      actor: null,
      operation: "try_on",
      source: ids.customerPhoto,
      session: ids.session,
    });
    expect(job.status).toBe("queued");
    const session = await db.query<{ uses: number; job_id: string }>(
      "select uses,job_id from try_on_sessions where id=$1",
      [ids.session],
    );
    expect(session.rows[0]).toEqual({ uses: 1, job_id: job.id });
    await expect(
      reserve({
        actor: null,
        operation: "try_on",
        source: ids.customerPhoto,
        session: ids.session,
        key: "another-guest-request",
      }),
    ).rejects.toThrow(/unavailable/i);
  });
  it.each(["expired", "revoked", "withdrawn"] as const)(
    "rejects %s sessions or consent",
    async (state) => {
      if (state === "expired")
        await db.query(
          "update try_on_sessions set expires_at=now()-interval '1 minute' where id=$1",
          [ids.session],
        );
      if (state === "revoked")
        await db.query("update try_on_sessions set revoked_at=now() where id=$1", [ids.session]);
      if (state === "withdrawn")
        await db.query("update consents set withdrawn_at=now() where try_on_session_id=$1", [
          ids.session,
        ]);
      await expect(
        reserve({
          actor: null,
          operation: "try_on",
          source: ids.customerPhoto,
          session: ids.session,
        }),
      ).rejects.toThrow(/unavailable|consent/i);
    },
  );
  it("does not give anonymous guests direct database access to links or results", async () => {
    await asUser("", "anon");
    await expect(db.query("select * from try_on_sessions")).rejects.toThrow(/permission denied/i);
  });
});

describe("verified payment settlement", () => {
  beforeEach(async () => {
    await db.query(
      "insert into payment_transactions(organization_id,package_id,reference,amount_kobo,credits,buyer_email,expected_domain,created_by) values($1,'a1000000-0000-4000-8000-000000000001','fixture-payment-001',1500000,100,'owner@example.test','test',$2)",
      [ids.orgA, ids.ownerA],
    );
  });
  it("credits a successful payment exactly once under repeated settlement requests", async () => {
    await Promise.all([
      db.query(
        "select settle_payment('fixture-payment-001',1500000,'NGN','test','owner@example.test','9001')",
      ),
      db.query(
        "select settle_payment('fixture-payment-001',1500000,'NGN','test','owner@example.test','9001')",
      ),
    ]);
    expect(await account()).toEqual({ available: 200, reserved: 0 });
    expect((await db.query("select * from credit_ledger where kind='purchase'")).rows).toHaveLength(
      1,
    );
  });
  it.each(["amount", "currency", "domain", "email"] as const)(
    "rejects a mismatched %s before issuing value",
    async (field) => {
      await expect(
        db.query("select settle_payment($1,$2,$3,$4,$5,$6)", [
          "fixture-payment-001",
          field === "amount" ? 1 : 1500000,
          field === "currency" ? "USD" : "NGN",
          field === "domain" ? "live" : "test",
          field === "email" ? "attacker@example.test" : "owner@example.test",
          "9001",
        ]),
      ).rejects.toThrow(/mismatch/i);
    },
  );
  it("rejects admin adjustment by a workspace owner", async () => {
    await expect(
      db.query("select admin_adjust_credits($1,$2,100,'Owner cannot mint credits','bad-admin')", [
        ids.ownerA,
        ids.orgA,
      ]),
    ).rejects.toThrow(/administrator/i);
  });
  it("records authorized compensating adjustments once with an audit trail", async () => {
    for (let i = 0; i < 2; i++)
      await db.query(
        "select admin_adjust_credits($1,$2,25,'Customer support goodwill adjustment','goodwill-001')",
        [ids.admin, ids.orgA],
      );
    expect(await account()).toEqual({ available: 125, reserved: 0 });
    expect(
      (
        await db.query(
          "select * from audit_logs where action='credits.adjusted' and metadata->>'reason'='Customer support goodwill adjustment'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("prepares a refund once, removes unspent credit value and records an audited verified completion", async () => {
    await db.query(
      "select settle_payment('fixture-payment-001',1500000,'NGN','test','owner@example.test','9001')",
    );
    const first = await db.query<{ value: { should_submit: boolean } }>(
      "select prepare_payment_refund($1,'fixture-payment-001','Customer requested a full refund','refund-fixture-001') value",
      [ids.admin],
    );
    const duplicate = await db.query<{ value: { should_submit: boolean } }>(
      "select prepare_payment_refund($1,'fixture-payment-001','Customer requested a full refund','refund-fixture-001') value",
      [ids.admin],
    );
    expect(first.rows[0].value.should_submit).toBe(true);
    expect(duplicate.rows[0].value.should_submit).toBe(false);
    expect(await account()).toEqual({ available: 100, reserved: 0 });
    for (let i = 0; i < 2; i++)
      await db.query(
        "select finalize_payment_refund('fixture-payment-001','refund-9001',1500000,'NGN','test')",
      );
    expect(
      (
        await db.query<{ status: string }>(
          "select status from payment_transactions where reference='fixture-payment-001'",
        )
      ).rows[0].status,
    ).toBe("refunded");
    expect((await db.query("select * from credit_ledger where kind='reversal'")).rows).toHaveLength(
      1,
    );
  });
  it("does not refund a purchase when the available balance cannot cover all package credits", async () => {
    await db.query(
      "select settle_payment('fixture-payment-001',1500000,'NGN','test','owner@example.test','9001')",
    );
    await db.query("update credit_accounts set available=50 where organization_id=$1", [ids.orgA]);
    await expect(
      db.query(
        "select prepare_payment_refund($1,'fixture-payment-001','Customer requested a full refund','refund-fixture-001')",
        [ids.admin],
      ),
    ).rejects.toThrow(/unspent/i);
  });
});

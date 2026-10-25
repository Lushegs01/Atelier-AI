import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("upgrades existing FASHN jobs and invitations without rerouting, repricing or changing balances", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now());
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    `);
    await db.exec(readFileSync(resolve("supabase/migrations/202610240001_initial.sql"), "utf8"));
    await db.exec(`
      insert into auth.users(id,email) values('10000000-0000-4000-8000-000000000001','legacy@example.test');
      insert into organizations(id,name,created_by) values('20000000-0000-4000-8000-000000000001','Legacy workspace','10000000-0000-4000-8000-000000000001');
      insert into credit_accounts(organization_id,available,reserved) values('20000000-0000-4000-8000-000000000001',88,12);
      insert into garments(id,organization_id,name) values('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Legacy garment');
      insert into generation_price_rules(id,operation,credits,provider_model,provider_credits_milli,enabled,reviewed_at) values
        ('40000000-0000-4000-8000-000000000001','photo',12,'product-to-model',2000,true,now()),
        ('40000000-0000-4000-8000-000000000002','try_on',12,'tryon-max',2000,true,now());
      insert into generation_jobs(id,organization_id,operation,status,estimated_credits,price_rule_id,provider_model,provider_reference,idempotency_key) values
        ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','photo','processing',12,'40000000-0000-4000-8000-000000000001','product-to-model','legacy-provider-prediction','legacy-idempotency-key');
      insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,idempotency_key) values
        ('20000000-0000-4000-8000-000000000001','adjustment',100,0,'legacy-opening-balance'),
        ('20000000-0000-4000-8000-000000000001','reserve',-12,12,'legacy-reserve');
      insert into try_on_sessions(id,organization_id,garment_id,token_hash,expires_at,quoted_credits,price_rule_id) values
        ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',repeat('a',64),now()+interval '1 day',12,'40000000-0000-4000-8000-000000000002');
    `);
    await db.exec(
      readFileSync(resolve("supabase/migrations/202610250001_provider_pinning.sql"), "utf8"),
    );
    await db.exec(readFileSync(resolve("supabase/seed.sql"), "utf8"));
    expect(
      (
        await db.query(
          "select provider,provider_model,provider_reference,status,estimated_credits from generation_jobs",
        )
      ).rows[0],
    ).toEqual({
      provider: "fashn",
      provider_model: "product-to-model",
      provider_reference: "legacy-provider-prediction",
      status: "processing",
      estimated_credits: 12,
    });
    expect((await db.query("select available,reserved from credit_accounts")).rows[0]).toEqual({
      available: 88,
      reserved: 12,
    });
    expect(
      (await db.query("select provider,provider_model,quoted_credits from try_on_sessions"))
        .rows[0],
    ).toEqual({ provider: "fashn", provider_model: "tryon-max", quoted_credits: 12 });
    expect((await db.query("select id from credit_ledger")).rows).toHaveLength(2);
    expect(
      (
        await db.query<{ removed: boolean }>(
          "select to_regprocedure('public.reserve_generation(uuid,uuid,text,uuid,uuid,uuid[],jsonb,text,text,uuid,integer,uuid)') is null removed",
        )
      ).rows[0].removed,
    ).toBe(true);
    expect(
      (
        await db.query(
          "select id from generation_price_rules where provider='qwen' and enabled=false and estimated_provider_cost_microusd is null",
        )
      ).rows,
    ).toHaveLength(2);
  } finally {
    await db.close();
  }
}, 60000);

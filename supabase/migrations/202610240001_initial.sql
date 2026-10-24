-- Atelier AI: private, tenant-isolated schema. Monetary writes are service-only RPCs.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '', avatar_url text, onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.organizations (
  id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 100),
  slug text unique, brand_name text, brand_color text not null default '#183952', logo_asset_id uuid,
  created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz,
  daily_spending_limit integer not null default 500 check(daily_spending_limit >= 0)
);
create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check(role in ('owner','admin','designer','assistant')),
  created_at timestamptz not null default now(), primary key(organization_id,user_id)
);
create index members_user_idx on public.organization_members(user_id);
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true, created_at timestamptz not null default now()
);
create table public.garments (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  name text not null check(length(name) between 1 and 120), category text not null default 'dress',
  description text not null default '', collection text, archived_at timestamptz, deleted_at timestamptz,
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id,organization_id)
);
create index garments_org_created_idx on public.garments(organization_id,created_at desc) where deleted_at is null;
create table public.assets (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  garment_id uuid, generation_job_id uuid, kind text not null check(kind in ('original','garment_original','generated_image','generated_video','customer_photo','thumbnail')),
  view text not null default 'front', storage_path text not null unique,
  mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp','video/mp4')),
  byte_size bigint not null check(byte_size > 0 and byte_size <= 209715200), width integer check(width > 0), height integer check(height > 0),
  duration_seconds integer, thumbnail_path text, created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), deleted_at timestamptz, expires_at timestamptz,
  unique(id,organization_id), foreign key(garment_id,organization_id) references public.garments(id,organization_id),
  check(storage_path like organization_id::text || '/%')
);
create index assets_org_garment_idx on public.assets(organization_id,garment_id) where deleted_at is null;
create index assets_expiry_idx on public.assets(expires_at) where expires_at is not null and deleted_at is null;
alter table public.organizations add constraint organization_logo_tenant_fk foreign key(logo_asset_id,id) references public.assets(id,organization_id);
create table public.customers (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  name text not null check(length(name) <= 120), email text, notes text not null default '',
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), deleted_at timestamptz,
  unique(id,organization_id)
);
create index customers_org_idx on public.customers(organization_id,created_at desc);
create table public.credit_accounts (
  organization_id uuid primary key references public.organizations(id),
  available integer not null default 0 check(available >= 0), reserved integer not null default 0 check(reserved >= 0),
  lifetime_purchased integer not null default 0 check(lifetime_purchased >= 0), lifetime_spent integer not null default 0 check(lifetime_spent >= 0),
  updated_at timestamptz not null default now()
);
create table public.credit_packages (
  id uuid primary key default gen_random_uuid(), name text not null, credits integer not null check(credits > 0),
  amount_kobo integer not null check(amount_kobo > 0), currency text not null default 'NGN' check(currency = 'NGN'),
  enabled boolean not null default false, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.generation_price_rules (
  id uuid primary key default gen_random_uuid(), operation text not null check(operation in ('photo','video','try_on')),
  option_key text not null default 'default', credits integer not null check(credits > 0),
  provider_model text not null, provider_credits_milli integer not null check(provider_credits_milli >= 0),
  estimated_provider_cost_microusd bigint check(estimated_provider_cost_microusd >= 0),
  enabled boolean not null default false, reviewed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(operation,option_key)
);
create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  operation text not null check(operation in ('photo','video','try_on')),
  status text not null default 'queued' check(status in ('queued','submitting','processing','retry_wait','succeeded','failed','cancelled')),
  garment_id uuid, source_asset_id uuid, input_asset_ids uuid[] not null default '{}', options jsonb not null default '{}',
  estimated_credits integer not null check(estimated_credits > 0), settled_credits integer not null default 0 check(settled_credits >= 0),
  price_rule_id uuid not null references public.generation_price_rules(id), provider_model text not null,
  provider_reference text unique, provider_cost_microusd bigint, provider_credits_milli integer,
  idempotency_key text not null check(length(idempotency_key) between 8 and 200),
  retry_count integer not null default 0 check(retry_count >= 0), error_code text, error_message text,
  lease_until timestamptz, created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), started_at timestamptz, completed_at timestamptz, updated_at timestamptz not null default now(),
  unique(id,organization_id), unique(organization_id,idempotency_key),
  foreign key(garment_id,organization_id) references public.garments(id,organization_id),
  foreign key(source_asset_id,organization_id) references public.assets(id,organization_id)
);
create index jobs_org_created_idx on public.generation_jobs(organization_id,created_at desc);
create index jobs_active_idx on public.generation_jobs(status,created_at) where status not in ('succeeded','failed','cancelled');
alter table public.assets add constraint assets_generation_job_tenant_fk foreign key(generation_job_id,organization_id) references public.generation_jobs(id,organization_id);
create index assets_generation_job_idx on public.assets(generation_job_id) where generation_job_id is not null;
create table public.generation_outputs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  job_id uuid not null, asset_id uuid not null, approved_at timestamptz, rejected_at timestamptz,
  output_index integer not null default 0 check(output_index >= 0),
  created_at timestamptz not null default now(), unique(job_id,asset_id), unique(job_id,output_index),
  foreign key(job_id,organization_id) references public.generation_jobs(id,organization_id),
  foreign key(asset_id,organization_id) references public.assets(id,organization_id)
);
create index outputs_org_idx on public.generation_outputs(organization_id,created_at desc);
create table public.try_on_sessions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  garment_id uuid not null, token_hash text not null unique check(length(token_hash)=64),
  expires_at timestamptz not null, revoked_at timestamptz, max_uses integer not null default 1 check(max_uses between 1 and 10),
  uses integer not null default 0 check(uses >= 0 and uses <= max_uses),
  job_id uuid, customer_asset_id uuid, customer_id uuid, quoted_credits integer check(quoted_credits>0),
  price_rule_id uuid references public.generation_price_rules(id), created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), deleted_at timestamptz,
  unique(id,organization_id), foreign key(garment_id,organization_id) references public.garments(id,organization_id),
  foreign key(job_id,organization_id) references public.generation_jobs(id,organization_id),
  foreign key(customer_asset_id,organization_id) references public.assets(id,organization_id),
  foreign key(customer_id,organization_id) references public.customers(id,organization_id)
);
create index sessions_org_idx on public.try_on_sessions(organization_id,created_at desc);
create table public.consents (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  try_on_session_id uuid not null, version text not null, purpose text not null default 'virtual_try_on',
  accepted_at timestamptz not null default now(), withdrawn_at timestamptz, created_at timestamptz not null default now(),
  foreign key(try_on_session_id,organization_id) references public.try_on_sessions(id,organization_id)
);
create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  package_id uuid not null references public.credit_packages(id), reference text not null unique,
  provider text not null default 'paystack' check(provider='paystack'), provider_transaction_id text unique,
  amount_kobo integer not null check(amount_kobo > 0), credits integer not null check(credits > 0),
  currency text not null default 'NGN' check(currency='NGN'), expected_domain text not null check(expected_domain in ('test','live')),
  buyer_email text not null, status text not null default 'pending' check(status in ('pending','initialized','success','failed','reversed','refund_pending','refunded')),
  authorization_url text, receipt_number text, paid_at timestamptz, verified_at timestamptz,
  refund_request_key text unique, refund_provider_id text unique, refund_requested_at timestamptz, refunded_at timestamptz,
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id,organization_id)
);
create index payments_org_idx on public.payment_transactions(organization_id,created_at desc);
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  kind text not null check(kind in ('purchase','reserve','settle','release','adjustment','reversal')),
  available_delta integer not null, reserved_delta integer not null,
  job_id uuid, payment_id uuid, idempotency_key text not null, reason text,
  actor_id uuid references auth.users(id), created_at timestamptz not null default now(),
  unique(organization_id,idempotency_key),
  foreign key(job_id,organization_id) references public.generation_jobs(id,organization_id),
  foreign key(payment_id,organization_id) references public.payment_transactions(id,organization_id)
);
create index ledger_org_idx on public.credit_ledger(organization_id,created_at desc);
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(), provider text not null, event_key text not null,
  event_type text not null, reference text, processed_at timestamptz, created_at timestamptz not null default now(),
  unique(provider,event_key)
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id),
  actor_id uuid references auth.users(id), action text not null, target_type text, target_id text,
  metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
create index audit_org_idx on public.audit_logs(organization_id,created_at desc);
create table public.job_outbox (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), job_id uuid not null unique,
  event_type text not null default 'atelier/generation.requested', payload jsonb not null default '{}',
  delivered_at timestamptz, attempts integer not null default 0, available_at timestamptz not null default now(), created_at timestamptz not null default now(),
  foreign key(job_id,organization_id) references public.generation_jobs(id,organization_id)
);
create index outbox_pending_idx on public.job_outbox(available_at) where delivered_at is null;
-- Alias is intentionally not a view: consumers use the job_outbox table.
create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id),
  user_id uuid references auth.users(id), try_on_session_id uuid,
  type text not null check(type in ('delete_account','delete_customer_data','export_data','delete_session','report_problem')),
  reason text, status text not null default 'pending' check(status in ('pending','processing','completed','blocked')),
  created_at timestamptz not null default now(), completed_at timestamptz,
  foreign key(try_on_session_id,organization_id) references public.try_on_sessions(id,organization_id),
  check(try_on_session_id is null or organization_id is not null)
);
create table public.rate_limit_windows (
  key text not null, window_start timestamptz not null, count integer not null default 1, primary key(key,window_start)
);
create table public.media_upload_intents (
  id uuid primary key, organization_id uuid not null references public.organizations(id), storage_paths text[] not null,
  expires_at timestamptz not null default now()+interval '1 hour', committed_at timestamptz, created_at timestamptz not null default now()
);
create index media_upload_intents_expiry_idx on public.media_upload_intents(expires_at) where committed_at is null;

create or replace function public.is_org_member(p_organization_id uuid) returns boolean
language sql stable security definer set search_path = public,pg_temp as $$
  select exists(select 1 from organization_members m join organizations o on o.id=m.organization_id
    where m.organization_id=p_organization_id and m.user_id=auth.uid() and o.deleted_at is null);
$$;
create or replace function public.has_org_role(p_organization_id uuid,p_roles text[]) returns boolean
language sql stable security definer set search_path = public,pg_temp as $$
  select exists(select 1 from organization_members m join organizations o on o.id=m.organization_id
    where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.role=any(p_roles) and o.deleted_at is null);
$$;
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public,pg_temp as $$
  select exists(select 1 from platform_admins where user_id=auth.uid() and active);
$$;

-- Membership management looks up only an already verified account, through the server.
create or replace function public.resolve_registered_user(p_email text) returns uuid
language sql stable security definer set search_path=public,pg_temp as $$
  select id from auth.users where lower(email)=lower(trim(p_email)) and email_confirmed_at is not null limit 1;
$$;

do $$ declare t text; begin
  foreach t in array array['profiles','organizations','organization_members','platform_admins','garments','assets','customers','credit_accounts','credit_packages','generation_price_rules','generation_jobs','generation_outputs','try_on_sessions','consents','payment_transactions','credit_ledger','webhook_events','audit_logs','job_outbox','privacy_requests','rate_limit_windows','media_upload_intents'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
grant usage on schema public to anon,authenticated,service_role;
revoke create on schema public from public,anon,authenticated;
grant select on public.profiles,public.organizations,public.organization_members,public.garments,public.assets,public.customers,
  public.credit_accounts,public.credit_packages,public.generation_price_rules,public.generation_jobs,public.generation_outputs,
  public.try_on_sessions,public.consents,public.payment_transactions,public.credit_ledger,public.audit_logs,public.privacy_requests to authenticated;
revoke select on public.generation_price_rules from authenticated;
grant select(id,operation,option_key,credits,enabled,reviewed_at) on public.generation_price_rules to anon,authenticated;
grant select on public.credit_packages to anon;
grant update(full_name,avatar_url,updated_at) on public.profiles to authenticated;
create policy profiles_self on public.profiles for select to authenticated using(id=auth.uid());
create policy profiles_self_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy organizations_member on public.organizations for select to authenticated using(is_org_member(id));
create policy members_own_org on public.organization_members for select to authenticated using(is_org_member(organization_id));
create policy packages_visible on public.credit_packages for select to anon,authenticated using(true);
create policy prices_visible on public.generation_price_rules for select to anon,authenticated using(true);
do $$ declare t text; begin
  foreach t in array array['garments','assets','customers','credit_accounts','generation_jobs','generation_outputs','try_on_sessions','consents','payment_transactions','credit_ledger','audit_logs'] loop
    execute format('create policy tenant_read on public.%I for select to authenticated using (public.is_org_member(organization_id))',t);
  end loop;
end $$;
create policy privacy_own on public.privacy_requests for select to authenticated using(user_id=auth.uid() or has_org_role(organization_id,array['owner','admin']));

-- New organizations start at zero; no free credits or fabricated activity.
create or replace function public.create_organization(p_name text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if length(trim(p_name)) not between 1 and 100 then raise exception 'Invalid organization name'; end if;
  perform pg_advisory_xact_lock(hashtext(v_uid::text));
  if (select count(*) from organization_members where user_id=v_uid and role='owner') >= 5 then raise exception 'Workspace limit reached'; end if;
  insert into profiles(id) values(v_uid) on conflict(id) do nothing;
  insert into organizations(name,brand_name,created_by) values(trim(p_name),trim(p_name),v_uid) returning id into v_id;
  insert into organization_members values(v_id,v_uid,'owner',now());
  insert into credit_accounts(organization_id) values(v_id);
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id) values(v_id,v_uid,'organization.created','organization',v_id::text);
  return v_id;
end $$;

create or replace function public.manage_organization_member(p_organization_id uuid,p_actor_id uuid,p_user_id uuid,p_role text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor_role text; v_target_role text;
begin
  perform pg_advisory_xact_lock(hashtext('membership:'||p_organization_id::text));
  select m.role into v_actor_role from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=p_organization_id and m.user_id=p_actor_id and o.deleted_at is null;
  if v_actor_role is null or v_actor_role not in ('owner','admin') then raise exception 'Membership management forbidden' using errcode='42501'; end if;
  if p_user_id=p_actor_id then raise exception 'Self role changes are forbidden' using errcode='42501'; end if;
  select role into v_target_role from organization_members where organization_id=p_organization_id and user_id=p_user_id;
  if v_target_role='owner' then raise exception 'Owner membership is protected' using errcode='42501'; end if;
  if p_role is not null and p_role not in ('admin','designer','assistant') then raise exception 'Invalid membership role'; end if;
  if v_actor_role='admin' and (v_target_role='admin' or p_role='admin') then raise exception 'Only owners can manage administrators' using errcode='42501'; end if;
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then raise exception 'A verified registered account is required'; end if;
  if p_role is null then
    delete from organization_members where organization_id=p_organization_id and user_id=p_user_id;
  else
    insert into organization_members(organization_id,user_id,role) values(p_organization_id,p_user_id,p_role)
      on conflict(organization_id,user_id) do update set role=excluded.role;
  end if;
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id,metadata)
    values(p_organization_id,p_actor_id,case when p_role is null then 'membership.removed' else 'membership.changed' end,'user',p_user_id::text,jsonb_build_object('previousRole',v_target_role,'role',p_role));
  return jsonb_build_object('userId',p_user_id,'role',p_role,'removed',p_role is null);
end $$;

-- Every input array element must belong to the tenant; a UUID array cannot have a foreign key.
create or replace function public.reserve_generation(
  p_organization_id uuid,p_actor_id uuid,p_operation text,p_garment_id uuid,p_source_asset_id uuid,
  p_input_asset_ids uuid[],p_options jsonb,p_idempotency_key text,p_option_key text default 'default',p_try_on_session_id uuid default null,
  p_expected_credits integer default null,p_expected_price_rule_id uuid default null
) returns public.generation_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job generation_jobs; v_price generation_price_rules; v_account credit_accounts; v_session try_on_sessions; v_limit integer;
begin
  if p_operation not in ('photo','video','try_on') or length(p_idempotency_key) not between 8 and 200 then raise exception 'Invalid generation'; end if;
  if p_actor_id is not null then
    if not exists(select 1 from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=p_organization_id and m.user_id=p_actor_id and m.role in ('owner','admin','designer') and o.deleted_at is null) then
      raise exception 'Generation forbidden' using errcode='42501';
    end if;
  elsif p_try_on_session_id is null or p_operation <> 'try_on' then raise exception 'Actor required' using errcode='42501'; end if;
  -- One lock serializes balance changes, duplicated requests, spending limits and guests in this organization.
  select * into v_account from credit_accounts where organization_id=p_organization_id for update;
  if not found then raise exception 'Credit account missing'; end if;
  select * into v_job from generation_jobs where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if found then
    if v_job.operation is distinct from p_operation or v_job.garment_id is distinct from p_garment_id or v_job.source_asset_id is distinct from p_source_asset_id or v_job.options is distinct from p_options then raise exception 'Idempotency key reused for a different generation'; end if;
    return v_job;
  end if;
  if p_try_on_session_id is not null then
    select * into v_session from try_on_sessions where id=p_try_on_session_id and organization_id=p_organization_id for update;
    if not found or v_session.revoked_at is not null or v_session.deleted_at is not null or v_session.expires_at<=now() or v_session.uses>=v_session.max_uses then raise exception 'Try-on session unavailable' using errcode='42501'; end if;
    if v_session.garment_id is distinct from p_garment_id or not exists(select 1 from consents where try_on_session_id=v_session.id and withdrawn_at is null) then raise exception 'Consent required' using errcode='42501'; end if;
    if p_source_asset_id is null or not exists(select 1 from assets where id=p_source_asset_id and organization_id=p_organization_id and kind='customer_photo' and deleted_at is null) then raise exception 'Customer photograph required'; end if;
  end if;
  if p_garment_id is not null and not exists(select 1 from garments where id=p_garment_id and organization_id=p_organization_id and deleted_at is null and archived_at is null) then raise exception 'Garment unavailable'; end if;
  if p_source_asset_id is not null and not exists(select 1 from assets where id=p_source_asset_id and organization_id=p_organization_id and deleted_at is null) then raise exception 'Source unavailable'; end if;
  if exists(select 1 from unnest(coalesce(p_input_asset_ids,'{}'::uuid[])) a where not exists(select 1 from assets s where s.id=a and s.organization_id=p_organization_id and s.deleted_at is null)) then raise exception 'Input asset forbidden' using errcode='42501'; end if;
  select * into v_price from generation_price_rules where operation=p_operation and option_key=p_option_key and enabled and reviewed_at is not null for share;
  if not found then raise exception 'Generation pricing not enabled'; end if;
  if (p_expected_credits is not null and p_expected_credits<>v_price.credits) or (p_expected_price_rule_id is not null and p_expected_price_rule_id<>v_price.id)
    or (p_try_on_session_id is not null and ((v_session.quoted_credits is not null and v_session.quoted_credits<>v_price.credits) or (v_session.price_rule_id is not null and v_session.price_rule_id<>v_price.id))) then
    raise exception 'Price quote changed';
  end if;
  if v_account.available < v_price.credits then raise exception 'Insufficient credits' using errcode='P0001'; end if;
  select daily_spending_limit into v_limit from organizations where id=p_organization_id and deleted_at is null;
  if v_limit is null then raise exception 'Organization unavailable'; end if;
  if (select coalesce(sum(estimated_credits),0) from generation_jobs where organization_id=p_organization_id and created_at >= date_trunc('day',now()) and status not in ('failed','cancelled')) + v_price.credits > v_limit then raise exception 'Daily spending limit reached'; end if;
  if (select count(*) from generation_jobs where organization_id=p_organization_id and status not in ('succeeded','failed','cancelled')) >= 5 then raise exception 'Too many active generations'; end if;
  insert into generation_jobs(organization_id,operation,garment_id,source_asset_id,input_asset_ids,options,estimated_credits,price_rule_id,provider_model,provider_credits_milli,provider_cost_microusd,idempotency_key,created_by)
  values(p_organization_id,p_operation,p_garment_id,p_source_asset_id,coalesce(p_input_asset_ids,'{}'),p_options,v_price.credits,v_price.id,v_price.provider_model,v_price.provider_credits_milli,v_price.estimated_provider_cost_microusd,p_idempotency_key,p_actor_id) returning * into v_job;
  update credit_accounts set available=available-v_price.credits,reserved=reserved+v_price.credits,updated_at=now() where organization_id=p_organization_id;
  insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,job_id,idempotency_key,actor_id) values(p_organization_id,'reserve',-v_price.credits,v_price.credits,v_job.id,'reserve:'||v_job.id,p_actor_id);
  insert into job_outbox(organization_id,job_id,payload) values(p_organization_id,v_job.id,jsonb_build_object('jobId',v_job.id,'organizationId',p_organization_id));
  if p_try_on_session_id is not null then update try_on_sessions set uses=uses+1,job_id=v_job.id,customer_asset_id=p_source_asset_id where id=p_try_on_session_id; end if;
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id) values(p_organization_id,p_actor_id,'generation.reserved','generation_job',v_job.id::text);
  return v_job;
end $$;

create or replace function public.finalize_generation(p_job_id uuid,p_success boolean,p_error_code text default null,p_error_message text default null) returns public.generation_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job generation_jobs;
begin
  select * into v_job from generation_jobs where id=p_job_id for update;
  if not found then raise exception 'Generation missing'; end if;
  if v_job.status in ('succeeded','failed','cancelled') then return v_job; end if;
  perform 1 from credit_accounts where organization_id=v_job.organization_id for update;
  if p_success then
    if not exists(select 1 from generation_outputs o join assets a on a.id=o.asset_id and a.organization_id=o.organization_id where o.job_id=p_job_id and a.deleted_at is null and a.kind=case when v_job.operation='video' then 'generated_video' else 'generated_image' end) then raise exception 'Verified output required'; end if;
    update credit_accounts set reserved=reserved-v_job.estimated_credits,lifetime_spent=lifetime_spent+v_job.estimated_credits,updated_at=now() where organization_id=v_job.organization_id;
    insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,job_id,idempotency_key) values(v_job.organization_id,'settle',0,-v_job.estimated_credits,p_job_id,'settle:'||p_job_id);
  else
    update credit_accounts set reserved=reserved-v_job.estimated_credits,available=available+v_job.estimated_credits,updated_at=now() where organization_id=v_job.organization_id;
    insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,job_id,idempotency_key,reason) values(v_job.organization_id,'release',v_job.estimated_credits,-v_job.estimated_credits,p_job_id,'release:'||p_job_id,p_error_code);
  end if;
  update generation_jobs set status=case when p_success then 'succeeded' else 'failed' end,settled_credits=case when p_success then estimated_credits else 0 end,
    completed_at=now(),updated_at=now(),lease_until=null,error_code=p_error_code,error_message=p_error_message where id=p_job_id returning * into v_job;
  return v_job;
end $$;

create or replace function public.claim_generation(p_job_id uuid,p_lease_seconds integer default 90) returns setof public.generation_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_organization_id uuid;
begin
  -- Durable provider slots survive process restarts and workflow sleeps.
  perform pg_advisory_xact_lock(hashtext('atelier_provider_slots'));
  select organization_id into v_organization_id from generation_jobs where id=p_job_id;
  if not found then return; end if;
  if (select count(*) from generation_jobs where status in ('submitting','processing') or (status='retry_wait' and (provider_reference is not null or error_code='submission_ambiguous'))) >= 3 then return; end if;
  if exists(select 1 from generation_jobs where organization_id=v_organization_id and (status in ('submitting','processing') or (status='retry_wait' and (provider_reference is not null or error_code='submission_ambiguous')))) then return; end if;
  return query update generation_jobs set status='submitting',lease_until=now()+make_interval(secs=>least(greatest(p_lease_seconds,30),300)),started_at=coalesce(started_at,now()),updated_at=now()
    where id=p_job_id and status in ('queued','retry_wait') and provider_reference is null and error_code is distinct from 'submission_ambiguous' and (lease_until is null or lease_until<now()) returning *;
end $$;

create or replace function public.expire_unsubmitted_generations(p_older_than timestamptz) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job generation_jobs; v_count integer:=0;
begin
  -- Never accept a future cutoff that could release a just-created reservation.
  if p_older_than>now()-interval '1 hour' then raise exception 'Expiry cutoff must be at least one hour old'; end if;
  for v_job in select * from generation_jobs where status in ('queued','retry_wait') and provider_reference is null
    and error_code is distinct from 'submission_ambiguous' and (lease_until is null or lease_until<now())
    and created_at<p_older_than order by created_at limit 50 for update skip locked loop
    perform finalize_generation(v_job.id,false,'expired_before_submission','Generation was not submitted before its reservation expired.');
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

create or replace function public.settle_payment(p_reference text,p_amount_kobo integer,p_currency text,p_domain text,p_buyer_email text,p_provider_transaction_id text,p_receipt_number text default null) returns public.payment_transactions
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_payment payment_transactions;
begin
  select * into v_payment from payment_transactions where reference=p_reference for update;
  if not found then raise exception 'Unknown payment'; end if;
  if v_payment.amount_kobo<>p_amount_kobo or v_payment.currency<>p_currency or v_payment.expected_domain<>p_domain or lower(v_payment.buyer_email)<>lower(p_buyer_email) then raise exception 'Payment verification mismatch'; end if;
  if v_payment.status='success' then
    if v_payment.provider_transaction_id is distinct from p_provider_transaction_id then raise exception 'Payment identifier mismatch'; end if;
    return v_payment;
  end if;
  if v_payment.status in ('reversed','refund_pending','refunded') then raise exception 'Payment reversed or refunded'; end if;
  if p_provider_transaction_id is null or p_provider_transaction_id='' then raise exception 'Provider transaction required'; end if;
  perform 1 from credit_accounts where organization_id=v_payment.organization_id for update;
  update credit_accounts set available=available+v_payment.credits,lifetime_purchased=lifetime_purchased+v_payment.credits,updated_at=now() where organization_id=v_payment.organization_id;
  if not found then raise exception 'Credit account missing'; end if;
  insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,payment_id,idempotency_key,reason) values(v_payment.organization_id,'purchase',v_payment.credits,0,v_payment.id,'payment:'||v_payment.reference,'Verified Paystack purchase');
  update payment_transactions set status='success',provider_transaction_id=p_provider_transaction_id,receipt_number=p_receipt_number,paid_at=now(),verified_at=now(),updated_at=now() where id=v_payment.id returning * into v_payment;
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id) values(v_payment.organization_id,v_payment.created_by,'payment.settled','payment',v_payment.id::text);
  return v_payment;
end $$;

create or replace function public.admin_adjust_credits(p_admin_id uuid,p_organization_id uuid,p_delta integer,p_reason text,p_idempotency_key text) returns public.credit_accounts
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_account credit_accounts;
begin
  if not exists(select 1 from platform_admins where user_id=p_admin_id and active) then raise exception 'Platform administrator required' using errcode='42501'; end if;
  if p_delta=0 or abs(p_delta::bigint)>100000 or length(trim(p_reason))<10 then raise exception 'Adjustment requires a reason and bounded amount'; end if;
  select * into v_account from credit_accounts where organization_id=p_organization_id for update;
  if not found then raise exception 'Account missing'; end if;
  if exists(select 1 from credit_ledger where organization_id=p_organization_id and idempotency_key='admin:'||p_idempotency_key) then return v_account; end if;
  if v_account.available+p_delta<0 then raise exception 'Adjustment exceeds available balance'; end if;
  update credit_accounts set available=available+p_delta,updated_at=now() where organization_id=p_organization_id returning * into v_account;
  insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,idempotency_key,reason,actor_id) values(p_organization_id,'adjustment',p_delta,0,'admin:'||p_idempotency_key,p_reason,p_admin_id);
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id,metadata) values(p_organization_id,p_admin_id,'credits.adjusted','credit_account',p_organization_id::text,jsonb_build_object('delta',p_delta,'reason',p_reason));
  return v_account;
end $$;

create or replace function public.consume_rate_limit(p_key text,p_limit integer,p_window_seconds integer) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_start timestamptz; v_count integer;
begin
  if p_limit<1 or p_window_seconds<1 then return false; end if;
  v_start:=to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds);
  insert into rate_limit_windows(key,window_start) values(p_key,v_start) on conflict(key,window_start) do update set count=rate_limit_windows.count+1 returning count into v_count;
  return v_count<=p_limit;
end $$;

-- A full refund first removes the package credits. External submission is permitted only
-- to the caller that changed success -> refund_pending. An ambiguous timeout is not retried.
create or replace function public.prepare_payment_refund(p_admin_id uuid,p_reference text,p_reason text,p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_payment payment_transactions; v_account credit_accounts;
begin
  if not exists(select 1 from platform_admins where user_id=p_admin_id and active) then raise exception 'Platform administrator required' using errcode='42501'; end if;
  if length(trim(p_reason))<10 or length(p_idempotency_key)<8 then raise exception 'Refund reason and request key required'; end if;
  select * into v_payment from payment_transactions where reference=p_reference for update;
  if not found then raise exception 'Payment missing'; end if;
  if v_payment.status in ('refund_pending','refunded') then return jsonb_build_object('payment',to_jsonb(v_payment),'should_submit',false); end if;
  if v_payment.status<>'success' then raise exception 'Only verified successful purchases can be refunded'; end if;
  select * into v_account from credit_accounts where organization_id=v_payment.organization_id for update;
  if v_account.available<v_payment.credits then raise exception 'Refund requires all package credits to be unspent'; end if;
  update credit_accounts set available=available-v_payment.credits,updated_at=now() where organization_id=v_payment.organization_id;
  insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,payment_id,idempotency_key,reason,actor_id)
    values(v_payment.organization_id,'reversal',-v_payment.credits,0,v_payment.id,'refund:'||p_idempotency_key,p_reason,p_admin_id);
  update payment_transactions set status='refund_pending',refund_request_key=p_idempotency_key,refund_requested_at=now(),updated_at=now() where id=v_payment.id returning * into v_payment;
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id,metadata) values(v_payment.organization_id,p_admin_id,'payment.refund_requested','payment',v_payment.id::text,jsonb_build_object('reason',p_reason,'requestKey',p_idempotency_key));
  return jsonb_build_object('payment',to_jsonb(v_payment),'should_submit',true);
end $$;

create or replace function public.finalize_payment_refund(p_reference text,p_provider_refund_id text,p_amount_kobo integer,p_currency text,p_domain text) returns public.payment_transactions
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_payment payment_transactions;
begin
  select * into v_payment from payment_transactions where reference=p_reference for update;
  if not found or v_payment.status not in ('refund_pending','refunded') then raise exception 'No refund is pending'; end if;
  if p_amount_kobo<>v_payment.amount_kobo or p_currency<>v_payment.currency or p_domain<>v_payment.expected_domain or p_provider_refund_id is null or (v_payment.refund_provider_id is not null and v_payment.refund_provider_id<>p_provider_refund_id) then raise exception 'Refund verification mismatch'; end if;
  if v_payment.status='refunded' then return v_payment; end if;
  update payment_transactions set status='refunded',refund_provider_id=p_provider_refund_id,refunded_at=now(),updated_at=now() where id=v_payment.id returning * into v_payment;
  insert into audit_logs(organization_id,action,target_type,target_id) values(v_payment.organization_id,'payment.refund_verified','payment',v_payment.id::text);
  return v_payment;
end $$;

create or replace function public.prevent_ledger_mutation() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'Credit ledger is append-only'; end $$;
create trigger credit_ledger_immutable before update or delete on public.credit_ledger for each row execute function public.prevent_ledger_mutation();

-- No function defaults to public execution: service RPCs cannot be called by a browser.
revoke all on all functions in schema public from public,anon,authenticated;
grant execute on function public.is_org_member(uuid),public.has_org_role(uuid,text[]),public.is_platform_admin() to authenticated;
grant execute on function public.create_organization(text) to authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from anon,authenticated;

-- This bucket is private; application signs authorized objects for at most five minutes.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('private-media','private-media',false,209715200,array['image/jpeg','image/png','image/webp','video/mp4'])
on conflict(id) do update set public=false;
-- No anon/authenticated storage policies are installed. All storage access is server-authorized.

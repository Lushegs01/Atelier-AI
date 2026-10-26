-- Hardening for the free Hugging Face Spaces provider (reviewed 26 October 2026).
--
-- 1. A completed Space result is recorded before its bytes are copied, so a failed copy is retried
--    without running inference again. Service role only: no tenant or anonymous access.
-- 2. Guest consent moves to a disclosure that names the public Spaces and their limits.
-- 3. A designer must acknowledge third-party processing before a Hugging Face job is reserved; the
--    acknowledged version is stored on the job and in the audit log.
-- Existing jobs, prices, consents and invitations are unchanged.

create table public.generation_provider_results (
  job_id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  output_url text not null check(length(output_url) <= 2048 and output_url ~ '^https://[a-z0-9-]+\.hf\.space/'),
  created_at timestamptz not null default now(),
  foreign key(job_id,organization_id) references public.generation_jobs(id,organization_id) on delete cascade
);
alter table public.generation_provider_results enable row level security;
revoke all on public.generation_provider_results from anon, authenticated;
grant all on public.generation_provider_results to service_role;

-- Same signature as 202610250002_huggingface_provider.sql with the consent and acknowledgement changes.
create or replace function public.reserve_generation(
  p_provider text,p_organization_id uuid,p_actor_id uuid,p_operation text,p_garment_id uuid,p_source_asset_id uuid,
  p_input_asset_ids uuid[],p_options jsonb,p_idempotency_key text,p_option_key text default 'default',p_try_on_session_id uuid default null,
  p_expected_credits integer default null,p_expected_price_rule_id uuid default null
) returns public.generation_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job generation_jobs; v_price generation_price_rules; v_account credit_accounts; v_session try_on_sessions; v_limit integer; v_consent_version text;
begin
  if p_provider not in ('fashn','qwen','huggingface') or p_provider is null or p_operation not in ('photo','video','try_on') or length(p_idempotency_key) not between 8 and 200 then raise exception 'Invalid generation'; end if;
  if p_provider='qwen' and p_operation='video' then raise exception 'Provider capability unavailable'; end if;
  if p_actor_id is not null then
    if not exists(select 1 from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=p_organization_id and m.user_id=p_actor_id and m.role in ('owner','admin','designer') and o.deleted_at is null) then
      raise exception 'Generation forbidden' using errcode='42501';
    end if;
  elsif p_try_on_session_id is null or p_operation <> 'try_on' then raise exception 'Actor required' using errcode='42501'; end if;
  -- A designer sends photographs to public third-party Spaces only after acknowledging that notice.
  if p_provider='huggingface' and p_actor_id is not null and p_options->>'processingDisclosure' is distinct from '2026-10-26-hf-spaces-v1' then
    raise exception 'Third-party processing acknowledgement required' using errcode='42501';
  end if;
  select * into v_account from credit_accounts where organization_id=p_organization_id for update;
  if not found then raise exception 'Credit account missing'; end if;
  select * into v_job from generation_jobs where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if found then
    if v_job.provider is distinct from p_provider or v_job.operation is distinct from p_operation or v_job.garment_id is distinct from p_garment_id or v_job.source_asset_id is distinct from p_source_asset_id or v_job.options is distinct from p_options then raise exception 'Idempotency key reused for a different generation'; end if;
    return v_job;
  end if;
  if p_try_on_session_id is not null then
    select * into v_session from try_on_sessions where id=p_try_on_session_id and organization_id=p_organization_id for update;
    if not found or v_session.revoked_at is not null or v_session.deleted_at is not null or v_session.expires_at<=now() or v_session.uses>=v_session.max_uses then raise exception 'Try-on session unavailable' using errcode='42501'; end if;
    if v_session.provider<>p_provider then raise exception 'Try-on provider changed'; end if;
    v_consent_version:=case p_provider when 'qwen' then '2026-10-25-qwen-v1' when 'huggingface' then '2026-10-26-huggingface-v2' else '2026-10-24-v1' end;
    if v_session.garment_id is distinct from p_garment_id or not exists(select 1 from consents where try_on_session_id=v_session.id and version=v_consent_version and withdrawn_at is null) then raise exception 'Consent required' using errcode='42501'; end if;
    if p_source_asset_id is null or not exists(select 1 from assets where id=p_source_asset_id and organization_id=p_organization_id and kind='customer_photo' and deleted_at is null) then raise exception 'Customer photograph required'; end if;
  end if;
  if p_garment_id is not null and not exists(select 1 from garments where id=p_garment_id and organization_id=p_organization_id and deleted_at is null and archived_at is null) then raise exception 'Garment unavailable'; end if;
  if p_source_asset_id is not null and not exists(select 1 from assets where id=p_source_asset_id and organization_id=p_organization_id and deleted_at is null) then raise exception 'Source unavailable'; end if;
  if p_provider='qwen' then
    if not exists(select 1 from assets where id=p_source_asset_id and organization_id=p_organization_id and width>=256 and height>=256 and byte_size<=4194304 and deleted_at is null) then raise exception 'Provider source incompatible'; end if;
    if p_garment_id is not null and not exists(select 1 from assets where garment_id=p_garment_id and organization_id=p_organization_id and kind in ('original','garment_original') and view in ('front','mannequin','hanger','flat-lay') and width>=256 and height>=256 and byte_size<=4194304 and deleted_at is null) then raise exception 'Provider source incompatible'; end if;
    if p_options->>'resolution' is distinct from '1k' or p_options->>'quality' is distinct from 'balanced' or p_options->>'outputFormat' is distinct from 'png' or (p_options->>'numImages')::integer is distinct from 1 then raise exception 'Provider options unsupported'; end if;
  end if;
  if p_provider='huggingface' and p_operation<>'video' and coalesce(p_options->>'resolution','1k')<>'1k' then raise exception 'Provider options unsupported'; end if;
  if exists(select 1 from unnest(coalesce(p_input_asset_ids,'{}'::uuid[])) a where not exists(select 1 from assets s where s.id=a and s.organization_id=p_organization_id and s.deleted_at is null)) then raise exception 'Input asset forbidden' using errcode='42501'; end if;
  select * into v_price from generation_price_rules where provider=p_provider and operation=p_operation and option_key=p_option_key and enabled and reviewed_at is not null for share;
  if not found then raise exception 'Generation pricing not enabled'; end if;
  if p_provider='qwen' and v_price.estimated_provider_cost_microusd is null then raise exception 'Provider cost review required'; end if;
  if (p_expected_credits is not null and p_expected_credits<>v_price.credits) or (p_expected_price_rule_id is not null and p_expected_price_rule_id<>v_price.id)
    or (p_try_on_session_id is not null and ((v_session.quoted_credits is not null and v_session.quoted_credits<>v_price.credits) or (v_session.price_rule_id is not null and v_session.price_rule_id<>v_price.id) or v_session.provider_model<>v_price.provider_model)) then
    raise exception 'Price quote changed';
  end if;
  if v_account.available < v_price.credits then raise exception 'Insufficient credits' using errcode='P0001'; end if;
  select daily_spending_limit into v_limit from organizations where id=p_organization_id and deleted_at is null;
  if v_limit is null then raise exception 'Organization unavailable'; end if;
  if (select coalesce(sum(estimated_credits),0) from generation_jobs where organization_id=p_organization_id and created_at >= date_trunc('day',now()) and status not in ('failed','cancelled')) + v_price.credits > v_limit then raise exception 'Daily spending limit reached'; end if;
  if (select count(*) from generation_jobs where organization_id=p_organization_id and status not in ('succeeded','failed','cancelled')) >= 5 then raise exception 'Too many active generations'; end if;
  insert into generation_jobs(organization_id,provider,operation,garment_id,source_asset_id,input_asset_ids,options,estimated_credits,price_rule_id,provider_model,provider_credits_milli,provider_cost_microusd,idempotency_key,created_by)
  values(p_organization_id,p_provider,p_operation,p_garment_id,p_source_asset_id,coalesce(p_input_asset_ids,'{}'),p_options,v_price.credits,v_price.id,v_price.provider_model,v_price.provider_credits_milli,v_price.estimated_provider_cost_microusd,p_idempotency_key,p_actor_id) returning * into v_job;
  update credit_accounts set available=available-v_price.credits,reserved=reserved+v_price.credits,updated_at=now() where organization_id=p_organization_id;
  insert into credit_ledger(organization_id,kind,available_delta,reserved_delta,job_id,idempotency_key,actor_id) values(p_organization_id,'reserve',-v_price.credits,v_price.credits,v_job.id,'reserve:'||v_job.id,p_actor_id);
  insert into job_outbox(organization_id,job_id,payload) values(p_organization_id,v_job.id,jsonb_build_object('jobId',v_job.id,'organizationId',p_organization_id));
  if p_try_on_session_id is not null then update try_on_sessions set uses=uses+1,job_id=v_job.id,customer_asset_id=p_source_asset_id where id=p_try_on_session_id; end if;
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id,metadata) values(p_organization_id,p_actor_id,'generation.reserved','generation_job',v_job.id::text,jsonb_build_object('provider',p_provider,'model',v_price.provider_model,'processingDisclosure',p_options->>'processingDisclosure','consentVersion',v_consent_version));
  return v_job;
end $$;

revoke all on function public.reserve_generation(text,uuid,uuid,text,uuid,uuid,uuid[],jsonb,text,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.reserve_generation(text,uuid,uuid,text,uuid,uuid,uuid[],jsonb,text,text,uuid,integer,uuid) to service_role;

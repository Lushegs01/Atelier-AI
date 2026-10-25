-- Upgrade: preserve existing FASHN jobs/rules; new work explicitly selects a trusted provider.
alter table public.generation_price_rules add column provider text not null default 'fashn' check(provider in ('fashn','qwen'));
alter table public.generation_jobs add column provider text not null default 'fashn' check(provider in ('fashn','qwen'));
-- Persist private GPU erasure independently of local asset deletion and workflow state.
alter table public.generation_jobs add column inference_delete_requested_at timestamptz;
alter table public.generation_jobs add column inference_delete_completed_at timestamptz;
alter table public.generation_jobs add constraint generation_jobs_inference_deletion_order check(inference_delete_completed_at is null or (inference_delete_requested_at is not null and inference_delete_completed_at>=inference_delete_requested_at));
alter table public.generation_jobs add constraint generation_jobs_private_inference_deletion_only check(inference_delete_requested_at is null or provider='qwen');
create index generation_jobs_pending_inference_deletion_idx on public.generation_jobs(inference_delete_requested_at) where inference_delete_requested_at is not null and inference_delete_completed_at is null;
alter table public.try_on_sessions add column provider text not null default 'fashn' check(provider in ('fashn','qwen'));
alter table public.try_on_sessions add column provider_model text not null default 'tryon-max';

alter table public.generation_price_rules drop constraint generation_price_rules_operation_option_key_key;
alter table public.generation_price_rules add constraint generation_price_rules_provider_operation_option_key_key unique(provider,operation,option_key);
alter table public.generation_price_rules add constraint generation_price_rules_id_provider_model_key unique(id,provider,provider_model);
alter table public.generation_price_rules add constraint generation_price_rules_qwen_images_only check(provider<>'qwen' or operation in ('photo','try_on'));
alter table public.generation_price_rules add constraint generation_price_rules_qwen_cost_review check(provider<>'qwen' or not enabled or (reviewed_at is not null and estimated_provider_cost_microusd is not null));
alter table public.generation_price_rules add constraint generation_price_rules_qwen_no_fashn_credits check(provider<>'qwen' or provider_credits_milli=0);
alter table public.generation_jobs add constraint generation_jobs_rule_provider_model_fk foreign key(price_rule_id,provider,provider_model) references public.generation_price_rules(id,provider,provider_model);
alter table public.generation_jobs add constraint generation_jobs_qwen_images_only check(provider<>'qwen' or operation in ('photo','try_on'));
alter table public.try_on_sessions add constraint try_on_sessions_rule_provider_model_fk foreign key(price_rule_id,provider,provider_model) references public.generation_price_rules(id,provider,provider_model);
grant select(provider) on public.generation_price_rules to anon,authenticated;
create index generation_jobs_provider_status_idx on public.generation_jobs(provider,status,created_at) where status not in ('succeeded','failed','cancelled');

-- Remove the unpinned RPC, so an old server cannot accidentally price a new provider as FASHN.
drop function public.reserve_generation(uuid,uuid,text,uuid,uuid,uuid[],jsonb,text,text,uuid,integer,uuid);
create function public.reserve_generation(
  p_provider text,p_organization_id uuid,p_actor_id uuid,p_operation text,p_garment_id uuid,p_source_asset_id uuid,
  p_input_asset_ids uuid[],p_options jsonb,p_idempotency_key text,p_option_key text default 'default',p_try_on_session_id uuid default null,
  p_expected_credits integer default null,p_expected_price_rule_id uuid default null
) returns public.generation_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job generation_jobs; v_price generation_price_rules; v_account credit_accounts; v_session try_on_sessions; v_limit integer; v_consent_version text;
begin
  if p_provider not in ('fashn','qwen') or p_provider is null or p_operation not in ('photo','video','try_on') or length(p_idempotency_key) not between 8 and 200 then raise exception 'Invalid generation'; end if;
  if p_provider='qwen' and p_operation='video' then raise exception 'Provider capability unavailable'; end if;
  if p_actor_id is not null then
    if not exists(select 1 from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=p_organization_id and m.user_id=p_actor_id and m.role in ('owner','admin','designer') and o.deleted_at is null) then
      raise exception 'Generation forbidden' using errcode='42501';
    end if;
  elsif p_try_on_session_id is null or p_operation <> 'try_on' then raise exception 'Actor required' using errcode='42501'; end if;
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
    v_consent_version:=case when p_provider='qwen' then '2026-10-25-qwen-v1' else '2026-10-24-v1' end;
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
  insert into audit_logs(organization_id,actor_id,action,target_type,target_id,metadata) values(p_organization_id,p_actor_id,'generation.reserved','generation_job',v_job.id::text,jsonb_build_object('provider',p_provider,'model',v_price.provider_model));
  return v_job;
end $$;

create or replace function public.claim_generation(p_job_id uuid,p_lease_seconds integer default 90) returns setof public.generation_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_organization_id uuid; v_provider text; v_limit integer;
begin
  select organization_id,provider into v_organization_id,v_provider from generation_jobs where id=p_job_id;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtext('atelier_provider_slots:'||v_provider));
  v_limit:=case when v_provider='qwen' then 1 else 3 end;
  if (select count(*) from generation_jobs where provider=v_provider and (status in ('submitting','processing') or (status='retry_wait' and (provider_reference is not null or error_code='submission_ambiguous')))) >= v_limit then return; end if;
  if exists(select 1 from generation_jobs where organization_id=v_organization_id and provider=v_provider and (status in ('submitting','processing') or (status='retry_wait' and (provider_reference is not null or error_code='submission_ambiguous')))) then return; end if;
  return query update generation_jobs set status='submitting',lease_until=now()+make_interval(secs=>least(greatest(p_lease_seconds,30),300)),started_at=coalesce(started_at,now()),updated_at=now()
    where id=p_job_id and status in ('queued','retry_wait') and provider_reference is null and error_code is distinct from 'submission_ambiguous' and (lease_until is null or lease_until<now()) returning *;
end $$;

create function public.prevent_generation_provider_change() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.provider is distinct from old.provider or new.provider_model is distinct from old.provider_model or new.price_rule_id is distinct from old.price_rule_id then raise exception 'A generation provider and quoted model cannot be changed'; end if;
  if (old.inference_delete_requested_at is not null and new.inference_delete_requested_at is distinct from old.inference_delete_requested_at) or (old.inference_delete_completed_at is not null and new.inference_delete_completed_at is distinct from old.inference_delete_completed_at) then raise exception 'Inference deletion timestamps cannot be changed once recorded'; end if;
  return new;
end $$;
create trigger generation_provider_immutable before update on public.generation_jobs for each row execute function public.prevent_generation_provider_change();
create function public.prevent_try_on_provider_change() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.provider is distinct from old.provider or new.provider_model is distinct from old.provider_model or new.price_rule_id is distinct from old.price_rule_id or new.quoted_credits is distinct from old.quoted_credits then raise exception 'A customer invitation provider and quoted price cannot be changed'; end if;
  return new;
end $$;
create trigger try_on_provider_immutable before update on public.try_on_sessions for each row execute function public.prevent_try_on_provider_change();
revoke all on function public.reserve_generation(text,uuid,uuid,text,uuid,uuid,uuid[],jsonb,text,text,uuid,integer,uuid) from public,anon,authenticated;
revoke all on function public.prevent_generation_provider_change() from public,anon,authenticated;
revoke all on function public.prevent_try_on_provider_change() from public,anon,authenticated;
grant execute on function public.reserve_generation(text,uuid,uuid,text,uuid,uuid,uuid[],jsonb,text,text,uuid,integer,uuid) to service_role;
grant execute on function public.prevent_generation_provider_change() to service_role;
grant execute on function public.prevent_try_on_provider_change() to service_role;

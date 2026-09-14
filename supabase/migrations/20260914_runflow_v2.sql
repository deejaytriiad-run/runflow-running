-- RunFlow V2 — enrichissement non destructif
alter table public.runs
  add column if not exists perceived_effort smallint,
  add column if not exists user_comment text default '',
  add column if not exists feeling text,
  add column if not exists recovery_note text;

do $$ begin
  alter table public.runs add constraint runs_perceived_effort_check
    check (perceived_effort is null or perceived_effort between 1 and 10);
exception when duplicate_object then null;
end $$;

alter table public.goals
  add column if not exists goal_type text default 'distance',
  add column if not exists target_time_minutes integer,
  add column if not exists start_date date default current_date,
  add column if not exists notes text default '';

alter table public.plans
  add column if not exists session_type text default 'endurance',
  add column if not exists target_duration_minutes integer,
  add column if not exists target_pace_seconds integer,
  add column if not exists intensity text default 'facile',
  add column if not exists notes text default '',
  add column if not exists linked_run_id uuid references public.runs(id) on delete set null;

create index if not exists runs_user_date_idx
  on public.runs(user_id, run_date desc);

create index if not exists runs_user_source_external_idx
  on public.runs(user_id, source, external_id);

create index if not exists plans_user_date_idx
  on public.plans(user_id, planned_date);

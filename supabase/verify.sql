-- Read-only structural verification for Chat Gepeto.
select
  tablename,
  policyname,
  cmd,
  qual as using_condition,
  with_check as write_condition
from pg_policies
where schemaname = 'public'
  and tablename in ('gepeto_sessions', 'gepeto_session_members', 'gepeto_messages')
order by tablename, policyname;

select
  to_regclass('public.gepeto_sessions') is not null as sessions_table,
  to_regclass('public.gepeto_session_members') is not null as members_table,
  to_regclass('public.gepeto_messages') is not null as messages_table,
  to_regprocedure('public.create_gepeto_session(jsonb,text)') is not null as create_rpc,
  to_regprocedure('public.join_gepeto_session(text)') is not null as join_rpc,
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'gepeto_sessions'
  ) as session_realtime_enabled,
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'gepeto_one_player_per_session'
  ) as single_player_index;

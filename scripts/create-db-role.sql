\\set ON_ERROR_STOP on
-- Run after the indexer's Ponder schema has been initialized, as a Postgres superuser.
-- Set the password interactively afterwards:
-- psql -U postgres -c '\\password farmenta_backend'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'farmenta_backend') then
    create role farmenta_backend login noinherit;
  end if;
end
$$;
grant connect on database farmenta to farmenta_backend;
revoke connect on database lpmon from farmenta_backend;

-- Application data lives in its own schema. The backend may not mutate Ponder/indexer data.
create schema if not exists backend authorization farmenta_backend;
grant usage on schema backend to farmenta_backend;
grant all privileges on all tables in schema backend to farmenta_backend;
alter default privileges in schema backend grant all on tables to farmenta_backend;

revoke create on schema public from public;
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'ponder') then
    raise exception 'ponder schema is missing; start the indexer once before provisioning backend access';
  end if;
end
$$;
revoke all on schema ponder from farmenta_backend;
revoke all on all tables in schema ponder from farmenta_backend;
grant usage on schema ponder to farmenta_backend;
grant select on all tables in schema ponder to farmenta_backend;
alter default privileges for role farmenta_indexer in schema ponder grant select on tables to farmenta_backend;

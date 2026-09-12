#!/bin/bash
# Cria o papel de APLICAÇÃO. Roda uma única vez, na criação do volume.
#
# Por que dois papéis: no PostgreSQL o DONO da tabela ignora row-level security
# por padrão. É isso que queremos para migração e job. A aplicação precisa do
# oposto — obedecer sempre —, e a única forma de garantir isso é ela NÃO ser dona.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  create role "$APP_DB_USER" login password '$APP_DB_PASSWORD';
  grant connect on database "$POSTGRES_DB" to "$APP_DB_USER";
  grant usage on schema public to "$APP_DB_USER";

  -- Toda tabela futura criada pelo dono já concede DML à aplicação.
  alter default privileges for role "$POSTGRES_USER" in schema public
    grant select, insert, update, delete on tables to "$APP_DB_USER";
  alter default privileges for role "$POSTGRES_USER" in schema public
    grant usage, select on sequences to "$APP_DB_USER";
SQL

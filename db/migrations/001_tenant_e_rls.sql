-- 001 · Tenant e row-level security
--
-- A regra da seção 13 do desenho: isolamento no banco, não na aplicação.
-- Um WHERE esquecido numa rota não pode vazar dado de outra empresa.

create extension if not exists "pgcrypto";

create schema if not exists app;
grant usage on schema app to public;

-- ---------------------------------------------------------------------------
-- O tenant é a empresa que contrata: indústria, distribuidor ou revenda.
-- Não tem tenant_id nem política — é a raiz, e só o dono a manipula.
-- ---------------------------------------------------------------------------
create table tenant (
  id          uuid primary key default gen_random_uuid(),
  nome        text        not null,
  documento   text        not null unique,   -- CNPJ, só dígitos
  tipo        text        not null check (tipo in ('industria','distribuidor','revenda')),
  ativo       boolean     not null default true,
  criado_em   timestamptz not null default now()
);

comment on table tenant is
  'Empresa contratante. Raiz do isolamento: toda tabela de negócio aponta para cá.';

-- ---------------------------------------------------------------------------
-- O tenant do request vive numa variável de sessão, posta pela API a cada
-- transação. As rotas não precisam saber que existe multi-tenancy.
-- ---------------------------------------------------------------------------
create or replace function app.tenant_atual() returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

comment on function app.tenant_atual() is
  'Tenant do request. Nulo fora de um contexto — e com nulo nenhuma política casa, '
  'então o padrão é não enxergar nada, nunca enxergar tudo.';

-- ---------------------------------------------------------------------------
-- Aplica o isolamento a uma tabela de negócio. Chamar em TODA tabela nova.
--
-- Sem "force row level security" de propósito: o dono deve passar por cima
-- (migração, job, carga), a aplicação não. É a separação dos dois papéis.
-- ---------------------------------------------------------------------------
create or replace function app.aplicar_isolamento(tabela regclass) returns void
  language plpgsql
  as $$
begin
  execute format('alter table %s enable row level security', tabela);
  execute format($p$
    create policy tenant_isolamento on %s
      using      (tenant_id = app.tenant_atual())
      with check (tenant_id = app.tenant_atual())
  $p$, tabela);
end $$;

comment on function app.aplicar_isolamento(regclass) is
  'using: o que dá para ler. with check: o que dá para gravar — impede escrever '
  'linha carimbada para outro tenant.';

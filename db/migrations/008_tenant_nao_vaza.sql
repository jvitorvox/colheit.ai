-- 008 · O tenant não pode enxergar os outros tenants
--
-- Achado pelo teste de isolamento. A 001 deixou `tenant` sem política dizendo
-- que "só o dono manipula" — mas isso valia para escrita. A leitura ficou
-- aberta pelos privilégios padrão, e qualquer revenda conseguia listar nome e
-- CNPJ de todos os clientes da plataforma.
--
-- A aplicação enxerga a PRÓPRIA linha (marca, nome, tipo) e nada além.

alter table tenant enable row level security;

create policy tenant_proprio on tenant
  using (id = app.tenant_atual());

comment on policy tenant_proprio on tenant is
  'Sem with check: criar e alterar empresa é ato do dono, não da aplicação.';

revoke insert, update, delete on tenant from public;

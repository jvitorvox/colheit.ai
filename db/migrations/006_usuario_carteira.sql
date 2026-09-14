-- 006 · Usuário e carteira do consultor
--
-- Segunda dimensão de isolamento. Até aqui o corte era só por empresa; agora
-- o consultor enxerga apenas os produtores que o CRM autorizou para ele.
--
--   tenant   → de qual empresa é o dado
--   carteira → qual consultor pode atuar sobre aquele produtor
--
-- O gestor enxerga a empresa inteira. O consultor, só a carteira.

create table usuario (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  nome       text not null,
  email      text not null unique,
  papel      text not null check (papel in ('gestor','consultor')),
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

create index on usuario (tenant_id);
select app.aplicar_isolamento('usuario');

-- A autorização explícita: este consultor atua sobre este produtor.
create table consultor_carteira (
  usuario_id     uuid not null references usuario(id) on delete cascade,
  vinculo_id     uuid not null references produtor_vinculo(id) on delete cascade,
  autorizado_em  timestamptz not null default now(),
  primary key (usuario_id, vinculo_id)
);

comment on table consultor_carteira is
  'Autorização por produtor, concedida no CRM. Quem cadastra em campo já sai '
  'autorizado — senão não enxergaria o que acabou de criar.';

create index on consultor_carteira (vinculo_id);

-- ---------------------------------------------------------------------------
-- Contexto do usuário, no mesmo molde do tenant: preso à transação.
-- ---------------------------------------------------------------------------
create or replace function app.usuario_atual() returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('app.usuario_id', true), '')::uuid $$;

-- Gestor enxerga a empresa inteira. Sem usuário no contexto também — é o caso
-- de job e integração, que rodam no tenant sem pessoa por trás.
create or replace function app.enxerga_tudo_no_tenant() returns boolean
  language sql
  stable
  as $$
    select case
      when app.usuario_atual() is null then true
      else exists (select 1 from usuario u
                    where u.id = app.usuario_atual()
                      and u.papel = 'gestor')
    end
  $$;

-- A política do vínculo ganha a segunda dimensão.
drop policy tenant_isolamento on produtor_vinculo;
create policy vinculo_por_tenant_e_carteira on produtor_vinculo
  using (
    tenant_id = app.tenant_atual()
    and (app.enxerga_tudo_no_tenant()
         or exists (select 1 from consultor_carteira c
                     where c.vinculo_id = produtor_vinculo.id
                       and c.usuario_id = app.usuario_atual()))
  )
  with check (tenant_id = app.tenant_atual());

comment on policy vinculo_por_tenant_e_carteira on produtor_vinculo is
  'with check só exige o tenant: o consultor PODE criar produtor em campo — '
  'e ganha a autorização no mesmo ato, via app.vincular_produtor.';

alter table consultor_carteira enable row level security;
create policy carteira_por_tenant on consultor_carteira
  using (exists (select 1 from usuario u
                  where u.id = consultor_carteira.usuario_id
                    and u.tenant_id = app.tenant_atual()));

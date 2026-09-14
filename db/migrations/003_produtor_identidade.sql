-- 003 · Identidade do produtor
--
-- A decisão: chave sintética, documentos como tabela, identidade GLOBAL e
-- relação comercial POR TENANT.
--
-- Por que não CPF como chave primária:
--   1. o mesmo produtor opera sob CPF, CNPJ e inscrição estadual — com CPF
--      como chave ele vira N registros e a porta única quebra no caso que
--      ela existe para resolver;
--   2. o consultor cadastra em campo sem o documento em mãos;
--   3. CPF é dado pessoal e como chave se espalha por toda FK, log e URL.

-- ---------------------------------------------------------------------------
-- Identidade. É o mesmo João para todas as revendas — por isso NÃO tem
-- tenant_id. É a exceção à regra da seção 13, e a política abaixo é o preço.
-- ---------------------------------------------------------------------------
create table produtor (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  origem      text not null default 'consultor'
                check (origem in ('consultor','autocadastro','importacao')),
  fundido_em  uuid references produtor(id),
  criado_em   timestamptz not null default now()
);

comment on column produtor.origem is
  'De onde veio o registro. Cadastro de campo é rápido e impreciso; autocadastro '
  'do próprio produtor é mais confiável. Pesa na hora de decidir quem vence uma fusão.';
comment on column produtor.fundido_em is
  'Duplicata resolvida: aponta para o vencedor. Ninguém é apagado — o histórico '
  'do perdedor continua alcançável.';

create index on produtor (fundido_em) where fundido_em is not null;

-- Um produtor, vários documentos. É isto que sustenta a porta única.
create table produtor_documento (
  produtor_id  uuid not null references produtor(id) on delete cascade,
  tipo         text not null check (tipo in ('cpf','cnpj','ie')),
  valor        text not null check (valor ~ '^[0-9]+$'),
  primary key (tipo, valor)
);

comment on table produtor_documento is
  'PK em (tipo, valor): um documento pertence a exatamente um produtor. '
  'É o que permite reconhecer o mesmo produtor entrando por outra revenda.';

create index on produtor_documento (produtor_id);

-- ---------------------------------------------------------------------------
-- A relação comercial. AQUI mora o tenant. Tudo que é comercial — pedido,
-- funil, visita, carteira — pendura no vínculo, nunca no produtor.
-- ---------------------------------------------------------------------------
create table produtor_vinculo (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  produtor_id  uuid not null references produtor(id) on delete cascade,
  criado_em    timestamptz not null default now(),
  unique (tenant_id, produtor_id)
);

create index on produtor_vinculo (produtor_id);
select app.aplicar_isolamento('produtor_vinculo');

-- ---------------------------------------------------------------------------
-- Política do produtor: enxerga quem tem vínculo, não quem tem a coluna.
-- ---------------------------------------------------------------------------
alter table produtor enable row level security;
create policy produtor_por_vinculo on produtor
  using (exists (
    select 1 from produtor_vinculo v
     where v.produtor_id = produtor.id
       and v.tenant_id = app.tenant_atual()));

alter table produtor_documento enable row level security;
create policy documento_por_vinculo on produtor_documento
  using (exists (
    select 1 from produtor_vinculo v
     where v.produtor_id = produtor_documento.produtor_id
       and v.tenant_id = app.tenant_atual()));

-- 020 · Catálogo: produto, preço por safra e canal, royalties
--
-- A decisão da seção 18 é modelar produto como categoria genérica desde o
-- schema e entregar semente primeiro. É o que permite estender para defensivo
-- sem reconstruir — se a tabela se chamasse `semente` e tivesse campos de
-- semente, a extensão seria migração de base com cliente rodando.
--
-- Royalties entram porque o bench os classificou como requisito de entrada,
-- não diferencial: sem eles não se vende para quem trabalha com semente
-- certificada.

create table produto (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  categoria    text not null default 'semente'
                 check (categoria in ('semente', 'defensivo', 'fertilizante', 'outro')),
  nome         text not null,
  cultura      text,
  unidade      text not null default 'sc',
  embalagem    text,
  ativo        boolean not null default true,
  criado_em    timestamptz not null default now(),
  unique (tenant_id, nome)
);

comment on table produto is
  'O catálogo é de quem vende: cada empresa tem o seu. A distribuidora multimarca '
  'cadastra o que revende, e o que cada fornecedor enxerga continua recortado '
  'pela origem da transação.';
comment on column produto.categoria is
  'Genérica desde o primeiro dia, mesmo entregando só semente. É a diferença '
  'entre acrescentar uma linha e migrar a base com cliente rodando.';

create index on produto (tenant_id, ativo);

-- ---------------------------------------------------------------------------
-- Preço por safra e canal. A safra é o eixo do tempo deste domínio — não o
-- mês, não o trimestre.
-- ---------------------------------------------------------------------------
create table preco (
  id            uuid primary key default gen_random_uuid(),
  produto_id    uuid not null references produto(id) on delete cascade,
  safra         text not null,
  canal         text not null default 'direto'
                  check (canal in ('direto', 'distribuidor')),
  valor         numeric(12,4) not null check (valor >= 0),
  royalties_sc  numeric(12,4) not null default 0 check (royalties_sc >= 0),
  vigente_de    date not null default current_date,
  criado_em     timestamptz not null default now(),
  unique (produto_id, safra, canal, vigente_de)
);

comment on column preco.canal is
  'Venda direta ao produtor e venda ao distribuidor têm preço diferente — é a '
  'mesma cadeia da seção 04, aparecendo na tabela de preço.';
comment on column preco.royalties_sc is
  'Devido por saco ao detentor da tecnologia. Fica ao lado do preço porque muda '
  'com a safra, junto com ele.';

create index on preco (produto_id, safra, canal, vigente_de desc);

alter table preco enable row level security;
create policy preco_pelo_produto on preco
  using (exists (select 1 from produto p where p.id = preco.produto_id))
  with check (exists (select 1 from produto p
                       where p.id = preco.produto_id and p.tenant_id = app.tenant_atual()));

select app.aplicar_isolamento('produto');

-- ---------------------------------------------------------------------------
-- O item do pedido passa a apontar para o catálogo — e a guardar o que foi
-- cobrado. Preço muda; o pedido tem de lembrar o da época, pelo mesmo motivo
-- do carimbo de território.
-- ---------------------------------------------------------------------------
alter table pedido_item add column produto_id uuid references produto(id) on delete set null;
alter table pedido_item add column royalties_sc numeric(12,4);
alter table pedido_item add column bonificada boolean not null default false;

comment on column pedido_item.produto_id is
  'Nulo nos itens anteriores ao catálogo, e nos que a revenda digitar à mão. '
  'O nome do cultivar continua no item: é o que o produtor vê, e não depende '
  'de o catálogo existir.';
comment on column pedido_item.royalties_sc is
  'Copiado do preço no momento da venda. Tabela nova não reescreve pedido velho.';
comment on column pedido_item.bonificada is
  'Semente de geração de demanda, entregue sem cobrar. Gera volume sem receita '
  'e derruba o preço médio — separar é o que impede o indicador de mentir.';

create index on pedido_item (produto_id) where produto_id is not null;

-- ---------------------------------------------------------------------------
-- Barter é forma de pagamento corrente no agro, e o bench o listou junto com
-- royalties como requisito de entrada.
-- ---------------------------------------------------------------------------
alter table pedido add column pagamento text not null default 'dinheiro'
  check (pagamento in ('dinheiro', 'barter', 'misto'));

comment on column pedido.pagamento is
  'Barter é pagar insumo com grão. Aqui só se registra a forma — a apuração do '
  'grão é outro assunto, e fingir que cabe neste campo seria pior que não ter.';

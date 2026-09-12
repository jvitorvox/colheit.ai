-- 002 · Tabela mínima só para o teste de isolamento ter o que provar.
--
-- NÃO é modelagem de domínio. O schema de verdade — produtor, propriedade,
-- talhão, pedido — entra quando a chave de identidade estiver decidida
-- (CPF/CNPJ, CAR, ou composta). Ver seção 18 do desenho.

create table nota_teste (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  texto      text not null,
  criado_em  timestamptz not null default now()
);

create index on nota_teste (tenant_id);

select app.aplicar_isolamento('nota_teste');

-- 005 · Propriedade, talhão e quem opera a terra
--
-- "Ele tb é cliente": o dono da terra é um produtor como outro qualquer.
-- Por isso propriedade não tem coluna de dono — tem uma RELAÇÃO com papel e
-- período, e as duas pontas são produtor.

create table propriedade (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  municipio  text,
  uf         char(2),
  car        text unique,          -- Cadastro Ambiental Rural, quando houver
  area_ha    numeric(12,2) check (area_ha > 0),
  criado_em  timestamptz not null default now()
);

comment on column propriedade.car is
  'Chave natural do IMÓVEL — nunca do produtor. Opcional: é autodeclarado, '
  'pode ser retificado, e uma fazenda pode abranger mais de um CAR.';

-- ---------------------------------------------------------------------------
-- Quem opera a terra, e quando. Arrendamento é a regra, não a exceção.
-- ---------------------------------------------------------------------------
create table produtor_propriedade (
  id             uuid primary key default gen_random_uuid(),
  produtor_id    uuid not null references produtor(id) on delete cascade,
  propriedade_id uuid not null references propriedade(id) on delete cascade,
  papel          text not null check (papel in ('proprietario','arrendatario','comodatario')),
  inicio         date not null default current_date,
  fim            date,
  check (fim is null or fim > inicio)
);

comment on table produtor_propriedade is
  'Período aberto (fim nulo) é a relação vigente. O mesmo talhão pode ter sido '
  'de um arrendatário na safra passada e de outro nesta — e o histórico de '
  'lavoura precisa saber de quem era na época.';

create index on produtor_propriedade (propriedade_id);
create index on produtor_propriedade (produtor_id);

-- Um proprietário vigente por propriedade. Arrendatário pode ter mais de um
-- (áreas diferentes da mesma fazenda), então a restrição só vale para dono.
create unique index on produtor_propriedade (propriedade_id)
  where papel = 'proprietario' and fim is null;

create table talhao (
  id             uuid primary key default gen_random_uuid(),
  propriedade_id uuid not null references propriedade(id) on delete cascade,
  nome           text not null,
  area_ha        numeric(10,2) check (area_ha > 0),
  unique (propriedade_id, nome)
);

comment on table talhao is
  'A unidade em que produtividade e custo fazem sentido. Sem tenant_id: '
  'pertence à propriedade, e a visibilidade vem por ela.';

-- ---------------------------------------------------------------------------
-- Visibilidade: dois saltos. O tenant enxerga a propriedade se tem vínculo
-- com algum produtor que a opera.
-- ---------------------------------------------------------------------------
create or replace function app.propriedade_visivel(p_propriedade uuid) returns boolean
  language sql
  stable
  as $$
    select exists (
      select 1
        from produtor_propriedade pp
        join produtor_vinculo v on v.produtor_id = pp.produtor_id
       where pp.propriedade_id = p_propriedade
         and v.tenant_id = app.tenant_atual())
  $$;

alter table propriedade enable row level security;
create policy propriedade_por_vinculo on propriedade
  using (app.propriedade_visivel(id));

alter table produtor_propriedade enable row level security;
create policy relacao_por_vinculo on produtor_propriedade
  using (exists (select 1 from produtor_vinculo v
                  where v.produtor_id = produtor_propriedade.produtor_id
                    and v.tenant_id = app.tenant_atual()));

alter table talhao enable row level security;
create policy talhao_por_propriedade on talhao
  using (app.propriedade_visivel(propriedade_id));

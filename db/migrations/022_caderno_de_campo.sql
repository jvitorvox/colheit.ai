-- 022 · Caderno de campo: plantio e resultado por talhão
--
-- É o que faltava para o último item de fosso. O share do concorrente só pode
-- vir do talhão — não da base da distribuidora, que não o entregaria, nem da
-- base do franqueado, que sendo exclusivo não vende outra marca. Aqui ele
-- finalmente tem de onde sair.
--
-- E fecha o laço na outra ponta: plantio ligado ao resultado é o que transforma
-- venda em histórico técnico, que é o que o produtor leva consigo quando troca
-- de revenda.

create table plantio (
  id             uuid primary key default gen_random_uuid(),
  talhao_id      uuid not null references talhao(id) on delete cascade,
  safra          text not null,
  ciclo          text not null default 'safra' check (ciclo in ('safra', 'safrinha')),
  cultura        text,
  cultivar       text not null,
  marca          text not null,
  produto_id     uuid references produto(id) on delete set null,
  lote           text,
  area_ha        numeric(10,2) check (area_ha is null or area_ha > 0),
  plantado_em    date,
  populacao      numeric(10,2) check (populacao is null or populacao > 0),
  registrado_por uuid references usuario(id) on delete set null,
  relato_id      uuid unique references relato(id) on delete set null,
  criado_em      timestamptz not null default now(),
  unique (talhao_id, safra, ciclo)
);

comment on column plantio.ciclo is
  'Safra e safrinha convivem no mesmo ano agrícola e no mesmo talhão. A planilha '
  'que deu origem ao projeto era de milho safrinha — tratar as duas como uma só '
  'apagaria metade do negócio.';
comment on column plantio.marca is
  'Sempre preenchida, seja nossa ou do concorrente. É esta coluna que responde '
  'a H5 — e ela só existe porque alguém esteve no talhão.';
comment on column plantio.produto_id is
  'Preenchido quando o cultivar é do nosso catálogo. Nulo significa marca de '
  'terceiro: é assim que o share se calcula, sem ninguém classificar à mão.';

create index on plantio (talhao_id, safra);
create index on plantio (safra, marca);

create table colheita (
  id                  uuid primary key default gen_random_uuid(),
  plantio_id          uuid not null unique references plantio(id) on delete cascade,
  colhido_em          date,
  produtividade_sc_ha numeric(10,2) check (produtividade_sc_ha is null or produtividade_sc_ha > 0),
  umidade             numeric(5,2),
  observacao          text,
  registrado_por      uuid references usuario(id) on delete set null,
  criado_em           timestamptz not null default now()
);

comment on table colheita is
  'Uma por plantio. É o fim do laço: a semente que saiu do pedido virou número '
  'de saco por hectare, e o número volta ao funil da safra seguinte.';

-- ---------------------------------------------------------------------------
-- Visibilidade: é camada TÉCNICA, e o desenho diz que ela é compartilhada com
-- o agricultor. Segue a propriedade, que já resolve tenant e produtor.
-- ---------------------------------------------------------------------------
create or replace function app.talhao_visivel(p_talhao uuid) returns boolean
  language sql stable
  as $$ select exists (select 1 from talhao where id = p_talhao) $$;

alter table plantio enable row level security;
create policy plantio_pelo_talhao on plantio
  using (app.talhao_visivel(talhao_id))
  with check (app.talhao_visivel(talhao_id) and app.tenant_atual() is not null);

alter table colheita enable row level security;
create policy colheita_pelo_plantio on colheita
  using (exists (select 1 from plantio p where p.id = plantio_id))
  with check (exists (select 1 from plantio p where p.id = plantio_id)
              and app.tenant_atual() is not null);

comment on policy plantio_pelo_talhao on plantio is
  'Leitura segue o talhão — inclusive para o produtor, porque a lavoura é dele. '
  'Escrita exige sessão de empresa: quem fecha o registro é o consultor.';

-- ---------------------------------------------------------------------------
-- O franqueado alcança o talhão pelos pedidos que carimbam o território dele.
-- Sem isto ele veria a venda e não veria o que foi plantado — que é justamente
-- o que ele está comprando.
-- ---------------------------------------------------------------------------
create policy propriedade_pelo_pedido on propriedade
  using (exists (select 1 from pedido pd
                  where pd.propriedade_id = propriedade.id
                    and pd.franqueado_id = app.tenant_atual()))
  with check (false);

create policy talhao_pelo_pedido on talhao
  using (exists (select 1 from pedido pd
                  where pd.propriedade_id = talhao.propriedade_id
                    and pd.franqueado_id = app.tenant_atual()))
  with check (false);

-- ---------------------------------------------------------------------------
-- O share por marca, que é o último item de fosso.
--
-- Por ÁREA, não por valor: é como o glossário define share of wallet neste
-- domínio, e é o único jeito honesto quando não se sabe o que o concorrente
-- cobrou.
-- ---------------------------------------------------------------------------
create or replace function app.share_por_marca(p_safra text)
  returns table (
    marca      text,
    nossa      boolean,
    area_ha    numeric,
    talhoes    integer,
    share      numeric
  )
  language sql
  stable
  as $$
    with base as (
      select pl.marca,
             bool_or(pl.produto_id is not null) as nossa,
             sum(coalesce(pl.area_ha, t.area_ha, 0)) as ha,
             count(*)::int as talhoes
        from plantio pl
        join talhao t on t.id = pl.talhao_id
       where pl.safra = p_safra
       group by pl.marca
    )
    select b.marca, b.nossa, b.ha, b.talhoes,
           case when sum(b.ha) over () > 0
                then round(b.ha / sum(b.ha) over () * 100, 1)
                else null end
      from base b
     order by b.ha desc
  $$;

comment on function app.share_por_marca(text) is
  'Responde a H5 com número em vez de opinião. O denominador é a área plantada '
  'que NÓS enxergamos — não o mercado inteiro —, e dizer isso na tela é o que '
  'impede o indicador de ser lido como maior do que é.';

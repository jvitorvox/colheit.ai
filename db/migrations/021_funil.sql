-- 021 · Funil de prospecção
--
-- Um funil por safra, porque a safra é o eixo do tempo deste domínio — não o
-- mês, não o trimestre.
--
-- O que diferencia este funil de um CRM qualquer é o laço: o potencial sai da
-- área que já está cadastrada, e a penetração compara com o que foi vendido de
-- verdade. Sem isso seria pipeline genérico, que o bench mostrou que todo
-- mundo tem.

create table oportunidade (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  produtor_id    uuid not null references produtor(id) on delete cascade,
  safra          text not null,
  estagio        text not null default 'prospeccao'
                   check (estagio in ('prospeccao', 'qualificacao', 'proposta',
                                      'negociacao', 'ganha', 'perdida')),
  potencial_sc   numeric(12,2) check (potencial_sc is null or potencial_sc > 0),
  origem_potencial text not null default 'estimado'
                   check (origem_potencial in ('estimado', 'informado')),
  responsavel_id uuid references usuario(id) on delete set null,
  motivo_perda   text,
  concorrente    text,
  fechada_em     timestamptz,
  criado_em      timestamptz not null default now(),
  unique (tenant_id, produtor_id, safra),
  -- Perder sem dizer por quê é como o funil vira relatório de desculpa.
  check (estagio <> 'perdida' or motivo_perda is not null)
);

comment on table oportunidade is
  'Uma por produtor por safra: é assim que a operação pensa. Duas oportunidades '
  'para o mesmo produtor na mesma safra seriam a mesma conversa contada duas vezes.';
comment on column oportunidade.potencial_sc is
  'Quantos sacos ele compraria na safra. Estimado a partir da área cadastrada, '
  'ou informado por quem conversou com ele — e a coluna ao lado diz qual dos dois.';
comment on column oportunidade.motivo_perda is
  'Camada comercial. O produtor NUNCA vê isto — se vazar, o consultor deixa de '
  'registrar a verdade e a base perde o valor.';

create index on oportunidade (tenant_id, safra, estagio);
create index on oportunidade (produtor_id);

create table oportunidade_etapa (
  id             uuid primary key default gen_random_uuid(),
  oportunidade_id uuid not null references oportunidade(id) on delete cascade,
  estagio        text not null,
  em             timestamptz not null default now(),
  por_usuario    uuid references usuario(id) on delete set null,
  observacao     text
);
create index on oportunidade_etapa (oportunidade_id, em desc);

-- ---------------------------------------------------------------------------
-- Isolamento.
--
-- Repare no que NÃO está aqui: não há política do produtor. É a tradução
-- literal da regra rígida do desenho — a camada comercial não atravessa. Porte,
-- motivo de perda e concorrente ficam do lado de dentro, e a ausência de
-- política é a forma mais difícil de desfazer por engano.
-- ---------------------------------------------------------------------------
select app.aplicar_isolamento('oportunidade');

alter table oportunidade_etapa enable row level security;
create policy etapa_pela_oportunidade on oportunidade_etapa
  using (exists (select 1 from oportunidade o where o.id = oportunidade_id))
  with check (exists (select 1 from oportunidade o
                       where o.id = oportunidade_id and o.tenant_id = app.tenant_atual()));

-- ---------------------------------------------------------------------------
-- O laço: área cadastrada de um lado, sacos comprados do outro.
--
-- A penetração é o que sobra entre os dois — e o que sobra é onde está o
-- concorrente. Note que ela diz o TAMANHO da lacuna, não a marca que a ocupa:
-- isso só o talhão conta, e o caderno de campo é quem traz.
-- ---------------------------------------------------------------------------
create or replace function app.penetracao(p_safra text, p_sc_por_ha numeric default 1.0)
  returns table (
    produtor_id   uuid,
    produtor      text,
    area_ha       numeric,
    potencial_sc  numeric,
    comprado_sc   numeric,
    penetracao    numeric
  )
  language sql
  stable
  as $$
    with area as (
      select pv.produtor_id, coalesce(sum(distinct pr.area_ha), 0) as ha
        from produtor_vinculo pv
        left join produtor_propriedade pp on pp.produtor_id = pv.produtor_id and pp.fim is null
        left join propriedade pr on pr.id = pp.propriedade_id
       group by pv.produtor_id
    ),
    comprado as (
      select pe.produtor_id, coalesce(sum(i.quantidade), 0) as sc
        from pedido pe
        join pedido_item i on i.pedido_id = pe.id
       where pe.safra = p_safra and pe.situacao <> 'cancelado'
       group by pe.produtor_id
    )
    select p.id, p.nome, a.ha,
           coalesce(o.potencial_sc, round(a.ha * p_sc_por_ha, 2)) as potencial,
           coalesce(c.sc, 0) as comprado,
           case when coalesce(o.potencial_sc, a.ha * p_sc_por_ha) > 0
                then round(coalesce(c.sc, 0)
                           / coalesce(o.potencial_sc, a.ha * p_sc_por_ha) * 100, 1)
                else null end as penetracao
      from area a
      join produtor p on p.id = a.produtor_id and p.fundido_em is null
      left join comprado c on c.produtor_id = a.produtor_id
      left join oportunidade o on o.produtor_id = a.produtor_id and o.safra = p_safra
     order by (coalesce(o.potencial_sc, a.ha * p_sc_por_ha) - coalesce(c.sc, 0)) desc
  $$;

comment on function app.penetracao(text, numeric) is
  'Ordenada pela lacuna em sacos, não pelo percentual: o produtor de 18.000 ha '
  'com 10% de penetração vale mais atenção que o de 400 ha com 5%.';

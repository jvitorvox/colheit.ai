-- 018 · Registro de visita
--
-- A H1 diz que o consultor registra a visita se for rápido o bastante, com
-- mediana abaixo de 60 segundos — e que sem isso não há dado, e sem dado não
-- há produto. É a hipótese que mata o projeto sozinha.
--
-- Por isso a tabela guarda `duracao_seg` e `canal`: a H1 deixa de depender de
-- um dia de campo com cronômetro e passa a ser medida em toda visita, sempre,
-- comparando o áudio no WhatsApp com o formulário do aplicativo.

create table visita (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  produtor_id    uuid not null references produtor(id) on delete cascade,
  propriedade_id uuid references propriedade(id) on delete set null,
  talhao_id      uuid references talhao(id) on delete set null,
  usuario_id     uuid references usuario(id) on delete set null,
  em             timestamptz not null default now(),
  canal          text not null default 'app' check (canal in ('app', 'whatsapp')),
  duracao_seg    integer check (duracao_seg >= 0),
  estagio        text,
  estande        numeric(10,2) check (estande is null or estande > 0),
  observacao     text,
  relato_id      uuid unique references relato(id) on delete set null,
  criado_em      timestamptz not null default now()
);

comment on column visita.duracao_seg is
  'Quanto levou para REGISTRAR, não para visitar. É a medição contínua da H1. '
  'Vem do cliente, então é indicativo e não auditado — serve para ver tendência '
  'e comparar canais, não para cobrar ninguém.';
comment on column visita.canal is
  'app ou whatsapp. A H1 revisada pede os dois medidos lado a lado: é isso que '
  'decide qual é o canal de captura de verdade.';
comment on column visita.relato_id is
  'Quando a visita nasceu de um áudio validado pelo consultor. Unique: um '
  'relato vira no máximo uma visita.';

create index on visita (tenant_id, produtor_id, em desc);
create index on visita (usuario_id, em desc);

select app.aplicar_isolamento('visita');

-- O produtor vê quem esteve na lavoura dele e quando. O que o consultor anota
-- como avaliação comercial não mora aqui — a camada comercial não atravessa.
create policy visita_dele on visita
  using (produtor_id = app.produtor_atual())
  with check (false);

-- ---------------------------------------------------------------------------
-- A fila do dia. Ordena por quem está há mais tempo sem visita, pesado pela
-- área — é o mesmo critério que o bench encontrou no concorrente, e a
-- tradução direta do "82 nunca acessados" da planilha de origem.
-- ---------------------------------------------------------------------------
create or replace function app.fila_de_visita()
  returns table (
    produtor_id   uuid,
    produtor      text,
    area_ha       numeric,
    ultima_em     timestamptz,
    dias          integer,
    municipio     text
  )
  language sql
  stable
  as $$
    select p.id, p.nome,
           coalesce(sum(distinct pr.area_ha), 0) as area_ha,
           max(v.em) as ultima_em,
           case when max(v.em) is null then null
                else extract(day from now() - max(v.em))::int end as dias,
           min(pr.municipio) as municipio
      from produtor_vinculo pv
      join produtor p on p.id = pv.produtor_id and p.fundido_em is null
      left join produtor_propriedade pp on pp.produtor_id = p.id and pp.fim is null
      left join propriedade pr on pr.id = pp.propriedade_id
      left join visita v on v.produtor_id = p.id
     group by p.id, p.nome
     order by (coalesce(extract(day from now() - max(v.em))::int, 9999))
              * greatest(coalesce(sum(distinct pr.area_ha), 1), 1) desc
  $$;

comment on function app.fila_de_visita() is
  'Nunca visitado vem primeiro, de propósito: 9999 dias. O produtor grande que '
  'ninguém nunca procurou é o pior caso da carteira, e é o que a planilha de '
  'origem mostrava sem conseguir priorizar.';

-- 019 · A fila não pode empatar em zero
--
-- A 018 ordenava por `dias * área`. Quando todo mundo foi visitado hoje,
-- `dias` é zero, o produto zera para todos e a ordem vira arbitrária — e o
-- peso da área some justamente no momento em que ele deveria desempatar.
--
-- `dias + 1` conserta: recém-visitado continua no fim da fila, mas entre dois
-- recém-visitados o de 18.000 ha vem antes do de 400 ha, que é o que a régua
-- quis dizer desde o começo.

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
     order by (coalesce(extract(day from now() - max(v.em))::int, 9999) + 1)
              * greatest(coalesce(sum(distinct pr.area_ha), 1), 1) desc,
              p.nome
  $$;

comment on function app.fila_de_visita() is
  'Nunca visitado vem primeiro (9999 dias). Entre dois visitados no mesmo dia, '
  'decide a área — por isso o +1. O nome no fim da ordenação garante ordem '
  'estável: fila que muda de posição sozinha a cada carregamento não é fila.';

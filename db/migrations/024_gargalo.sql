-- 024 · Onde a operação trava
--
-- O funil por contagem — "8 pedidos na etapa 3" — não diz nada. Oito pedidos
-- passando pela etapa 3 é operação andando; oito pedidos PARADOS há vinte dias
-- na etapa 3 é o gestor tendo um problema e não sabendo.
--
-- O que muda o dia de quem gerencia é o tempo, não a contagem.

create or replace function app.gargalo_por_etapa()
  returns table (
    etapa         integer,
    nome          text,
    pedidos       integer,
    mediana_dias  numeric,
    pior_dias     integer,
    pior_pedido   text
  )
  language sql
  stable
  as $$
    with movimento as (
      -- "Parado" é não ter acontecido NADA — nem avanço, nem crédito, nem
      -- nota. Medir só o avanço de etapa marcaria como parado o pedido em que
      -- se trabalhou ontem, e o gestor aprenderia a ignorar o indicador.
      select p.id, p.numero, p.etapa,
             greatest(0, extract(day from now() - coalesce(max(h.em), p.criado_em))::int) as dias
        from pedido p
        left join pedido_etapa h on h.pedido_id = p.id
       where p.situacao = 'andamento'
       group by p.id, p.numero, p.etapa, p.criado_em
    )
    select m.etapa,
           e.nome,
           count(*)::int,
           round(percentile_cont(0.5) within group (order by m.dias)::numeric, 1),
           max(m.dias)::int,
           -- O pior pedido pelo número: o gestor vai atrás dele, não da média.
           (array_agg(m.numero order by m.dias desc))[1]
      from movimento m
      join etapa_pedido e on e.numero = m.etapa
     group by m.etapa, e.nome
     order by m.etapa
  $$;

comment on function app.gargalo_por_etapa() is
  'Mediana e pior caso de dias parado, por etapa, entre os pedidos em '
  'andamento. Não é SECURITY DEFINER: roda sob a política de quem chamou, '
  'como app.penetracao e app.share_por_marca.';

-- O agrupamento varre o histórico inteiro dos pedidos em andamento a cada
-- abertura do painel. Enquanto é uma revenda, isso é nada; o índice existe
-- para que continue sendo nada quando não for.
create index if not exists pedido_etapa_por_pedido on pedido_etapa (pedido_id, em desc);

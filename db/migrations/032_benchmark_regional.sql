-- 032 · Benchmark regional
--
-- "Como eu fui em relação à minha região?" é a pergunta que o produtor mais
-- quer responder e a que mais fácil vaza. Num município com dois produtores, a
-- média da região É o número do vizinho — basta subtrair o próprio.
--
-- Esta é a ÚNICA função do sistema que lê através de produtores diferentes, e
-- por isso ela é escrita para ser lida inteira:
--
--   1. É `security definer` porque tem de ser: a política do portal limita o
--      produtor à terra dele, e um benchmark que só enxerga a terra dele não é
--      benchmark. Não há como fazer isto por política.
--   2. Devolve só AGREGADO. Nunca uma linha, nunca um nome, nunca um id.
--   3. A regra de anonimato mora AQUI DENTRO, não em quem chama. Chamador
--      nenhum pode contorná-la, nem por engano nem de propósito.
--   4. Quem pergunta é EXCLUÍDO da conta. Comparar-se com um grupo que te
--      contém é comparar-se consigo mesmo, e ainda facilitaria a subtração.

-- Cinco OUTROS produtores. Com três, quem conhece dois vizinhos deduz o
-- terceiro; com cinco, o resíduo de uma subtração continua sendo um bolo de
-- quatro. Não é um número mágico — é o piso usual para divulgação agregada, e
-- está aqui em vez de num arquivo de configuração porque afrouxá-lo tem de ser
-- uma migração que alguém revisa.
create or replace function app.benchmark_minimo() returns integer
  language sql immutable as $$ select 5 $$;

create or replace function app.benchmark_regional(
    p_safra     text,
    p_municipio text,
    p_uf        char(2),
    p_excluir   uuid default null)
  returns table (
    nivel                 text,
    produtores            integer,
    area_ha               numeric,
    media_ponderada_sc_ha numeric)
  language plpgsql
  stable
  security definer
  set search_path = public, app
as $$
declare
  k integer := app.benchmark_minimo();
begin
  -- Primeiro o município, que é o recorte que o produtor reconhece como "minha
  -- região". Se não houver gente suficiente, sobe para o estado — e a resposta
  -- DIZ qual nível usou, senão ele lê "região" achando que é a cidade dele.
  return query
  with base as (
    select pp.produtor_id,
           coalesce(pl.area_ha, t.area_ha) as ha,
           c.produtividade_sc_ha           as sc_ha,
           pr.municipio, pr.uf
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      join propriedade pr on pr.id = t.propriedade_id
      join produtor_propriedade pp
        on pp.propriedade_id = pr.id and pp.fim is null
      join colheita c on c.plantio_id = pl.id
     where pl.safra = p_safra
       and c.produtividade_sc_ha is not null
       and pr.uf = p_uf
       and (p_excluir is null or pp.produtor_id <> p_excluir)
  ),
  recortes as (
    select 'município'::text as nivel,
           count(distinct produtor_id)::int as produtores,
           coalesce(sum(ha), 0) as area_ha,
           case when sum(ha) > 0 then round(sum(ha * sc_ha) / sum(ha), 1) end as media
      from base where municipio = p_municipio
    union all
    select 'estado',
           count(distinct produtor_id)::int,
           coalesce(sum(ha), 0),
           case when sum(ha) > 0 then round(sum(ha * sc_ha) / sum(ha), 1) end
      from base
  )
  select r.nivel, r.produtores, r.area_ha, r.media
    from recortes r
   where r.produtores >= k and r.media is not null
   -- 'estado' > 'município' em texto, então a ordem é explícita: o recorte mais
   -- fino primeiro, e o estado só quando o município não alcançou o piso.
   order by case r.nivel when 'município' then 0 else 1 end
   limit 1;
end $$;

comment on function app.benchmark_regional(text, text, char, uuid) is
  'Único ponto do sistema que lê através de produtores. Devolve agregado ou '
  'NADA — nunca um resultado abaixo de app.benchmark_minimo() produtores, e '
  'nunca incluindo quem perguntou. Afrouxar o piso exige migração.';

-- O papel de aplicação executa; o corpo roda como o dono, que é o ponto de ser
-- `security definer`. Ninguém recebe select nas tabelas por causa disto.
grant execute on function app.benchmark_regional(text, text, char, uuid) to public;

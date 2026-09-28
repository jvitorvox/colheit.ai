-- 033 · O benchmark do território
--
-- O cartão da rede compara franqueados entre si e carrega uma ressalva grande:
-- "territórios diferentes, com solo, clima e manejo diferentes — quem está no
-- topo pode apenas ter a melhor terra". A ressalva é verdadeira e por isso o
-- ranking, sozinho, decide pouco.
--
-- Comparar cada franqueado com a REGIÃO DELE resolve isso. Um que faz 47 sc/ha
-- num território que faz 55 está atrás; outro que faz 69 num território que faz
-- 65 está à frente — mesmo com vinte sacos de diferença entre os dois.
--
-- Mesma disciplina da 032, e pelos mesmos motivos: `security definer` porque a
-- franqueadora não enxerga a lavoura de quem não comprou da rede dela, agregado
-- só, e o piso de `app.benchmark_minimo()` dentro da função.

create or replace function app.benchmark_do_territorio(
    p_safra      text,
    p_franqueado uuid)
  returns table (
    produtores            integer,
    municipios            integer,
    area_ha               numeric,
    media_ponderada_sc_ha numeric)
  language sql
  stable
  security definer
  set search_path = public, app
as $$
  with base as (
    select pp.produtor_id,
           pr.municipio,
           coalesce(pl.area_ha, t.area_ha) as ha,
           c.produtividade_sc_ha           as sc_ha
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      join propriedade pr on pr.id = t.propriedade_id
      -- O território é o recorte, e ele é público: a distribuidora já precisa
      -- saber a que franqueado pertence o município do produtor dela.
      join territorio te on te.municipio = pr.municipio and te.uf = pr.uf
      join produtor_propriedade pp
        on pp.propriedade_id = pr.id and pp.fim is null
      join colheita c on c.plantio_id = pl.id
     where pl.safra = p_safra
       and te.franqueado_id = p_franqueado
       and c.produtividade_sc_ha is not null
  )
  select count(distinct produtor_id)::int,
         count(distinct municipio)::int,
         coalesce(sum(ha), 0),
         case when sum(ha) > 0 then round(sum(ha * sc_ha) / sum(ha), 1) end
    from base
   having count(distinct produtor_id) >= app.benchmark_minimo();
$$;

comment on function app.benchmark_do_territorio(text, uuid) is
  'A safra inteira de um território, incluindo quem não comprou da rede. '
  'Agregado, com o mesmo piso da 032. Ninguém é excluído: quem pergunta é a '
  'franqueadora, e ela não controla quem planta no município — o que ela '
  'controla é a rede, e a rede não entra no recorte.';

grant execute on function app.benchmark_do_territorio(text, uuid) to public;

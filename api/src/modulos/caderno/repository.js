// SQL do módulo caderno de campo.

export async function registrarPlantio(cx, p) {
  const { rows } = await cx.query(`
    insert into plantio (talhao_id, safra, ciclo, cultura, cultivar, marca, produto_id,
                         lote, area_ha, plantado_em, populacao, registrado_por, relato_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,app.usuario_atual(),$12)
    on conflict (talhao_id, safra, ciclo) do update
      set cultivar = excluded.cultivar, marca = excluded.marca,
          produto_id = excluded.produto_id, lote = coalesce(excluded.lote, plantio.lote),
          area_ha = coalesce(excluded.area_ha, plantio.area_ha),
          plantado_em = coalesce(excluded.plantado_em, plantio.plantado_em),
          populacao = coalesce(excluded.populacao, plantio.populacao)
    returning id`,
  [p.talhaoId, p.safra, p.ciclo, p.cultura, p.cultivar, p.marca, p.produtoId,
    p.lote, p.areaHa, p.plantadoEm, p.populacao, p.relatoId]);
  return rows[0].id;
}

export async function buscarPlantio(cx, id) {
  const { rows } = await cx.query(`
    select pl.*, t.nome as talhao, t.area_ha as talhao_area,
           pr.nome as propriedade, p.nome as produtor, p.id as produtor_id,
           u.nome as registrado_por_nome,
           (select row_to_json(c) from (
              select colhido_em, produtividade_sc_ha, umidade, observacao
                from colheita where plantio_id = pl.id) c) as colheita
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      join propriedade pr on pr.id = t.propriedade_id
      join produtor_propriedade pp on pp.propriedade_id = pr.id and pp.fim is null
      join produtor p on p.id = pp.produtor_id
      left join usuario u on u.id = pl.registrado_por
     where pl.id = $1
     limit 1`, [id]);
  return rows[0] ?? null;
}

export async function listarPlantios(cx, { safra, talhaoId, produtorId } = {}) {
  const { rows } = await cx.query(`
    select distinct on (pl.id)
           pl.id, pl.safra, pl.ciclo, pl.cultivar, pl.marca, pl.lote, pl.area_ha,
           pl.plantado_em, pl.populacao, pl.produto_id,
           (pl.produto_id is not null) as nossa,
           t.nome as talhao, t.id as talhao_id, pr.nome as propriedade,
           p.nome as produtor, p.id as produtor_id,
           c.produtividade_sc_ha, c.colhido_em
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      join propriedade pr on pr.id = t.propriedade_id
      left join produtor_propriedade pp on pp.propriedade_id = pr.id and pp.fim is null
      left join produtor p on p.id = pp.produtor_id
      left join colheita c on c.plantio_id = pl.id
     where ($1::text is null or pl.safra = $1)
       and ($2::uuid is null or pl.talhao_id = $2)
       and ($3::uuid is null or p.id = $3)
     order by pl.id, pl.plantado_em desc nulls last`,
  [safra ?? null, talhaoId ?? null, produtorId ?? null]);
  return rows;
}

export async function talhaoExiste(cx, id) {
  const { rows } = await cx.query('select 1 from talhao where id = $1', [id]);
  return rows.length > 0;
}

export async function produtoDoCatalogo(cx, nome) {
  const { rows } = await cx.query(
    'select id, nome from produto where lower(nome) = lower($1) and ativo', [nome]);
  return rows[0] ?? null;
}

/* --------------------------------------------------------------- colheita */

export async function registrarColheita(cx, c) {
  const { rows } = await cx.query(`
    insert into colheita (plantio_id, colhido_em, produtividade_sc_ha, umidade,
                          observacao, registrado_por)
    values ($1, coalesce($2::date, current_date), $3, $4, $5, app.usuario_atual())
    on conflict (plantio_id) do update
      set colhido_em = excluded.colhido_em,
          produtividade_sc_ha = excluded.produtividade_sc_ha,
          umidade = excluded.umidade, observacao = excluded.observacao
    returning id`,
  [c.plantioId, c.colhidoEm, c.produtividadeScHa, c.umidade, c.observacao]);
  return rows[0].id;
}

/* ------------------------------------------------------------------ share */

export async function sharePorMarca(cx, safra) {
  const { rows } = await cx.query('select * from app.share_por_marca($1)', [safra]);
  return rows;
}

/** Como cada cultivar se saiu, para o benchmark que o produtor também vê. */
export async function desempenho(cx, safra) {
  const { rows } = await cx.query(`
    select pl.cultivar, pl.marca, (pl.produto_id is not null) as nossa,
           count(c.id)::int as colhidos,
           round(avg(c.produtividade_sc_ha), 1) as media_sc_ha,
           round(min(c.produtividade_sc_ha), 1) as pior,
           round(max(c.produtividade_sc_ha), 1) as melhor
      from plantio pl
      join colheita c on c.plantio_id = pl.id
     where ($1::text is null or pl.safra = $1)
       and c.produtividade_sc_ha is not null
     group by pl.cultivar, pl.marca, nossa
     order by media_sc_ha desc nulls last`, [safra ?? null]);
  return rows;
}

/* --------------------------------------------------- resultado da safra */

/**
 * O fechamento da safra, na área que o chamador enxerga.
 *
 * A produtividade é PONDERADA PELA ÁREA, e não a média das médias. Um talhão de
 * 40 ha com 80 sc/ha e um de 1.800 ha com 55 não dão 67,5 — dão 55,5. A média
 * simples é a que faz o ano parecer melhor do que foi, e é a que sai por engano
 * de um `avg()`.
 *
 * `coalesce(pl.area_ha, t.area_ha)` porque o plantio nem sempre traz a área: em
 * talhão plantado inteiro, quem sabe é o talhão.
 */
export async function resultadoDaSafra(cx, safra, produtorId) {
  const { rows } = await cx.query(`
    with base as (
      select pl.id, pl.cultivar, pl.marca, t.nome as talhao,
             coalesce(pl.area_ha, t.area_ha) as ha,
             c.produtividade_sc_ha as sc_ha, c.colhido_em
        from plantio pl
        join talhao t on t.id = pl.talhao_id
        left join colheita c on c.plantio_id = pl.id
       where pl.safra = $1
         and ($2::uuid is null or exists (
               select 1 from produtor_propriedade pp
                where pp.propriedade_id = t.propriedade_id
                  and pp.fim is null and pp.produtor_id = $2))
    )
    select count(*)::int                                            as talhoes,
           count(sc_ha)::int                                        as colhidos,
           coalesce(sum(ha), 0)                                     as area_ha,
           coalesce(sum(ha) filter (where sc_ha is not null), 0)    as area_colhida_ha,
           coalesce(sum(ha * sc_ha) filter (where sc_ha is not null), 0) as total_sc,
           case when sum(ha) filter (where sc_ha is not null) > 0
                then round(sum(ha * sc_ha) filter (where sc_ha is not null)
                           / sum(ha) filter (where sc_ha is not null), 1)
                end                                                 as media_ponderada_sc_ha,
           max(colhido_em)                                          as ultima_colheita
      from base`, [safra, produtorId ?? null]);
  return rows[0];
}

export async function talhoesDaSafra(cx, safra, produtorId) {
  const { rows } = await cx.query(`
    select pl.id as plantio_id, t.nome as talhao, pl.cultivar, pl.marca,
           coalesce(pl.area_ha, t.area_ha) as area_ha,
           c.produtividade_sc_ha as sc_ha, c.colhido_em, c.umidade,
           -- Quem é o dono do talhão. "Gleba 1" é o nome mais comum do país:
           -- sem o produtor, o melhor e o pior talhão de um painel com várias
           -- fazendas viram duas linhas iguais.
           p.nome as produtor
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      left join produtor_propriedade pp
             on pp.propriedade_id = t.propriedade_id and pp.fim is null
      left join produtor p on p.id = pp.produtor_id
      left join colheita c on c.plantio_id = pl.id
     where pl.safra = $1
       and ($2::uuid is null or exists (
             select 1 from produtor_propriedade pp
              where pp.propriedade_id = t.propriedade_id
                and pp.fim is null and pp.produtor_id = $2))
     order by c.produtividade_sc_ha desc nulls last, t.nome`, [safra, produtorId ?? null]);
  return rows;
}


/**
 * A produtividade ponderada de CADA safra, numa consulta só.
 *
 * Serve à lista de safras e à comparação ao mesmo tempo: safra plantada e não
 * colhida aparece com média nula, e quem compara sabe pular.
 */
export async function mediaPorSafra(cx) {
  const { rows } = await cx.query(`
    select pl.safra,
           case when sum(coalesce(pl.area_ha, t.area_ha))
                     filter (where c.produtividade_sc_ha is not null) > 0
                then round(sum(coalesce(pl.area_ha, t.area_ha) * c.produtividade_sc_ha)
                           filter (where c.produtividade_sc_ha is not null)
                         / sum(coalesce(pl.area_ha, t.area_ha))
                           filter (where c.produtividade_sc_ha is not null), 1)
                end as media_ponderada_sc_ha
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      left join colheita c on c.plantio_id = pl.id
     group by pl.safra
     order by pl.safra desc`);
  return rows;
}

/**
 * A safra separada entre o que saiu do nosso catálogo e o resto.
 *
 * ⚠️ Não é ensaio comparativo. São lavouras diferentes, em solos, datas e
 * manejos diferentes — a diferença que aparecer aqui não é da semente sozinha.
 * O service manda essa frase junto com o número, e ela não é opcional.
 */
export async function resultadoPorOrigem(cx, safra) {
  const { rows } = await cx.query(`
    select (pl.produto_id is not null)                        as nossa,
           count(*)::int                                      as talhoes,
           count(c.produtividade_sc_ha)::int                  as colhidos,
           coalesce(sum(coalesce(pl.area_ha, t.area_ha))
                    filter (where c.produtividade_sc_ha is not null), 0) as area_colhida_ha,
           case when sum(coalesce(pl.area_ha, t.area_ha))
                     filter (where c.produtividade_sc_ha is not null) > 0
                then round(sum(coalesce(pl.area_ha, t.area_ha) * c.produtividade_sc_ha)
                           filter (where c.produtividade_sc_ha is not null)
                         / sum(coalesce(pl.area_ha, t.area_ha))
                           filter (where c.produtividade_sc_ha is not null), 1)
                end                                           as media_ponderada_sc_ha
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      left join colheita c on c.plantio_id = pl.id
     where pl.safra = $1
     group by 1`, [safra]);
  return rows;
}

/**
 * A safra aberta por franqueado.
 *
 * Só diz alguma coisa para a franqueadora, que é quem enxerga mais de um. Para
 * qualquer outro tenant volta uma linha só — e o service não a mostra.
 *
 * O caminho é o PEDIDO, não o município: é o pedido que carrega o carimbo do
 * franqueado, e é isso que impede a conta de somar a venda da concorrente que
 * aconteceu na mesma cidade.
 */
export async function safraPorFranqueado(cx, safra) {
  const { rows } = await cx.query(`
    with talhao_do_franqueado as (
      select distinct pd.franqueado_id, t.id as talhao_id
        from pedido pd
        join talhao t on t.propriedade_id = pd.propriedade_id
        -- Só os franqueados da MINHA rede. Sem esta junção, a distribuidora —
        -- que compra de vários franqueados e por isso enxerga vários
        -- franqueado_id nos pedidos dela — ganhava um cartão comparando
        -- fornecedores anônimos, porque o nome do tenant não abre para ela.
        -- A pergunta "quem é o melhor franqueado" é de quem tem rede.
        join rede r on r.franqueado_id = pd.franqueado_id
                   and r.franqueadora_id = app.tenant_atual()
       where pd.franqueado_id is not null and pd.situacao <> 'cancelado'
    )
    select f.franqueado_id,
           coalesce(tn.nome, 'sem nome')                          as franqueado,
           count(distinct pl.id)::int                             as talhoes,
           count(c.produtividade_sc_ha)::int                      as colhidos,
           coalesce(sum(coalesce(pl.area_ha, t.area_ha))
                    filter (where c.produtividade_sc_ha is not null), 0) as area_colhida_ha,
           case when sum(coalesce(pl.area_ha, t.area_ha))
                     filter (where c.produtividade_sc_ha is not null) > 0
                then round(sum(coalesce(pl.area_ha, t.area_ha) * c.produtividade_sc_ha)
                           filter (where c.produtividade_sc_ha is not null)
                         / sum(coalesce(pl.area_ha, t.area_ha))
                           filter (where c.produtividade_sc_ha is not null), 1)
                end                                               as media_ponderada_sc_ha
      from talhao_do_franqueado f
      join talhao t on t.id = f.talhao_id
      join plantio pl on pl.talhao_id = t.id and pl.safra = $1
      left join colheita c on c.plantio_id = pl.id
      left join tenant tn on tn.id = f.franqueado_id
     group by f.franqueado_id, tn.nome
     order by media_ponderada_sc_ha desc nulls last`, [safra]);
  return rows;
}

/**
 * A safra aberta por município.
 *
 * É o recorte da DISTRIBUIDORA, que vende em vários territórios e não tem rede
 * para comparar. E não nomeia ninguém: agrupa pelo município da terra, que é
 * dado dela — está na propriedade que ela mesma cadastrou.
 *
 * Serve a qualquer tenant que venda em mais de um lugar; o service só devolve
 * cartão quando há mais de uma linha, porque com uma não há comparação.
 */
export async function safraPorMunicipio(cx, safra) {
  const { rows } = await cx.query(`
    select pr.municipio, pr.uf,
           count(distinct pl.id)::int                             as talhoes,
           -- Quantos produtores DELA há no município. Serve para calar a
           -- comparação com a região quando a carteira dela É a região: a
           -- diferença seria zero, e zero não diz nada.
           count(distinct pp.produtor_id)::int                    as produtores,
           count(c.produtividade_sc_ha)::int                      as colhidos,
           coalesce(sum(coalesce(pl.area_ha, t.area_ha))
                    filter (where c.produtividade_sc_ha is not null), 0) as area_colhida_ha,
           case when sum(coalesce(pl.area_ha, t.area_ha))
                     filter (where c.produtividade_sc_ha is not null) > 0
                then round(sum(coalesce(pl.area_ha, t.area_ha) * c.produtividade_sc_ha)
                           filter (where c.produtividade_sc_ha is not null)
                         / sum(coalesce(pl.area_ha, t.area_ha))
                           filter (where c.produtividade_sc_ha is not null), 1)
                end                                               as media_ponderada_sc_ha
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      join propriedade pr on pr.id = t.propriedade_id
      left join produtor_propriedade pp
             on pp.propriedade_id = pr.id and pp.fim is null
      left join colheita c on c.plantio_id = pl.id
     where pl.safra = $1 and pr.municipio is not null
     group by pr.municipio, pr.uf
     order by media_ponderada_sc_ha desc nulls last`, [safra]);
  return rows;
}

/**
 * Onde o produtor mais planta nesta safra — o município do benchmark dele.
 *
 * Ele pode ter terra em mais de um; comparar com "a região" sem dizer qual
 * seria escolher por ele. Vale a de maior área, e a resposta diz o nome.
 */
export async function municipioPrincipal(cx, safra, produtorId) {
  const { rows } = await cx.query(`
    select pr.municipio, pr.uf, sum(coalesce(pl.area_ha, t.area_ha)) as ha
      from plantio pl
      join talhao t on t.id = pl.talhao_id
      join propriedade pr on pr.id = t.propriedade_id
      join produtor_propriedade pp
        on pp.propriedade_id = pr.id and pp.fim is null and pp.produtor_id = $2
     where pl.safra = $1 and pr.municipio is not null
     group by pr.municipio, pr.uf
     order by ha desc
     limit 1`, [safra, produtorId]);
  return rows[0] ?? null;
}

/**
 * Chama a função de benchmark. Ela é `security definer` e tem a regra de
 * anonimato dentro: aqui não há o que conferir, e é de propósito — se o
 * chamador pudesse afrouxar, a regra não seria regra.
 */
export async function benchmarkRegional(cx, safra, municipio, uf, excluir) {
  const { rows } = await cx.query(
    'select * from app.benchmark_regional($1,$2,$3,$4)', [safra, municipio, uf, excluir]);
  return rows[0] ?? null;
}

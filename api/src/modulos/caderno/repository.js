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

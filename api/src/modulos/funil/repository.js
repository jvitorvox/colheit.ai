// SQL do módulo funil.

export async function abrir(cx, o) {
  const { rows } = await cx.query(`
    insert into oportunidade (tenant_id, produtor_id, safra, potencial_sc,
                              origem_potencial, responsavel_id)
    values (app.tenant_atual(), $1, $2, $3, $4, coalesce($5, app.usuario_atual()))
    returning id`,
  [o.produtorId, o.safra, o.potencialSc, o.origemPotencial, o.responsavelId]);
  return rows[0].id;
}

export async function buscar(cx, id) {
  const { rows } = await cx.query(`
    select o.*, p.nome as produtor, u.nome as responsavel
      from oportunidade o
      join produtor p on p.id = o.produtor_id
      left join usuario u on u.id = o.responsavel_id
     where o.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function porProdutorSafra(cx, produtorId, safra) {
  const { rows } = await cx.query(
    'select id from oportunidade where produtor_id = $1 and safra = $2', [produtorId, safra]);
  return rows[0]?.id ?? null;
}

export async function listar(cx, { safra, estagio } = {}) {
  const { rows } = await cx.query(`
    select o.id, o.safra, o.estagio, o.potencial_sc, o.origem_potencial,
           o.motivo_perda, o.concorrente, o.fechada_em, o.criado_em,
           p.nome as produtor, p.id as produtor_id, u.nome as responsavel
      from oportunidade o
      join produtor p on p.id = o.produtor_id
      left join usuario u on u.id = o.responsavel_id
     where ($1::text is null or o.safra = $1)
       and ($2::text is null or o.estagio = $2)
     order by o.potencial_sc desc nulls last, p.nome`, [safra ?? null, estagio ?? null]);
  return rows;
}

export async function mover(cx, id, estagio, motivoPerda, concorrente) {
  const { rowCount } = await cx.query(`
    update oportunidade
       set estagio = $2,
           motivo_perda = case when $2 = 'perdida' then $3 else null end,
           concorrente  = case when $2 = 'perdida' then $4 else concorrente end,
           fechada_em   = case when $2 in ('ganha','perdida') then now() else null end
     where id = $1`, [id, estagio, motivoPerda ?? null, concorrente ?? null]);
  return rowCount;
}

export const definirPotencial = (cx, id, potencialSc, origem) =>
  cx.query('update oportunidade set potencial_sc = $2, origem_potencial = $3 where id = $1',
    [id, potencialSc, origem]);

export const registrarEtapa = (cx, id, estagio, observacao) =>
  cx.query(`insert into oportunidade_etapa (oportunidade_id, estagio, por_usuario, observacao)
            values ($1,$2,app.usuario_atual(),$3)`, [id, estagio, observacao ?? null]);

export async function historico(cx, id) {
  const { rows } = await cx.query(`
    select e.estagio, e.em, e.observacao, u.nome as por
      from oportunidade_etapa e
      left join usuario u on u.id = e.por_usuario
     where e.oportunidade_id = $1
     order by e.em`, [id]);
  return rows;
}

/** O funil agregado: quantas, quanto de potencial, em cada estágio. */
export async function resumo(cx, safra) {
  const { rows } = await cx.query(`
    select o.estagio,
           count(*)::int as quantas,
           coalesce(sum(o.potencial_sc), 0)::numeric as potencial_sc
      from oportunidade o
     where ($1::text is null or o.safra = $1)
     group by o.estagio`, [safra ?? null]);
  return rows;
}

export async function penetracao(cx, safra, scPorHa) {
  const { rows } = await cx.query('select * from app.penetracao($1, $2)', [safra, scPorHa]);
  return rows;
}

export async function produtorNaCarteira(cx, produtorId) {
  const { rows } = await cx.query(
    'select 1 from produtor_vinculo where produtor_id = $1 and tenant_id = app.tenant_atual()',
    [produtorId]);
  return rows.length > 0;
}

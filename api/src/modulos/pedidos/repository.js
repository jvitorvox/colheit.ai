// SQL do módulo pedidos, e só dele.

export async function etapas(cx) {
  const { rows } = await cx.query(
    'select numero, nome, quem, notifica, faixa from etapa_pedido order by numero');
  return rows;
}

export async function franqueadoDoMunicipio(cx, municipio, uf) {
  const { rows } = await cx.query(
    'select app.franqueado_do_municipio($1, $2) as id', [municipio, uf]);
  return rows[0].id ?? null;
}

export async function localDaPropriedade(cx, propriedadeId) {
  const { rows } = await cx.query(
    'select municipio, uf from propriedade where id = $1', [propriedadeId]);
  return rows[0] ?? null;
}

export async function criar(cx, p) {
  const { rows } = await cx.query(`
    insert into pedido (tenant_id, produtor_id, propriedade_id, numero, safra,
                        franqueado_id, municipio, uf, canal)
    values (app.tenant_atual(), $1, $2, $3, $4, $5, $6, $7, $8)
    returning id`,
  [p.produtorId, p.propriedadeId, p.numero, p.safra, p.franqueadoId, p.municipio, p.uf,
    p.canal]);
  return rows[0].id;
}

export async function adicionarItens(cx, pedidoId, itens) {
  for (const i of itens) {
    await cx.query(`
      insert into pedido_item (pedido_id, produto_id, cultivar, quantidade, unidade,
                               preco_unit, royalties_sc, bonificada)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [pedidoId, i.produtoId ?? null, i.cultivar, i.quantidade, i.unidade ?? 'sc',
      i.precoUnit, i.royaltiesSc ?? null, i.bonificada ?? false]);
  }
}

export async function buscar(cx, id) {
  const { rows } = await cx.query(`
    select p.id, p.numero, p.safra, p.etapa, p.situacao, p.credito, p.canal,
           p.produtor_id, p.propriedade_id, p.tenant_id, p.franqueado_id,
           p.municipio, p.uf, p.criado_em,
           e.nome as etapa_nome, e.quem as etapa_quem, e.faixa as etapa_faixa,
           pr.nome as produtor,
           coalesce((select json_agg(json_build_object(
                       'cultivar', i.cultivar, 'quantidade', i.quantidade,
                       'unidade', i.unidade, 'precoUnit', i.preco_unit,
                       'royaltiesSc', i.royalties_sc, 'bonificada', i.bonificada))
                       from pedido_item i where i.pedido_id = p.id), '[]'::json) as itens,
           (select row_to_json(n) from (
              select numero, chave, valor, emitida_em, vencimento,
                     linha_digitavel, pago_em, origem
                from nota where pedido_id = p.id) n) as nota
      from pedido p
      join etapa_pedido e on e.numero = p.etapa
      join produtor pr on pr.id = p.produtor_id
     where p.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listar(cx, { produtorId, situacao } = {}) {
  const { rows } = await cx.query(`
    select p.id, p.numero, p.safra, p.etapa, p.situacao, p.credito, p.canal,
           e.nome as etapa_nome, pr.nome as produtor, p.municipio, p.uf, p.criado_em
      from pedido p
      join etapa_pedido e on e.numero = p.etapa
      join produtor pr on pr.id = p.produtor_id
     where ($1::uuid is null or p.produtor_id = $1)
       and ($2::text is null or p.situacao = $2)
     order by p.criado_em desc`, [produtorId ?? null, situacao ?? null]);
  return rows;
}

export async function historico(cx, pedidoId) {
  const { rows } = await cx.query(`
    select h.etapa, e.nome, h.em, h.observacao, h.retrocesso, u.nome as por
      from pedido_etapa h
      join etapa_pedido e on e.numero = h.etapa
      left join usuario u on u.id = h.por_usuario
     where h.pedido_id = $1
     order by h.em`, [pedidoId]);
  return rows;
}

export const registrarEtapa = (cx, pedidoId, etapa, observacao, retrocesso) =>
  cx.query(`insert into pedido_etapa (pedido_id, etapa, por_usuario, observacao, retrocesso)
            values ($1,$2,app.usuario_atual(),$3,$4)`,
    [pedidoId, etapa, observacao ?? null, retrocesso ?? false]);

export async function moverEtapa(cx, pedidoId, etapa) {
  const { rowCount } = await cx.query(
    'update pedido set etapa = $2 where id = $1', [pedidoId, etapa]);
  return rowCount;
}

export const definirSituacao = (cx, pedidoId, situacao) =>
  cx.query('update pedido set situacao = $2 where id = $1', [pedidoId, situacao]);

export const definirCredito = (cx, pedidoId, credito) =>
  cx.query('update pedido set credito = $2 where id = $1', [pedidoId, credito]);

export async function lancarNota(cx, pedidoId, n) {
  const { rows } = await cx.query(`
    insert into nota (pedido_id, numero, chave, valor, emitida_em, vencimento,
                      linha_digitavel, origem)
    values ($1,$2,$3,$4,$5,$6,$7,$8)
    returning id`,
    [pedidoId, n.numero, n.chave, n.valor, n.emitidaEm, n.vencimento,
      n.linhaDigitavel, n.origem]);
  return rows[0].id;
}

export async function temNota(cx, pedidoId) {
  const { rows } = await cx.query('select 1 from nota where pedido_id = $1', [pedidoId]);
  return rows.length > 0;
}

export const marcarPago = (cx, pedidoId, quando) =>
  cx.query('update nota set pago_em = coalesce($2::date, current_date) where pedido_id = $1',
    [pedidoId, quando]);

export const enfileirarAviso = (cx, produtorId, pedidoId, etapa, texto) =>
  cx.query(`insert into notificacao (produtor_id, pedido_id, etapa, texto)
            values ($1,$2,$3,$4)`, [produtorId, pedidoId, etapa, texto]);

export async function avisos(cx, { pendentes } = {}) {
  const { rows } = await cx.query(`
    select id, pedido_id, etapa, texto, criada_em, enviada_em
      from notificacao
     where ($1::boolean is not true or enviada_em is null)
     order by criada_em desc`, [pendentes ?? null]);
  return rows;
}

export async function produtorTemVinculo(cx, produtorId) {
  const { rows } = await cx.query(
    'select 1 from produtor_vinculo where produtor_id = $1 and tenant_id = app.tenant_atual()',
    [produtorId]);
  return rows.length > 0;
}

export async function gargaloPorEtapa(cx) {
  const { rows } = await cx.query('select * from app.gargalo_por_etapa()');
  return rows;
}

/**
 * A safra corrente, deduzida do que foi vendido.
 *
 * Constante no código envelhece em silêncio: vira o ano, a tela fica vazia e
 * ninguém liga a coisa à outra. O dado sabe em que safra a empresa está.
 */
export async function safraMaisRecente(cx) {
  const { rows } = await cx.query(`
    select safra from pedido
     where situacao <> 'cancelado'
     order by criado_em desc limit 1`);
  return rows[0]?.safra ?? null;
}

/* ----------------------------------------------------- preparo (Dia Zero) */

export async function preparo(cx, pedidoId) {
  const { rows } = await cx.query(
    'select item, feito_em from preparo_pedido where pedido_id = $1', [pedidoId]);
  return rows;
}

export async function marcarPreparo(cx, pedidoId, item, feito) {
  await cx.query(`
    insert into preparo_pedido (pedido_id, item, feito_em)
    values ($1, $2, case when $3 then now() else null end)
    on conflict (pedido_id, item) do update
      set feito_em = case when $3 then coalesce(preparo_pedido.feito_em, now()) else null end`,
  [pedidoId, item, feito]);
}

/**
 * O volume da safra separado por canal: venda direta e venda pela distribuidora.
 *
 * Para a revenda é curiosidade; para o FRANQUEADO é o negócio dele. Ele não
 * opera a venda que a distribuidora fez — enxerga porque o pedido carimbou o
 * município dele —, e essa separação é a única forma de ele saber quanto do
 * território dele passou por terceiro.
 */
export async function vendaPorCanal(cx, safra) {
  const { rows } = await cx.query(`
    select p.canal,
           count(distinct p.id)::int                                   as pedidos,
           count(distinct p.produtor_id)::int                          as produtores,
           coalesce(sum(i.quantidade), 0)                              as quantidade,
           coalesce(sum(i.quantidade) filter (where i.bonificada), 0)   as bonificada,
           coalesce(sum(i.quantidade * coalesce(i.preco_unit, 0))
                    filter (where not i.bonificada), 0)                as receita
      from pedido p
      join pedido_item i on i.pedido_id = p.id
     where p.situacao <> 'cancelado'
       and ($1::text is null or p.safra = $1)
     group by p.canal
     order by p.canal`, [safra ?? null]);
  return rows;
}

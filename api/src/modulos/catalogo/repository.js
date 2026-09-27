// SQL do módulo catálogo.

export async function criarProduto(cx, p) {
  const { rows } = await cx.query(`
    insert into produto (tenant_id, categoria, nome, cultura, unidade, embalagem)
    values (app.tenant_atual(), $1, $2, $3, $4, $5)
    returning id`, [p.categoria, p.nome, p.cultura, p.unidade, p.embalagem]);
  return rows[0].id;
}

export async function listarProdutos(cx, { categoria, safra, incluirInativos } = {}) {
  const { rows } = await cx.query(`
    select p.id, p.categoria, p.nome, p.cultura, p.unidade, p.embalagem, p.ativo,
           coalesce(
             (select json_agg(json_build_object(
                       'canal', x.canal, 'safra', x.safra, 'valor', x.valor,
                       'royaltiesSc', x.royalties_sc, 'vigenteDe', x.vigente_de)
                       order by x.canal)
                from (
                  select distinct on (pr.canal) pr.canal, pr.safra, pr.valor,
                         pr.royalties_sc, pr.vigente_de
                    from preco pr
                   where pr.produto_id = p.id
                     and ($2::text is null or pr.safra = $2)
                     and pr.vigente_de <= current_date
                   order by pr.canal, pr.vigente_de desc
                ) x),
             '[]'::json) as precos
      from produto p
     where ($1::text is null or p.categoria = $1)
       and ($3::boolean is true or p.ativo)
     order by p.nome`, [categoria ?? null, safra ?? null, incluirInativos ?? false]);
  return rows;
}

export async function buscarProduto(cx, id) {
  const { rows } = await cx.query('select * from produto where id = $1', [id]);
  return rows[0] ?? null;
}

export const arquivarProduto = (cx, id, ativo) =>
  cx.query('update produto set ativo = $2 where id = $1', [id, ativo]);

export async function definirPreco(cx, p) {
  const { rows } = await cx.query(`
    insert into preco (produto_id, safra, canal, valor, royalties_sc, vigente_de)
    values ($1,$2,$3,$4,$5, coalesce($6::date, current_date))
    on conflict (produto_id, safra, canal, vigente_de)
      do update set valor = excluded.valor, royalties_sc = excluded.royalties_sc
    returning id`,
  [p.produtoId, p.safra, p.canal, p.valor, p.royaltiesSc, p.vigenteDe]);
  return rows[0].id;
}

/**
 * O preço que vale hoje para este produto, safra e canal.
 *
 * `distinct on` com ordem por vigência: a tabela guarda o histórico, e a
 * consulta devolve a linha que estava valendo — é o que permite reajustar sem
 * apagar o que foi cobrado antes.
 */
export async function precoVigente(cx, { produtoId, safra, canal }) {
  const { rows } = await cx.query(`
    select valor, royalties_sc, vigente_de
      from preco
     where produto_id = $1 and safra = $2 and canal = $3 and vigente_de <= current_date
     order by vigente_de desc
     limit 1`, [produtoId, safra, canal]);
  return rows[0] ?? null;
}

export async function historicoDePreco(cx, produtoId) {
  const { rows } = await cx.query(`
    select safra, canal, valor, royalties_sc, vigente_de
      from preco where produto_id = $1
     order by safra desc, canal, vigente_de desc`, [produtoId]);
  return rows;
}

/**
 * O que a bonificada custa em preço médio.
 *
 * Separar volume de receita é o que impede o indicador de mentir: semente de
 * geração de demanda entra no volume e não entra no faturamento.
 */
export async function resumoDeVenda(cx, safra) {
  const { rows } = await cx.query(`
    select coalesce(i.produto_id::text, i.cultivar) as chave,
           coalesce(pr.nome, i.cultivar) as produto,
           sum(i.quantidade)::numeric as quantidade,
           sum(i.quantidade) filter (where i.bonificada)::numeric as bonificada,
           sum(i.quantidade * coalesce(i.preco_unit, 0))
             filter (where not i.bonificada)::numeric as receita,
           sum(i.quantidade * coalesce(i.royalties_sc, 0))::numeric as royalties
      from pedido_item i
      join pedido pe on pe.id = i.pedido_id
      left join produto pr on pr.id = i.produto_id
     where pe.situacao <> 'cancelado'
       and ($1::text is null or pe.safra = $1)
     group by 1, 2
     order by quantidade desc`, [safra ?? null]);
  return rows;
}

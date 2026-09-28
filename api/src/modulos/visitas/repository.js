// SQL do módulo visitas.

/**
 * Grava a visita. Devolve null quando o reenvio já havia gravado esta mesma.
 *
 * `on conflict` em vez de tentar-e-tratar-o-erro: dentro de uma transação, uma
 * violação de unicidade aborta tudo, e a consulta seguinte falharia em cima do
 * que já está desfeito. O `do nothing` mantém a transação viva e resolve de
 * uma vez o reenvio e a corrida entre dois reenvios simultâneos.
 *
 * A inferência aponta o índice parcial de propósito: outras violações — o
 * `relato_id unique`, por exemplo — continuam estourando como devem.
 */
export async function registrar(cx, v) {
  const { rows } = await cx.query(`
    insert into visita (tenant_id, produtor_id, propriedade_id, talhao_id, usuario_id,
                        em, canal, duracao_seg, estagio, estande, observacao, relato_id,
                        cliente_id)
    values (app.tenant_atual(), $1, $2, $3, app.usuario_atual(),
            coalesce($4::timestamptz, now()), $5, $6, $7, $8, $9, $10, $11)
    on conflict (tenant_id, cliente_id) where cliente_id is not null do nothing
    returning id`,
  [v.produtorId, v.propriedadeId, v.talhaoId, v.em, v.canal, v.duracaoSeg,
    v.estagio, v.estande, v.observacao, v.relatoId, v.clienteId]);
  return rows[0]?.id ?? null;
}

/** A visita que este reenvio já gravou, se gravou. */
export async function porClienteId(cx, clienteId) {
  const { rows } = await cx.query(
    'select id from visita where cliente_id = $1', [clienteId]);
  return rows[0]?.id ?? null;
}

export async function buscar(cx, id) {
  const { rows } = await cx.query(`
    select v.*, p.nome as produtor, u.nome as consultor, t.nome as talhao
      from visita v
      join produtor p on p.id = v.produtor_id
      left join usuario u on u.id = v.usuario_id
      left join talhao t on t.id = v.talhao_id
     where v.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listar(cx, { produtorId, desde } = {}) {
  const { rows } = await cx.query(`
    select v.id, v.em, v.canal, v.duracao_seg, v.estagio, v.estande, v.observacao,
           p.nome as produtor, u.nome as consultor, t.nome as talhao,
           -- Os ids das fotos, não a contagem: a lista já monta as miniaturas
           -- sem uma segunda ida ao servidor por visita.
           coalesce(array_agg(vm.midia_id order by vm.ordem)
                    filter (where vm.midia_id is not null), '{}') as fotos
      from visita v
      join produtor p on p.id = v.produtor_id
      left join usuario u on u.id = v.usuario_id
      left join talhao t on t.id = v.talhao_id
      left join visita_midia vm on vm.visita_id = v.id
     where ($1::uuid is null or v.produtor_id = $1)
       and ($2::timestamptz is null or v.em >= $2)
     group by v.id, p.nome, u.nome, t.nome
     order by v.em desc
     limit 200`, [produtorId ?? null, desde ?? null]);
  return rows;
}

export async function fila(cx) {
  const { rows } = await cx.query('select * from app.fila_de_visita()');
  return rows;
}

export async function produtorNaCarteira(cx, produtorId) {
  const { rows } = await cx.query(
    'select 1 from produtor_vinculo where produtor_id = $1 and tenant_id = app.tenant_atual()',
    [produtorId]);
  return rows.length > 0;
}

/**
 * Como a H1 está indo, por canal.
 *
 * Mediana, não média: uma visita que ficou aberta a tarde inteira porque o
 * consultor esqueceu a tela não pode mover o número que decide o produto.
 */
export async function medicaoH1(cx, dias) {
  const { rows } = await cx.query(`
    select canal,
           count(*)::int as visitas,
           count(duracao_seg)::int as medidas,
           percentile_cont(0.5) within group (order by duracao_seg)::int as mediana_seg,
           percentile_cont(0.9) within group (order by duracao_seg)::int as p90_seg
      from visita
     where em >= now() - make_interval(days => $1)
     group by canal
     order by canal`, [dias]);
  return rows;
}

/**
 * Pendura as fotos na visita.
 *
 * `on conflict do nothing` porque o reenvio é o normal deste caminho: a mesma
 * visita com as mesmas fotos chega de novo quando o sinal cai no meio do envio,
 * e a chave primária do par já diz que o vínculo é um só.
 */
export async function vincularMidia(cx, visitaId, midiaIds) {
  await cx.query(`
    insert into visita_midia (visita_id, midia_id, ordem)
    select $1, m.id, m.ord from unnest($2::uuid[]) with ordinality as m(id, ord)
    on conflict do nothing`, [visitaId, midiaIds]);
}

export async function midiaDaVisita(cx, visitaId) {
  const { rows } = await cx.query(`
    select m.id, m.mime, m.bytes, vm.ordem
      from visita_midia vm join midia m on m.id = vm.midia_id
     where vm.visita_id = $1
     order by vm.ordem`, [visitaId]);
  return rows;
}

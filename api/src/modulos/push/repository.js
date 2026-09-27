// SQL do módulo push.
//
// Duas famílias de função aqui, e elas não se misturam:
//   · as que recebem `cx` vêm de comContexto e obedecem à política — é como o
//     produtor assina a própria caixa;
//   · as de despacho recebem o pool do DONO, porque o job atravessa tenants:
//     a fila é de toda a plataforma e não pertence a empresa nenhuma.

/* ------------------------------------------------- dentro de uma requisição */

export async function assinar(cx, a) {
  const { rows } = await cx.query(`
    insert into assinatura_push (produtor_id, usuario_id, endpoint, p256dh, auth, agente)
    values (app.produtor_atual(), app.usuario_atual(), $1, $2, $3, $4)
    on conflict (endpoint) do update
      set p256dh = excluded.p256dh, auth = excluded.auth,
          agente = excluded.agente, falhas = 0
    returning id`, [a.endpoint, a.p256dh, a.auth, a.agente]);
  return rows[0].id;
}

export async function desassinar(cx, endpoint) {
  const { rowCount } = await cx.query(
    'delete from assinatura_push where endpoint = $1', [endpoint]);
  return rowCount;
}

export async function minhasAssinaturas(cx) {
  const { rows } = await cx.query(
    'select id, endpoint, agente, criada_em, ultima_em from assinatura_push order by criada_em');
  return rows;
}

/* ------------------------------------------------------------- despacho (dono) */

export async function pendentes(dono, limite) {
  const { rows } = await dono.query(`
    select n.id, n.produtor_id, n.pedido_id, n.etapa, n.texto, n.tentativas
      from notificacao n
     where n.enviada_em is null and n.descartada_em is null
     order by n.criada_em
     limit $1`, [limite]);
  return rows;
}

export async function assinaturasDoProdutor(dono, produtorId) {
  const { rows } = await dono.query(
    'select id, endpoint, p256dh, auth from assinatura_push where produtor_id = $1',
    [produtorId]);
  return rows;
}

export const marcarEnviada = (dono, id) =>
  dono.query('update notificacao set enviada_em = now() where id = $1', [id]);

export const marcarDescartada = (dono, id, motivo) =>
  dono.query('update notificacao set descartada_em = now(), motivo = $2 where id = $1',
    [id, motivo]);

export const contarTentativa = (dono, id, motivo) =>
  dono.query('update notificacao set tentativas = tentativas + 1, motivo = $2 where id = $1',
    [id, motivo]);

export const registrarEntrega = (dono, assinaturaId) =>
  dono.query('update assinatura_push set ultima_em = now(), falhas = 0 where id = $1',
    [assinaturaId]);

export const registrarFalha = (dono, assinaturaId) =>
  dono.query('update assinatura_push set falhas = falhas + 1 where id = $1', [assinaturaId]);

export const removerAssinatura = (dono, assinaturaId) =>
  dono.query('delete from assinatura_push where id = $1', [assinaturaId]);

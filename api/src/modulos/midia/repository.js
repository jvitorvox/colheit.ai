// SQL do módulo mídia.

export async function porHash(dono, tenantId, sha256) {
  const { rows } = await dono.query(
    'select id, chave, mime, tipo, bytes from midia where tenant_id = $1 and sha256 = $2',
    [tenantId, sha256]);
  return rows[0] ?? null;
}

export async function registrar(dono, m) {
  const { rows } = await dono.query(`
    insert into midia (tenant_id, produtor_id, tipo, mime, bytes, sha256, chave)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`,
  [m.tenantId, m.produtorId, m.tipo, m.mime, m.bytes, m.sha256, m.chave]);
  return rows[0].id;
}

/** Leitura passa pela política: é ela que decide antes de o byte sair. */
export async function buscar(cx, id) {
  const { rows } = await cx.query(
    'select id, tipo, mime, bytes, chave, criado_em from midia where id = $1', [id]);
  return rows[0] ?? null;
}

export async function listarDoTenant(cx) {
  const { rows } = await cx.query(
    'select id, tipo, mime, bytes, criado_em from midia order by criado_em desc limit 200');
  return rows;
}

/**
 * Carimba o produtor só onde ainda não há um.
 *
 * `produtor_id is null` no where não é zelo: sem ele, pendurar a mesma foto
 * numa segunda visita moveria a foto de um produtor para outro — e o primeiro
 * deixaria de ver o que já via no portal dele.
 */
export async function atribuirAoProdutor(cx, ids, produtorId) {
  const { rowCount } = await cx.query(
    'update midia set produtor_id = $2 where id = any($1::uuid[]) and produtor_id is null',
    [ids, produtorId]);
  return rowCount;
}

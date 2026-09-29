// SQL do autoatendimento. Tudo por função `security definer`, pelo mesmo
// motivo do 010: isto roda antes de existir empresa, e o papel de aplicação
// não tem permissão nenhuma em `tenant` — a 008 tirou insert, update e delete
// dele de propósito.

export async function abrirCadastro(cx, c, hash, horas) {
  const { rows } = await cx.query(
    'select * from app.abrir_cadastro($1,$2,$3,$4,$5,$6,$7)',
    [c.nome, c.documento, c.tipo, c.gestor, c.email, hash, horas]);
  return rows[0]?.situacao ?? null;
}

export async function confirmarCadastro(cx, hash, senhaHash) {
  const { rows } = await cx.query(
    'select * from app.confirmar_cadastro($1, $2)', [hash, senhaHash]);
  return rows[0] ?? null;
}

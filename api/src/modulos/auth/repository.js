// SQL do módulo auth. Tudo aqui passa por função `security definer`, porque o
// login acontece antes de existir contexto — o papel de aplicação não tem
// permissão direta em nenhuma tabela de autenticação.

export async function bloqueado(cx, chave) {
  const { rows } = await cx.query('select app.login_bloqueado($1) as b', [chave]);
  return rows[0].b;
}

export const registrarFalha = (cx, chave) => cx.query('select app.login_falhou($1)', [chave]);
export const limparFalhas = (cx, chave) => cx.query('select app.login_ok($1)', [chave]);

export async function credencialDeUsuario(cx, email) {
  const { rows } = await cx.query('select * from app.credencial_usuario($1)', [email]);
  return rows[0] ?? null;
}

export const criarCodigo = (cx, telefone, hash, minutos) =>
  cx.query('select app.criar_codigo($1, $2, $3)', [telefone, hash, minutos]);

export async function consumirCodigo(cx, telefone, hash) {
  const { rows } = await cx.query('select app.consumir_codigo($1, $2) as id', [telefone, hash]);
  return rows[0].id ?? null;
}

export const convidarProdutor = (cx, produtorId, telefone) =>
  cx.query('select app.convidar_produtor($1, $2)', [produtorId, telefone]);

/* Quem sou eu — já dentro de um contexto válido. */

export async function usuarioAtual(cx) {
  const { rows } = await cx.query(`
    select u.id, u.nome, u.email, u.papel,
           t.id as tenant_id, t.nome as tenant, t.tipo as tenant_tipo
      from usuario u join tenant t on t.id = u.tenant_id
     where u.id = app.usuario_atual()`);
  return rows[0] ?? null;
}

export async function produtorAtual(cx) {
  const { rows } = await cx.query(`
    select p.id, p.nome,
           coalesce((select json_agg(json_build_object('tenantId', v.tenant_id, 'desde', v.criado_em)
                                     order by v.criado_em)
                       from produtor_vinculo v where v.produtor_id = p.id), '[]'::json) as vinculos
      from produtor p where p.id = app.produtor_atual()`);
  return rows[0] ?? null;
}

/* Recuperação de senha — também antes de haver contexto, também por função. */

export async function abrirRecuperacao(cx, email, hash, minutos) {
  const { rows } = await cx.query(
    'select * from app.abrir_recuperacao($1, $2, $3)', [email, hash, minutos]);
  return rows[0] ?? null;
}

export const abrirRecuperacaoPeloGestor = (cx, usuarioId, hash, horas) =>
  cx.query('select app.abrir_recuperacao_pelo_gestor($1, $2, $3)', [usuarioId, hash, horas]);

export async function consumirRecuperacao(cx, hash, senhaHash) {
  const { rows } = await cx.query(
    'select app.consumir_recuperacao($1, $2) as id', [hash, senhaHash]);
  return rows[0].id ?? null;
}

// A moderação inteira cabe em quatro chamadas, e isso é de propósito: o
// alcance da conta de plataforma é exatamente o que estas funções devolvem.
// Ver o que ela pode é ler este arquivo.

export async function quemSouEu(cx) {
  const { rows } = await cx.query('select * from app.plataforma_eu()');
  return rows[0] ?? null;
}

export async function empresas(cx) {
  const { rows } = await cx.query('select * from app.moderacao_empresas()');
  return rows;
}

export async function pendentes(cx) {
  const { rows } = await cx.query('select * from app.moderacao_pendentes()');
  return rows;
}

export const moderar = (cx, tenantId, acao, nota) =>
  cx.query('select app.moderar_empresa($1, $2, $3)', [tenantId, acao, nota]);

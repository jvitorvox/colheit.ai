import { app } from './db.js';

/**
 * Roda uma função com tenant e usuário no contexto da transação.
 *
 * São as duas dimensões de isolamento: a empresa diz de quem é o dado, o
 * usuário diz se é gestor (empresa inteira) ou consultor (só a carteira).
 * Usuário nulo é job e integração — roda no tenant, sem pessoa por trás.
 */
export async function comContexto({ tenant, usuario = null }, fn) {
  const cx = await app.connect();
  try {
    await cx.query('begin');
    await cx.query('select set_config($1,$2,true), set_config($3,$4,true)', [
      'app.tenant_id', tenant ?? '',
      'app.usuario_id', usuario ?? '',
    ]);
    const saida = await fn(cx);
    await cx.query('commit');
    return saida;
  } catch (erro) {
    await cx.query('rollback');
    throw erro;
  } finally {
    cx.release();
  }
}

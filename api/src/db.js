import pg from 'pg';

// Dois pools, um por papel — a separação da seção 13 existe aqui dentro.
//
//   dono  → migração, job, carga. Passa por cima da política.
//   app   → requisição. Obedece sempre, porque não é dono de nada.
//
// Nenhuma rota deve importar `dono`.

const base = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5433),
  database: process.env.POSTGRES_DB ?? 'colheitai',
};

export const dono = new pg.Pool({
  ...base,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

export const app = new pg.Pool({
  ...base,
  user: process.env.APP_DB_USER,
  password: process.env.APP_DB_PASSWORD,
});

/**
 * Roda uma função dentro de uma transação com o tenant no contexto.
 *
 * O `true` de set_config é o que importa: prende o valor à transação. Sem ele
 * o tenant sobreviveria no socket e vazaria para o próximo request que
 * reaproveitasse a mesma conexão do pool.
 */
export async function comTenant(tenantId, fn) {
  const cx = await app.connect();
  try {
    await cx.query('begin');
    await cx.query('select set_config($1, $2, true)', ['app.tenant_id', tenantId ?? '']);
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

export async function encerrar() {
  await Promise.all([dono.end(), app.end()]);
}

import { app } from './db.js';

/**
 * Roda uma função dentro de uma transação com o contexto no lugar.
 *
 * São três eixos, e eles nunca convivem:
 *
 *   tenant + usuario → sessão de empresa. A empresa diz de quem é o dado; o
 *                      usuário diz se é gestor (empresa inteira) ou consultor
 *                      (só a carteira). Sem usuário é job ou integração.
 *   produtor         → sessão do portal. Ele é global e vê o que é dele em
 *                      todas as revendas — é a porta única.
 *   plataforma       → quem modera cadastro. Não tem tenant, e é justamente
 *                      por não ter que ele não enxerga dado de negócio nenhum:
 *                      sem tenant no contexto nenhuma política casa, e as
 *                      tabelas de negócio respondem vazio. O que ele vê são as
 *                      funções de moderação, e só elas.
 *
 * O `true` do set_config é o que importa: prende o valor à transação. Sem ele o
 * contexto sobreviveria no socket e vazaria para o próximo request que
 * reaproveitasse a mesma conexão do pool.
 */
export async function comContexto(ctx, fn) {
  const cx = await app.connect();
  try {
    await cx.query('begin');
    await cx.query(
      `select set_config($1,$2,true), set_config($3,$4,true),
              set_config($5,$6,true), set_config($7,$8,true)`,
      [
        'app.tenant_id', ctx?.tenant ?? '',
        'app.usuario_id', ctx?.usuario ?? '',
        'app.produtor_id', ctx?.produtor ?? '',
        'app.plataforma_id', ctx?.plataforma ?? '',
      ],
    );
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

/**
 * Para o que acontece ANTES de haver contexto — o login. Só as funções
 * `security definer` de autenticação devem ser chamadas daqui: nenhuma tabela
 * de negócio é acessível sem tenant ou produtor no contexto, por construção.
 */
export async function semContexto(fn) {
  const cx = await app.connect();
  try {
    await cx.query('begin');
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

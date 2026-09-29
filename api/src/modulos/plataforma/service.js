/**
 * A área de quem modera cadastro.
 *
 * Existe porque o autoatendimento deixou um limite conhecido: quem confirma
 * primeiro fica com o CNPJ, e desfazer isso era ligação para o suporte sem
 * ferramenta nenhuma.
 *
 * É fila DEPOIS, não portão antes — confirmou o e-mail, a empresa existe e a
 * pessoa entra na hora. E é a conta de menor alcance que dava para fazer: ela
 * vê cadastro, não vê dado de cliente. A garantia não é uma checagem nesta
 * camada; é que a sessão não põe tenant no contexto, e sem tenant nenhuma
 * política de negócio casa. O que sobra é o que as funções de moderação
 * devolvem.
 */
import { comContexto } from '../../contexto.js';
import { NaoEncontrado } from '../../http/erros.js';
import { umDe, uuidValido } from '../cadastro/validar.js';
import * as repo from './repository.js';

const ACOES = ['aprovar', 'recusar', 'reabrir'];

// Entrar não mora aqui: o módulo auth é dono das identidades e do freio de
// força bruta, e é lá que fica `entrarComoPlataforma`. Este módulo é a fila.

export function quemSouEu(ctx) {
  return comContexto(ctx, async (cx) => {
    const eu = await repo.quemSouEu(cx);
    if (!eu) throw new NaoEncontrado('conta de plataforma');
    return { tipo: 'plataforma', ...eu };
  });
}

/**
 * A fila: o que nasceu pela tela, e o que ainda está a caminho.
 *
 * As duas listas juntas numa chamada porque são a mesma tela e a mesma decisão
 * — o pendente é o aviso de que um CNPJ está prestes a ser reivindicado.
 */
export function fila(ctx) {
  return comContexto(ctx, async (cx) => ({
    empresas: await repo.empresas(cx),
    pendentes: await repo.pendentes(cx),
  }));
}

/**
 * Aprovar, recusar ou reabrir.
 *
 * O motivo é exigido pelo banco na recusa, e não aqui. Recusar desliga o
 * sistema de uma empresa inteira e devolve o CNPJ dela; quem atender a ligação
 * precisa ler por quê, e uma regra dessas não pode depender de a rota lembrar.
 */
export function moderar(ctx, tenantId, corpo = {}) {
  uuidValido(tenantId, 'id');
  const acao = umDe(corpo.acao, ACOES, 'acao');
  const nota = corpo.nota === undefined ? null : String(corpo.nota).trim().slice(0, 500);

  return comContexto(ctx, async (cx) => {
    await repo.moderar(cx, tenantId, acao, nota);
    // Só o que aconteceu: a tela recarrega a fila inteira em seguida, porque
    // moderar uma empresa mexe na lista de pendentes também.
    return { acao };
  });
}

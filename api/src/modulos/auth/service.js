import { comContexto, semContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { gerarHash, conferir, gerarCodigo, hashCodigo } from './senha.js';
import { tokenDeUsuario, tokenDeProdutor } from './token.js';

const CREDENCIAL_INVALIDA = 'e-mail ou senha inválidos';
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

/**
 * Login do usuário de tenant.
 *
 * A resposta é a mesma para e-mail que não existe, usuário sem senha definida
 * e senha errada. Distinguir os casos seria entregar quais e-mails existem na
 * plataforma — e a lista de clientes de cada franqueado sai daí.
 */
export function entrarComoUsuario({ email, senha }) {
  const chave = String(email ?? '').trim().toLowerCase();
  if (!chave || !senha) throw new ErroDeUso(CREDENCIAL_INVALIDA);

  // A recusa é devolvida, não lançada de dentro da transação: exceção aqui
  // provoca rollback, e o rollback apagaria o registro da tentativa falha —
  // o freio de força bruta zeraria sozinho a cada erro.
  return semContexto(async (cx) => {
    if (await repo.bloqueado(cx, chave)) return { recusa: 'tentativas demais; tente de novo mais tarde' };

    const cred = await repo.credencialDeUsuario(cx, chave);
    const ok = await conferir(senha, cred?.senha_hash ?? null);

    if (!ok) {
      await repo.registrarFalha(cx, chave);
      return { recusa: CREDENCIAL_INVALIDA };
    }

    await repo.limparFalhas(cx, chave);
    return {
      token: tokenDeUsuario({ id: cred.id, tenantId: cred.tenant_id, papel: cred.papel }),
      usuario: { id: cred.id, nome: cred.nome, papel: cred.papel },
    };
  }).then(recusarOuSeguir);
}

function recusarOuSeguir(r) {
  if (r.recusa) throw new ErroDeUso(r.recusa);
  return r;
}

/**
 * Pede o código do produtor.
 *
 * Responde igual para telefone conhecido ou não, pelo mesmo motivo do login —
 * e o código é criado de qualquer forma: quem não tiver acesso cadastrado não
 * passa da conferência adiante, e nada é revelado no caminho.
 *
 * O envio não acontece aqui. Quem entrega é o módulo do WhatsApp, e esta é a
 * costura entre os dois.
 */
export function pedirCodigo({ telefone }) {
  const tel = soDigitos(telefone);
  if (tel.length < 10 || tel.length > 15) throw new ErroDeUso('telefone inválido', 'telefone');

  return semContexto(async (cx) => {
    if (await repo.bloqueado(cx, tel)) return { recusa: 'tentativas demais; tente de novo mais tarde' };
    const codigo = gerarCodigo();
    await repo.criarCodigo(cx, tel, hashCodigo(codigo, tel), 10);
    return { telefone: tel, codigo };   // a rota decide se devolve o código
  }).then(recusarOuSeguir);
}

export function entrarComoProdutor({ telefone, codigo }) {
  const tel = soDigitos(telefone);
  const cod = soDigitos(codigo);
  if (!tel || cod.length !== 6) throw new ErroDeUso('telefone ou código inválidos');

  return semContexto(async (cx) => {
    if (await repo.bloqueado(cx, tel)) return { recusa: 'tentativas demais; tente de novo mais tarde' };

    const produtorId = await repo.consumirCodigo(cx, tel, hashCodigo(cod, tel));
    if (!produtorId) {
      await repo.registrarFalha(cx, tel);
      return { recusa: 'telefone ou código inválidos' };
    }

    await repo.limparFalhas(cx, tel);
    return { token: tokenDeProdutor({ id: produtorId }), produtorId };
  }).then(recusarOuSeguir);
}

/** O convite que a H2 mede: sai de quem tem vínculo, no momento do contrato. */
export function convidarProdutor(ctx, { produtorId, telefone }) {
  const tel = soDigitos(telefone);
  if (tel.length < 10 || tel.length > 15) throw new ErroDeUso('telefone inválido', 'telefone');
  if (!produtorId) throw new ErroDeUso('produtorId é obrigatório', 'produtorId');

  return comContexto(ctx, async (cx) => {
    await repo.convidarProdutor(cx, produtorId, tel);
    return { convidado: true };
  });
}

/** Só o gestor do próprio tenant define senha de alguém. */
export function definirSenha(ctx, usuarioId, { senha }) {
  if (ctx.papel !== 'gestor') throw new ErroDeUso('só gestor define senha de usuário');
  return comContexto(ctx, async (cx) => {
    // A RLS de `usuario` já limita ao tenant do contexto: se a leitura não
    // trouxer nada, ou não existe ou é de outra empresa — e a resposta é a mesma.
    const { rows } = await cx.query('select id from usuario where id = $1', [usuarioId]);
    if (rows.length === 0) throw new NaoEncontrado('usuário');
    await repo.definirSenha(cx, usuarioId, await gerarHash(senha));
    return { definida: true };
  });
}

export function quemSouEu(ctx) {
  return comContexto(ctx, async (cx) => {
    if (ctx.produtor) {
      const p = await repo.produtorAtual(cx);
      if (!p) throw new NaoEncontrado('produtor');
      return { tipo: 'produtor', ...p };
    }
    const u = await repo.usuarioAtual(cx);
    if (!u) throw new NaoEncontrado('usuário');
    return { tipo: 'usuario', ...u };
  });
}

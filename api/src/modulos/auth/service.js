import { comContexto, semContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { gerarHash, conferir, gerarCodigo, hashCodigo, gerarToken, hashToken } from './senha.js';
import { tokenDeUsuario, tokenDeProdutor } from './token.js';
import { correioLigado, enviarRecuperacao, enderecoPublico } from './correio.js';

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

/* ------------------------------------------------- recuperação de senha */

// Dois prazos, por motivos diferentes — como as duas durações de sessão.
//
//   esqueci → 30 min. Quem pediu está no teclado agora, e o link cai numa
//             caixa de e-mail que pode ser lida de outro lugar.
//   gestor  → 24 h. É entregue fora do sistema, em mãos ou por mensagem, para
//             alguém que talvez esteja em lavoura sem sinal. Meia hora seria
//             um link que morre antes de ser aberto.
const MINUTOS_ESQUECI = 30;
const HORAS_GESTOR = 24;

const linkDeSenha = (base, token) => `${base}/empresa#senha=${token}`;

/**
 * Esqueci minha senha.
 *
 * Não cria bilhete nenhum quando não há correio: guardar um token que ninguém
 * pode receber só encheria a tabela e, pior, encostaria no freio de um minuto
 * atrapalhando um pedido legítimo logo depois.
 *
 * Quando há correio, a resposta é a mesma para e-mail conhecido, desconhecido
 * e pedido repetido dentro do minuto — pelo mesmo motivo do login. O único
 * caso que responde diferente é o ambiente sem correio, e aí o que se revela é
 * como a instalação foi montada, não quem tem conta nela.
 */
export function pedirRecuperacao({ email }) {
  const chave = String(email ?? '').trim().toLowerCase();
  if (!chave) throw new ErroDeUso('e-mail é obrigatório', 'email');
  if (!correioLigado()) return Promise.resolve({ semCorreio: true });

  return semContexto(async (cx) => {
    const token = gerarToken();
    const u = await repo.abrirRecuperacao(cx, chave, hashToken(token), MINUTOS_ESQUECI);
    return u ? { token, ...u } : null;
  }).then(async (r) => {
    if (!r) return { enviado: false };
    await enviarRecuperacao({
      nome: r.nome,
      email: r.email,
      url: linkDeSenha(enderecoPublico(), r.token),
      minutos: MINUTOS_ESQUECI,
    });
    return { enviado: true, token: r.token };   // a rota decide se devolve
  });
}

/**
 * O gestor abre acesso para alguém da equipe.
 *
 * Isto substituiu o gestor digitar uma senha e falar ela pelo WhatsApp. Senha
 * que duas pessoas conhecem não é senha: quem reaproveita a mesma em outro
 * sistema passa a ter esse sistema conhecido também. O que o gestor entrega
 * agora é um bilhete de uma viagem só — e quem escolhe a senha é o dono dela.
 *
 * O token volta UMA vez, e só aqui. Não fica legível em lugar nenhum depois:
 * o banco guarda o hash.
 */
export function abrirAcesso(ctx, usuarioId) {
  if (!usuarioId) throw new ErroDeUso('usuarioId é obrigatório', 'usuarioId');
  return comContexto(ctx, async (cx) => {
    // A RLS de `usuario` já limita ao tenant do contexto: se a leitura não
    // trouxer nada, ou não existe ou é de outra empresa — e a resposta é a mesma.
    const { rows } = await cx.query('select id from usuario where id = $1', [usuarioId]);
    if (rows.length === 0) throw new NaoEncontrado('usuário');

    const token = gerarToken();
    await repo.abrirRecuperacaoPeloGestor(cx, usuarioId, hashToken(token), HORAS_GESTOR);
    return { token, horas: HORAS_GESTOR };
  });
}

/**
 * O resgate: o bilhete vira senha nova.
 *
 * O tamanho é conferido aqui, e não só dentro de `gerarHash`: lá a recusa é um
 * erro de programa, que viraria 500 e diria ao usuário "erro interno" quando o
 * que houve foi uma senha de seis letras.
 */
export function redefinirSenha({ token, senha }) {
  const t = String(token ?? '').trim();
  if (!t) throw new ErroDeUso('link inválido', 'token');
  if (String(senha ?? '').length < 8) {
    throw new ErroDeUso('a senha precisa de ao menos 8 caracteres', 'senha');
  }

  return semContexto(async (cx) => {
    const hash = await gerarHash(senha);
    const id = await repo.consumirRecuperacao(cx, hashToken(t), hash);
    // Expirado, já usado, ou de uma conta que foi desativada no meio do
    // caminho: para quem está na tela é tudo a mesma coisa — pedir outro.
    if (!id) return { recusa: 'este link não vale mais; peça outro' };
    return { redefinida: true };
  }).then(recusarOuSeguir);
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

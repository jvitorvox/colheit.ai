/**
 * Autoatendimento de cadastro: a empresa abrindo a própria conta.
 *
 * Era o último ato que ainda exigia alguém na máquina do servidor. A aba
 * Equipe tirou usuário e carteira do psql, o bilhete de senha tirou a senha, e
 * sobrava a empresa: para um cliente novo existir, alguém tinha de rodar
 * `npm run admin`.
 *
 * Duas coisas moldam este módulo, e as duas são consequência de `documento` e
 * `email` serem únicos no banco:
 *
 *   nada nasce no envio   — criar a empresa ao receber o formulário deixaria
 *                           qualquer um plantar o CNPJ de uma empresa de
 *                           verdade e trancar a porta dela, sem precisar
 *                           receber e-mail nenhum;
 *   uma resposta só       — a tela responde igual sempre, e quem conta o que
 *                           aconteceu é o e-mail. Dizer "essa empresa já tem
 *                           conta" na tela entregaria, a quem for tentando um
 *                           CNPJ de cada vez, a lista de clientes da plataforma.
 */
import { semContexto } from '../../contexto.js';
import { ErroDeUso } from '../../http/erros.js';
import { textoObrigatorio, umDe, soDigitos, cnpjValido } from '../cadastro/validar.js';
import { gerarToken, hashToken } from '../auth/senha.js';
import { correioLigado, enviarCadastro, enderecoPublico } from '../auth/correio.js';
import * as repo from './repository.js';

// Só quem opera a própria carteira se cadastra sozinho. Franqueadora,
// franqueado e indústria existem dentro de uma rede que alguém precisa ligar
// com `admin -- rede` ou `admin -- territorio` de qualquer jeito: são conversa,
// não formulário.
//
// Vale dizer o que NÃO depende disto: `tenant.tipo` não manda em visibilidade
// nenhuma. Quem enxerga a rede é a tabela `rede`, quem enxerga o território é a
// `territorio`, e as duas só o papel dono escreve. Alguém que forçasse
// `franqueadora` aqui ganharia o rótulo e uma rede vazia — há teste disso.
const TIPOS_ABERTOS = ['distribuidor', 'revenda'];

// 48 h, e não as 24 do bilhete de senha: este link é o primeiro contato de
// alguém que ainda não é cliente, e pode chegar numa sexta à tarde.
const HORAS = 48;

/**
 * Abre o pedido. Nunca cria empresa, nunca cria usuário.
 *
 * Sem correio configurado não há como confirmar coisa nenhuma, então o
 * autoatendimento simplesmente não existe naquela instalação — e a tela diz
 * isso, em vez de aceitar um formulário que não leva a lugar nenhum.
 */
export function pedirCadastro(corpo = {}) {
  const c = {
    nome: textoObrigatorio(corpo.nome, 'nome', 160),
    documento: soDigitos(corpo.documento),
    tipo: umDe(corpo.tipo, TIPOS_ABERTOS, 'tipo', 'revenda'),
    gestor: textoObrigatorio(corpo.gestor, 'gestor', 120),
    email: textoObrigatorio(corpo.email, 'email', 160).toLowerCase(),
  };
  // O dígito verificador é o filtro mais barato contra robô: ele não impede
  // ninguém de verdade e derruba CNPJ sorteado.
  if (!cnpjValido(c.documento)) throw new ErroDeUso('CNPJ inválido', 'documento');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) {
    throw new ErroDeUso('e-mail inválido', 'email');
  }

  if (!correioLigado()) return Promise.resolve({ semCorreio: true });

  return semContexto(async (cx) => {
    const token = gerarToken();
    const situacao = await repo.abrirCadastro(cx, c, hashToken(token), HORAS);
    return situacao ? { situacao, token } : null;   // nulo = freio de um minuto
  }).then(async (r) => {
    if (!r) return { enviado: false };
    await enviarCadastro({
      situacao: r.situacao,
      nome: c.gestor,
      empresa: c.nome,
      email: c.email,
      url: `${enderecoPublico()}/empresa#conta=${r.token}`,
      horas: HORAS,
    });
    // O token só existe quando há o que confirmar; nos outros dois desfechos o
    // e-mail é só um aviso, e não leva link.
    return { enviado: true, ...(r.situacao === 'nova' ? { token: r.token } : {}) };
  });
}

/**
 * Confirma: empresa, primeiro gestor e bilhete de senha, numa transação só.
 *
 * Devolve o bilhete para a tela emendar direto na escolha da senha — quem
 * acabou de confirmar o e-mail não deve ter de clicar num segundo link para
 * conseguir entrar.
 */
export function confirmarCadastro({ token } = {}) {
  const t = String(token ?? '').trim();
  if (!t) throw new ErroDeUso('link inválido', 'token');

  return semContexto(async (cx) => {
    const senha = gerarToken();
    const r = await repo.confirmarCadastro(cx, hashToken(t), hashToken(senha));
    // Vencido, já usado, ou nunca existiu: para quem está na tela é a mesma
    // coisa, e a saída é preencher o formulário de novo.
    if (!r) throw new ErroDeUso('este link não vale mais; comece o cadastro de novo');
    return { empresa: r.empresa, gestor: r.gestor, token: senha };
  });
}

// Regra de negócio do cadastro. Abre o contexto, valida a entrada e orquestra
// o repository — não escreve SQL e não conhece HTTP.
import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import {
  normalizarDocumentos, textoObrigatorio, umDe, uuidValido, areaValida, soDigitos,
} from './validar.js';

const PAPEIS = ['proprietario', 'arrendatario', 'comodatario'];
const ORIGENS = ['consultor', 'autocadastro', 'importacao'];

/* ---------------------------------------------------------------- produtor */

export function criarProdutor(ctx, corpo) {
  const nome = textoObrigatorio(corpo.nome, 'nome');
  const documentos = normalizarDocumentos(corpo.documentos);
  const origem = umDe(corpo.origem, ORIGENS, 'origem', 'consultor');

  // Cadastro sem documento é aceito de propósito: é o caso do campo, e foi a
  // decisão que abriu mão de precisão em troca de velocidade na visita.
  return comContexto(ctx, async (cx) => {
    const id = await repo.vincularProdutor(cx, { nome, documentos, origem });
    return repo.buscarProdutor(cx, id);
  });
}

export function listarProdutores(ctx) {
  return comContexto(ctx, (cx) => repo.listarProdutores(cx));
}

export function buscarProdutor(ctx, id) {
  uuidValido(id, 'id');
  return comContexto(ctx, async (cx) => {
    const p = await repo.buscarProdutor(cx, id);
    if (!p) throw new NaoEncontrado('produtor');
    return p;
  });
}

export function adicionarDocumento(ctx, id, corpo) {
  uuidValido(id, 'id');
  const [doc] = normalizarDocumentos([corpo]);
  return comContexto(ctx, async (cx) => {
    const p = await repo.buscarProdutor(cx, id);
    if (!p) throw new NaoEncontrado('produtor');
    await repo.adicionarDocumento(cx, id, doc);
    return repo.buscarProdutor(cx, id);
  });
}

/**
 * Funde duas fichas do mesmo produtor. Ninguém é apagado: o perdedor passa a
 * apontar para o vencedor e o histórico dele continua alcançável.
 *
 * A regra combinada é "vence quem tem documento; empatando, o mais antigo" —
 * e ela é aplicada aqui, não no banco, porque é decisão de negócio. Quem
 * chama pode impor o vencedor, e aí a escolha é de quem chamou.
 */
export function fundirProdutores(ctx, corpo) {
  const a = uuidValido(corpo.produtorA, 'produtorA');
  const b = uuidValido(corpo.produtorB, 'produtorB');
  if (a === b) throw new ErroDeUso('são o mesmo produtor', 'produtorB');
  const imposto = corpo.vencedor ? uuidValido(corpo.vencedor, 'vencedor') : null;

  return comContexto(ctx, async (cx) => {
    const pa = await repo.buscarProdutor(cx, a);
    const pb = await repo.buscarProdutor(cx, b);
    if (!pa || !pb) throw new NaoEncontrado('produtor');
    if (pa.fundido_em || pb.fundido_em) throw new ErroDeUso('um dos produtores já foi fundido');

    let vencedor;
    if (imposto) {
      if (imposto !== a && imposto !== b) throw new ErroDeUso('vencedor precisa ser um dos dois', 'vencedor');
      vencedor = imposto;
    } else {
      vencedor = escolherVencedor(pa, pb);
    }
    const perdedor = vencedor === a ? b : a;

    await repo.fundirProdutor(cx, perdedor, vencedor);
    return { vencedor, perdedor, produtor: await repo.buscarProdutor(cx, vencedor) };
  });
}

function escolherVencedor(pa, pb) {
  const docsA = pa.documentos.length;
  const docsB = pb.documentos.length;
  if (docsA !== docsB) return docsA > docsB ? pa.id : pb.id;
  return new Date(pa.criado_em) <= new Date(pb.criado_em) ? pa.id : pb.id;
}

/* ------------------------------------------------------------ propriedade */

export function criarPropriedade(ctx, corpo) {
  const dados = {
    nome: textoObrigatorio(corpo.nome, 'nome'),
    produtorId: uuidValido(corpo.produtorId, 'produtorId'),
    papel: umDe(corpo.papel, PAPEIS, 'papel', 'proprietario'),
    municipio: corpo.municipio ? textoObrigatorio(corpo.municipio, 'municipio', 120) : null,
    uf: corpo.uf ? textoObrigatorio(corpo.uf, 'uf', 2).toUpperCase() : null,
    car: corpo.car ? textoObrigatorio(corpo.car, 'car', 80) : null,
    areaHa: areaValida(corpo.areaHa, 'areaHa'),
    inicio: corpo.inicio ?? null,
  };
  if (dados.uf && dados.uf.length !== 2) throw new ErroDeUso('uf deve ter duas letras', 'uf');

  return comContexto(ctx, async (cx) => {
    const id = await repo.criarPropriedade(cx, dados);
    const todas = await repo.listarPropriedades(cx);
    return todas.find((p) => p.id === id);
  });
}

export function listarPropriedades(ctx) {
  return comContexto(ctx, (cx) => repo.listarPropriedades(cx));
}

/**
 * Liga mais um operador à terra — é como o arrendamento entra: o dono da
 * fazenda e quem planta nela são dois produtores, com papéis diferentes e
 * período próprio.
 */
export function ligarOperador(ctx, propriedadeId, corpo) {
  uuidValido(propriedadeId, 'propriedadeId');
  const d = {
    produtorId: uuidValido(corpo.produtorId, 'produtorId'),
    papel: umDe(corpo.papel, PAPEIS, 'papel'),
    inicio: corpo.inicio ?? null,
  };
  return comContexto(ctx, async (cx) => {
    if (!(await repo.propriedadeExiste(cx, propriedadeId))) throw new NaoEncontrado('propriedade');
    const id = await repo.ligarOperador(cx, propriedadeId, d);
    return { id };
  });
}

export function encerrarOperacao(ctx, relacaoId, corpo) {
  uuidValido(relacaoId, 'relacaoId');
  return comContexto(ctx, async (cx) => {
    const n = await repo.encerrarOperacao(cx, relacaoId, corpo?.fim ?? null);
    if (n === 0) throw new NaoEncontrado('relação vigente');
    return { encerrada: true };
  });
}

/* ----------------------------------------------------------------- talhão */

export function criarTalhao(ctx, propriedadeId, corpo) {
  uuidValido(propriedadeId, 'propriedadeId');
  const nome = textoObrigatorio(corpo.nome, 'nome', 80);
  const areaHa = areaValida(corpo.areaHa, 'areaHa');
  return comContexto(ctx, async (cx) => {
    if (!(await repo.propriedadeExiste(cx, propriedadeId))) throw new NaoEncontrado('propriedade');
    const id = await repo.criarTalhao(cx, propriedadeId, { nome, areaHa });
    return { id, nome, area_ha: areaHa };
  });
}

export function listarTalhoes(ctx, propriedadeId) {
  uuidValido(propriedadeId, 'propriedadeId');
  return comContexto(ctx, async (cx) => {
    if (!(await repo.propriedadeExiste(cx, propriedadeId))) throw new NaoEncontrado('propriedade');
    return repo.listarTalhoes(cx, propriedadeId);
  });
}

/* --------------------------------------------------------------- carteira */

export function autorizarConsultor(ctx, corpo) {
  const usuarioId = uuidValido(corpo.usuarioId, 'usuarioId');
  const produtorId = uuidValido(corpo.produtorId, 'produtorId');
  return comContexto(ctx, async (cx) => {
    const vinculoId = await repo.vinculoDoProdutor(cx, produtorId);
    if (!vinculoId) throw new NaoEncontrado('produtor');
    await repo.autorizarConsultor(cx, usuarioId, vinculoId);
    return { autorizado: true };
  });
}

export { soDigitos };

/** A lavoura do produtor logado — é o que o portal abre na primeira tela. */
export function minhaLavoura(ctx) {
  return comContexto(ctx, (cx) => repo.minhaLavoura(cx));
}

// Palavras que aparecem em toda pergunta e não são nome de ninguém. Sem esta
// lista, "como foi a safra do Sabo" procuraria por "safra" e acharia qualquer
// produtor cujo nome contivesse isso.
const RUIDO = new Set([
  'como', 'foi', 'esta', 'está', 'qual', 'quanto', 'quantas', 'safra', 'colheita',
  'colheu', 'colhi', 'rendeu', 'rendimento', 'produtividade', 'produziu', 'para',
  'com', 'por', 'dos', 'das', 'sobre', 'hectare', 'saca', 'sacas', 'talhao',
  'talhão', 'lavoura', 'fazenda', 'sitio', 'sítio', 'resultado', 'numero',
  'minha', 'meu', 'meus', 'minhas', 'nossa', 'nosso', 'esse', 'essa', 'aquele',
]);

/**
 * Acha um produtor a partir de um texto solto — a pergunta do WhatsApp.
 *
 * Devolve `{ achado }`, `{ ambiguos }` ou nada. Três desfechos porque é o que
 * a realidade tem: o consultor escreve "safra do Sabo", e "Sabo" pode ser dois
 * produtores. Chutar um deles seria responder com o número do vizinho.
 *
 * A política já limita o alcance à carteira dele — a busca não precisa saber
 * disso, e não sabe.
 */
export function procurarProdutorNoTexto(ctx, texto) {
  const termos = String(texto ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !RUIDO.has(t.toLowerCase()));
  if (termos.length === 0) return Promise.resolve({});

  return comContexto(ctx, async (cx) => {
    const achados = await repo.procurarProdutores(cx, termos);
    if (achados.length === 0) return {};
    if (achados.length === 1) return { achado: achados[0] };
    return { ambiguos: achados };
  });
}

/**
 * Acha um talhão a partir de um texto solto — a pergunta do produtor.
 *
 * Mesmos três desfechos da busca por produtor, e pela mesma razão: "Gleba" pode
 * ser duas, e responder pela errada é dar o número do talhão vizinho.
 *
 * Quando o nome INTEIRO aparece na frase, só esses valem: quem escreveu
 * "Gleba 2" não quer a Gleba 1, e o casamento por pedaço traria as duas.
 */
export function procurarTalhaoNoTexto(ctx, texto) {
  const frase = String(texto ?? '');
  const termos = frase
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !RUIDO.has(t.toLowerCase()));

  return comContexto(ctx, async (cx) => {
    // Lista vazia, e não `['']`: `like '%%'` casaria com TODO talhão, e a
    // pergunta genérica — "quanto rendeu minha colheita?", que não sobra termo
    // nenhum — virava "qual deles?" com a lavoura inteira na resposta.
    const achados = await repo.procurarTalhoes(cx, termos, frase);
    const inteiros = achados.filter((t) => t.pelo_nome_inteiro);
    const candidatos = inteiros.length ? inteiros : achados;
    if (candidatos.length === 0) return {};
    if (candidatos.length === 1) return { achado: candidatos[0] };
    return { ambiguos: candidatos };
  });
}

/* ------------------------------------------------------------- a equipe */

// Papéis de USUÁRIO. O `PAPEIS` do topo é outro: posse da terra.
const PAPEIS_DE_USUARIO = ['gestor', 'consultor'];

/**
 * Cria um usuário da empresa.
 *
 * Nasce SEM senha. Quem define é o gestor, num segundo ato — o mesmo caminho
 * que `POST /auth/usuarios/:id/senha` já usava. Gerar senha aqui e mostrá-la na
 * tela seria pôr credencial em tela que alguém fotografa.
 *
 * Quem recusa um não-gestor é a política do banco; a checagem aqui existe para
 * a mensagem ser clara em vez de um erro de permissão cru.
 */
export function criarUsuario(ctx, corpo = {}) {
  if (ctx.papel !== 'gestor') throw new ErroDeUso('só gestor cria usuário');
  const u = {
    nome: textoObrigatorio(corpo.nome, 'nome', 120),
    email: textoObrigatorio(corpo.email, 'email', 160).trim().toLowerCase(),
    papel: umDe(corpo.papel, PAPEIS_DE_USUARIO, 'papel', 'consultor'),
    senhaHash: null,
  };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) {
    throw new ErroDeUso('e-mail inválido', 'email');
  }
  return comContexto(ctx, (cx) => repo.criarUsuario(cx, u));
}

export const listarUsuarios = (ctx) => comContexto(ctx, (cx) => repo.listarUsuarios(cx));

/**
 * Muda nome, papel ou situação.
 *
 * Desativar é o que se faz quando alguém sai — e não apagar: visita, pedido e
 * relato continuam apontando para ele, e apagar o autor reescreveria a
 * história de quem esteve na lavoura.
 *
 * O último gestor ativo não se desativa nem vira consultor. Sem isso a empresa
 * fica sem ninguém que possa criar usuário, e a saída seria o psql de novo —
 * exatamente o que estas telas vieram resolver.
 */
export function alterarUsuario(ctx, id, corpo = {}) {
  if (ctx.papel !== 'gestor') throw new ErroDeUso('só gestor altera usuário');
  uuidValido(id, 'id');
  const mudanca = {
    nome: corpo.nome === undefined ? null : textoObrigatorio(corpo.nome, 'nome', 120),
    papel: corpo.papel === undefined ? null : umDe(corpo.papel, PAPEIS_DE_USUARIO, 'papel'),
    ativo: corpo.ativo === undefined ? null : Boolean(corpo.ativo),
  };

  return comContexto(ctx, async (cx) => {
    const antes = (await cx.query(
      'select id, papel, ativo from usuario where id = $1', [id])).rows[0];
    if (!antes) throw new NaoEncontrado('usuário');

    const deixaDeSerGestor = antes.papel === 'gestor'
      && ((mudanca.papel !== null && mudanca.papel !== 'gestor') || mudanca.ativo === false);
    if (deixaDeSerGestor && await repo.contarGestoresAtivos(cx, id) === 0) {
      throw new ErroDeUso('a empresa ficaria sem gestor', 'papel');
    }

    const depois = await repo.alterarUsuario(cx, id, mudanca);
    if (!depois) throw new NaoEncontrado('usuário');
    return depois;
  });
}

/** A carteira de um consultor: todos os produtores, marcando quem ele atende. */
export function carteiraDoConsultor(ctx, usuarioId) {
  uuidValido(usuarioId, 'usuarioId');
  return comContexto(ctx, (cx) => repo.carteiraDoConsultor(cx, usuarioId));
}

/** Tira um produtor da carteira. O histórico do que ele fez fica. */
export function desautorizarConsultor(ctx, corpo = {}) {
  const usuarioId = uuidValido(corpo.usuarioId, 'usuarioId');
  const produtorId = uuidValido(corpo.produtorId, 'produtorId');
  return comContexto(ctx, async (cx) => {
    const vinculoId = await repo.vinculoDoProdutor(cx, produtorId);
    if (!vinculoId) throw new NaoEncontrado('produtor');
    await repo.desautorizarConsultor(cx, usuarioId, vinculoId);
    return { autorizado: false };
  });
}

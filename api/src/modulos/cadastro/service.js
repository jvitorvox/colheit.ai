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

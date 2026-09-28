import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import * as catalogo from '../catalogo/service.js';
import {
  textoObrigatorio, umDe, uuidValido, areaValida,
} from '../cadastro/validar.js';

// O cadastro exporta validadores puros, não o repository dele — a regra da
// seção 13 proíbe um módulo importar o repository de outro, e é justamente o
// acordo que decide se o sistema envelhece bem.

const ULTIMA = 10;
const ETAPA_NOTA = 4;
const CREDITOS = ['pendente', 'aprovado', 'recusado'];

/* ------------------------------------------------------------------ criar */

export async function criar(ctx, corpo) {
  const numero = textoObrigatorio(corpo.numero, 'numero', 40);
  const safra = textoObrigatorio(corpo.safra, 'safra', 10);
  const produtorId = uuidValido(corpo.produtorId, 'produtorId');
  const propriedadeId = corpo.propriedadeId ? uuidValido(corpo.propriedadeId, 'propriedadeId') : null;
  const canal = umDe(corpo.canal, ['direto', 'distribuidor'], 'canal', 'direto');
  const itens = await carimbarPrecos(ctx, normalizarItens(corpo.itens), safra, canal);

  return comContexto(ctx, async (cx) => {
    if (!(await repo.produtorTemVinculo(cx, produtorId))) {
      throw new ErroDeUso('produtor não tem vínculo com esta empresa', 'produtorId');
    }

    // O carimbo da atribuição. Sai do município da terra, no instante da
    // venda — e nunca é recalculado depois.
    let franqueadoId = null, municipio = null, uf = null;
    if (propriedadeId) {
      const local = await repo.localDaPropriedade(cx, propriedadeId);
      if (!local) throw new NaoEncontrado('propriedade');
      ({ municipio, uf } = local);
      if (municipio && uf) franqueadoId = await repo.franqueadoDoMunicipio(cx, municipio, uf);
    }

    const id = await repo.criar(cx, { produtorId, propriedadeId, numero, safra, franqueadoId, municipio, uf });
    await repo.adicionarItens(cx, id, itens);
    await repo.registrarEtapa(cx, id, 1, 'pedido aberto');
    return repo.buscar(cx, id);
  });
}

/**
 * Carimba no item o preço e os royalties que valiam na hora da venda.
 *
 * Mesma razão do carimbo de território: tabela nova não pode reescrever pedido
 * velho. "Por que este pedido saiu por outro preço" é a primeira pergunta do
 * financeiro, e ela só tem resposta se o número ficar guardado na linha.
 *
 * Quem informa o preço à mão manda nele — item digitado continua válido, e o
 * catálogo não é obrigatório para abrir pedido.
 */
async function carimbarPrecos(ctx, itens, safra, canal) {
  const prontos = [];
  for (const i of itens) {
    if (!i.produtoId) { prontos.push(i); continue; }
    const p = await catalogo.precoParaVenda(ctx, { produtoId: i.produtoId, safra, canal });
    prontos.push({
      ...i,
      cultivar: i.cultivar ?? p.nome,
      unidade: i.unidade ?? p.unidade,
      precoUnit: i.bonificada ? 0 : (i.precoUnit ?? p.valor),
      // Bonificada não cobra o saco, mas o royalty do detentor da tecnologia
      // continua devido — é o que torna a geração de demanda cara de verdade.
      royaltiesSc: i.royaltiesSc ?? p.royaltiesSc,
    });
  }
  return prontos;
}

function normalizarItens(lista) {
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new ErroDeUso('o pedido precisa de ao menos um item', 'itens');
  }
  return lista.map((i, n) => {
    const produtoId = i.produtoId ? uuidValido(i.produtoId, `itens[${n}].produtoId`) : null;
    // Com produto do catálogo, o nome vem de lá; digitando à mão, é obrigatório.
    const cultivar = produtoId && !i.cultivar
      ? null : textoObrigatorio(i.cultivar, `itens[${n}].cultivar`, 60);
    return {
      produtoId,
      cultivar,
      quantidade: areaValida(i.quantidade, `itens[${n}].quantidade`)
        ?? (() => { throw new ErroDeUso('quantidade é obrigatória', `itens[${n}].quantidade`); })(),
      unidade: i.unidade ? textoObrigatorio(i.unidade, `itens[${n}].unidade`, 6) : null,
      precoUnit: i.precoUnit === undefined || i.precoUnit === null ? null
        : areaValida(i.precoUnit, `itens[${n}].precoUnit`),
      royaltiesSc: i.royaltiesSc === undefined || i.royaltiesSc === null ? null
        : areaValida(i.royaltiesSc, `itens[${n}].royaltiesSc`),
      bonificada: Boolean(i.bonificada),
    };
  });
}

/* ------------------------------------------------------------------ etapas */

export const listarEtapas = (ctx) => comContexto(ctx, (cx) => repo.etapas(cx));

/**
 * Avança uma etapa. Uma de cada vez, nunca pulando.
 *
 * Pular seria cômodo e é exatamente o que destrói a promessa: a régua do
 * agricultor é acompanhar o pedido andar, e pedido que salta de 2 para 7 não
 * conta história nenhuma.
 */
export function avancar(ctx, pedidoId, corpo = {}) {
  uuidValido(pedidoId, 'pedidoId');
  return comContexto(ctx, async (cx) => {
    const p = await exigirPedidoMeu(cx, ctx, pedidoId);
    if (p.situacao !== 'andamento') throw new ErroDeUso(`pedido ${p.situacao}`);
    if (p.etapa >= ULTIMA) throw new ErroDeUso('o pedido já está na última etapa');

    const proxima = p.etapa + 1;

    // A etapa 4 exige a nota. Não é burocracia: a nota É o sell-out, e marcar
    // faturado sem ela deixaria o dado entrar pela metade — que é como toda
    // captura de campo morre.
    if (proxima === ETAPA_NOTA && !(await repo.temNota(cx, pedidoId))) {
      throw new ErroDeUso('lance a nota antes de marcar o faturamento');
    }
    if (proxima === ETAPA_NOTA + 1 && p.credito === 'recusado') {
      throw new ErroDeUso('crédito recusado: o pedido não segue');
    }

    await repo.moverEtapa(cx, pedidoId, proxima);
    await repo.registrarEtapa(cx, pedidoId, proxima, corpo.observacao, false);
    await avisarSePreciso(cx, p, proxima);

    if (proxima === ULTIMA) await repo.definirSituacao(cx, pedidoId, 'concluido');
    return repo.buscar(cx, pedidoId);
  });
}

/**
 * Volta uma etapa. Existe porque a realidade volta: carga recusada na porteira,
 * entrega que não foi. Exige motivo, e o histórico guarda que foi retrocesso —
 * apagar o passo em falso seria perder o que a operação precisa aprender.
 */
export function retroceder(ctx, pedidoId, corpo = {}) {
  uuidValido(pedidoId, 'pedidoId');
  const motivo = textoObrigatorio(corpo.motivo, 'motivo', 300);
  return comContexto(ctx, async (cx) => {
    const p = await exigirPedidoMeu(cx, ctx, pedidoId);
    if (p.situacao === 'cancelado') throw new ErroDeUso('pedido cancelado');
    if (p.etapa <= 1) throw new ErroDeUso('o pedido já está na primeira etapa');

    const anterior = p.etapa - 1;
    await repo.moverEtapa(cx, pedidoId, anterior);
    await repo.registrarEtapa(cx, pedidoId, anterior, motivo, true);
    if (p.situacao === 'concluido') await repo.definirSituacao(cx, pedidoId, 'andamento');
    return repo.buscar(cx, pedidoId);
  });
}

export function cancelar(ctx, pedidoId, corpo = {}) {
  uuidValido(pedidoId, 'pedidoId');
  const motivo = textoObrigatorio(corpo.motivo, 'motivo', 300);
  return comContexto(ctx, async (cx) => {
    const p = await exigirPedidoMeu(cx, ctx, pedidoId);
    if (p.situacao === 'cancelado') throw new ErroDeUso('pedido já cancelado');
    await repo.definirSituacao(cx, pedidoId, 'cancelado');
    await repo.registrarEtapa(cx, pedidoId, p.etapa, `cancelado: ${motivo}`, false);
    return repo.buscar(cx, pedidoId);
  });
}

export function definirCredito(ctx, pedidoId, corpo = {}) {
  uuidValido(pedidoId, 'pedidoId');
  const credito = umDe(corpo.credito, CREDITOS, 'credito');
  return comContexto(ctx, async (cx) => {
    const p = await exigirPedidoMeu(cx, ctx, pedidoId);
    await repo.definirCredito(cx, pedidoId, credito);
    await repo.registrarEtapa(cx, pedidoId, p.etapa, `crédito: ${credito}`, false);
    if (credito !== 'pendente') {
      await avisarSePreciso(cx, p, p.etapa, `Crédito ${credito} no pedido ${p.numero}.`);
    }
    return repo.buscar(cx, pedidoId);
  });
}

/* -------------------------------------------------------------------- nota */

export function lancarNota(ctx, pedidoId, corpo = {}) {
  uuidValido(pedidoId, 'pedidoId');
  const n = {
    numero: textoObrigatorio(corpo.numero, 'numero', 40),
    chave: corpo.chave ? String(corpo.chave).replace(/\D/g, '') : null,
    valor: areaValida(corpo.valor, 'valor'),
    emitidaEm: corpo.emitidaEm ?? null,
    vencimento: corpo.vencimento ?? null,
    linhaDigitavel: corpo.linhaDigitavel ?? null,
    origem: umDe(corpo.origem, ['lancamento', 'xml', 'danfe'], 'origem', 'lancamento'),
  };
  if (!n.valor) throw new ErroDeUso('valor é obrigatório', 'valor');
  if (!n.emitidaEm) throw new ErroDeUso('emitidaEm é obrigatório', 'emitidaEm');
  if (n.chave && n.chave.length !== 44) {
    throw new ErroDeUso('a chave da NF-e tem 44 dígitos', 'chave');
  }

  return comContexto(ctx, async (cx) => {
    const p = await exigirPedidoMeu(cx, ctx, pedidoId);
    if (await repo.temNota(cx, pedidoId)) throw new ErroDeUso('este pedido já tem nota');
    await repo.lancarNota(cx, pedidoId, n);
    await repo.registrarEtapa(cx, pedidoId, p.etapa, `nota ${n.numero} lançada`, false);
    return repo.buscar(cx, pedidoId);
  });
}

export function marcarPago(ctx, pedidoId, corpo = {}) {
  uuidValido(pedidoId, 'pedidoId');
  return comContexto(ctx, async (cx) => {
    const p = await exigirPedidoMeu(cx, ctx, pedidoId);
    if (!(await repo.temNota(cx, pedidoId))) throw new NaoEncontrado('nota');
    await repo.marcarPago(cx, pedidoId, corpo.pagoEm ?? null);
    await repo.registrarEtapa(cx, pedidoId, p.etapa, 'pagamento registrado', false);
    return repo.buscar(cx, pedidoId);
  });
}

/* ------------------------------------------------------------------ leitura */

export function listar(ctx, filtros) {
  return comContexto(ctx, (cx) => repo.listar(cx, filtros));
}

export function buscar(ctx, id) {
  uuidValido(id, 'id');
  return comContexto(ctx, async (cx) => {
    const p = await repo.buscar(cx, id);
    if (!p) throw new NaoEncontrado('pedido');
    return { ...p, historico: await repo.historico(cx, id) };
  });
}

export function avisos(ctx, filtros) {
  return comContexto(ctx, (cx) => repo.avisos(cx, filtros));
}

/* ------------------------------------------------------------------ apoio */

async function exigirPedidoMeu(cx, ctx, pedidoId) {
  const p = await repo.buscar(cx, pedidoId);
  if (!p) throw new NaoEncontrado('pedido');
  // O franqueado enxerga o que desce dele, e não escreve nele. Quem opera a
  // venda é quem a alterou — o banco também barra, isto é a mensagem clara.
  if (p.tenant_id !== ctx.tenant) throw new ErroDeUso('este pedido é de outra empresa');
  return p;
}

async function avisarSePreciso(cx, pedido, etapa, textoPronto) {
  const lista = await repo.etapas(cx);
  const e = lista.find((x) => x.numero === etapa);
  if (!textoPronto && !(e && e.notifica)) return;

  const texto = textoPronto
    ?? `Pedido ${pedido.numero}: ${e.nome.toLowerCase()}.`;
  await repo.enfileirarAviso(cx, pedido.produtor_id, pedido.id, etapa, texto);
}

/* ------------------------------------------------------- onde trava */

/**
 * Onde a operação está parada, por etapa.
 *
 * O corte de atenção é da regra de negócio, não da tela: sete dias parado num
 * pedido de safra é muito, e quem decide isso é o módulo — assim a régua é a
 * mesma no painel, num aviso ou num relatório que ainda não existe.
 */
export const DIAS_PARADO_DEMAIS = 7;

export function gargalo(ctx) {
  return comContexto(ctx, async (cx) => {
    const etapas = await repo.gargaloPorEtapa(cx);
    const linhas = etapas.map((e) => ({
      ...e,
      mediana_dias: Number(e.mediana_dias),
      travando: Number(e.mediana_dias) > DIAS_PARADO_DEMAIS,
    }));
    // O pior gargalo é o de maior mediana, e só é gargalo se passar do corte:
    // apontar "o pior" numa operação saudável ensina a ignorar o painel.
    const pior = linhas.filter((l) => l.travando)
      .sort((a, b) => b.mediana_dias - a.mediana_dias)[0] ?? null;
    return { corteDias: DIAS_PARADO_DEMAIS, pior, etapas: linhas };
  });
}

export const safraCorrente = (ctx) => comContexto(ctx, (cx) => repo.safraMaisRecente(cx));

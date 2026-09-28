import { dono } from '../../db.js';
import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { extrair, extratorLigado } from './extrator.js';
import * as pedidos from '../pedidos/service.js';
import * as visitas from '../visitas/service.js';
import * as caderno from '../caderno/service.js';
import * as cadastro from '../cadastro/service.js';
import * as midia from '../midia/service.js';
import { textoObrigatorio, umDe, uuidValido } from '../cadastro/validar.js';

// Fala com pedidos pelo SERVICE, nunca pelo repository dele. É a regra da
// seção 13, e é o acordo que decide se o sistema envelhece bem.

// Janela dentro da qual responder ainda é responder. Fora dela, seria disparo.
const JANELA_RESPOSTA_H = 24;
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

/* ------------------------------------------------------------------ canal */

export function registrarCanal(ctx, corpo = {}) {
  const numero = soDigitos(corpo.numero);
  if (numero.length < 10 || numero.length > 15) throw new ErroDeUso('número inválido', 'numero');
  return comContexto(ctx, (cx) => repo.registrarCanal(cx, numero));
}

export const meuCanal = (ctx) => comContexto(ctx, (cx) => repo.meuCanal(cx));

/* --------------------------------------------------------- entrada (gateway) */

/**
 * Recebe uma mensagem. Chamada pelo adaptador do gateway, que atende vários
 * tenants — por isso usa o papel dono, e não uma sessão.
 *
 * Três desfechos: vira relato de campo, vira resposta a uma pergunta, ou vira
 * pedido de vínculo quando o telefone não é conhecido.
 */
export async function receber(entrada) {
  const paraNumero = soDigitos(entrada.para);
  const telefone = soDigitos(entrada.de);
  const tipo = umDe(entrada.tipo, ['texto', 'audio', 'imagem'], 'tipo');
  if (!telefone) throw new ErroDeUso('remetente ausente', 'de');

  const tenantId = await repo.tenantDoNumero(dono, paraNumero);
  if (!tenantId) throw new NaoEncontrado('canal');

  const quem = await repo.identificar(dono, telefone, tenantId);
  const msg = await repo.gravarEntrada(dono, {
    tenantId, telefone, tipo,
    texto: entrada.texto ?? null,
    midiaId: entrada.midiaId ?? null,
    produtorId: quem.produtorId, usuarioId: quem.usuarioId,
  });

  // Telefone que ninguém conhece não vira relato. Vira convite a se vincular —
  // e é a única resposta que faz sentido dar a quem não sabemos quem é.
  if (!quem.produtorId && !quem.usuarioId) {
    await responder(tenantId, telefone, msg.id,
      'Não reconheci este número. Peça ao seu consultor para enviar o convite de acesso.');
    return { mensagemId: msg.id, desfecho: 'nao_identificado' };
  }

  const pergunta = tipo === 'texto' ? classificar(entrada.texto) : null;
  if (pergunta) {
    const ctx = contextoDe(quem, tenantId);
    const resposta = pergunta === 'safra'
      ? await responderSobreSafra(ctx, entrada.texto)
      : await responderSobrePedido(ctx);
    await responder(tenantId, telefone, msg.id, resposta);
    return { mensagemId: msg.id, desfecho: 'respondido', sobre: pergunta };
  }

  // Relato do campo. Sem produtor identificado — caso do consultor mandando a
  // visita — o produtor virá da extração; até lá não há relato a criar.
  if (!quem.produtorId) {
    return { mensagemId: msg.id, desfecho: 'guardado', nota: 'relato de consultor depende da extração' };
  }

  const lido = await extrair({ tipo, texto: entrada.texto, midiaId: entrada.midiaId });
  const relatoId = await repo.criarRelato(dono, {
    mensagemId: msg.id, tenantId, produtorId: quem.produtorId,
    tipo: lido?.tipo ?? 'lavoura',
    transcricao: lido?.transcricao ?? (tipo === 'texto' ? entrada.texto : null),
    extraido: lido?.extraido ?? null,
    situacao: lido ? 'pendente' : 'aguardando_extracao',
  });

  await responder(tenantId, telefone, msg.id,
    lido
      ? 'Recebi e registrei. Seu consultor vai conferir.'
      : 'Recebi e guardei. Seu consultor vai conferir.');

  return {
    mensagemId: msg.id, relatoId,
    desfecho: lido ? 'relato_pendente' : 'relato_aguardando_extracao',
    extratorLigado: extratorLigado(),
  };
}

/**
 * Duas perguntas que o sistema sabe responder, e a ordem importa.
 *
 * "Quanto rendeu o meu pedido" bate nas duas listas; safra é testada primeiro
 * porque quem escreve "rendeu" quer produtividade, e quem quer o pedido escreve
 * "cadê" ou "chegou".
 *
 * É casamento de palavra, não entendimento — e continua sendo, mesmo depois que
 * o extrator de IA ligar: pergunta respondida por regra é barata, previsível e
 * não manda o texto do produtor para provedor nenhum. O que a regra não pega
 * vira relato de campo, que é o destino certo para o resto.
 */
const SOBRE_SAFRA = /(safra|colheita|colhi|colheu|rendeu|rendi|rendimento|produtividade|produziu|sc\/ha|por hectare)/i;
const SOBRE_PEDIDO = /(cad[eê]|onde|status|chegou|entrega|pedido|nota|boleto)/i;

function classificar(texto) {
  const t = String(texto ?? '');
  if (SOBRE_SAFRA.test(t)) return 'safra';
  if (SOBRE_PEDIDO.test(t)) return 'pedido';
  return null;
}

/** O produtor fala por si; o consultor fala pela empresa dele. */
const contextoDe = (quem, tenantId) => (quem.produtorId
  ? { produtor: quem.produtorId }
  : { tenant: tenantId, usuario: quem.usuarioId });

/**
 * O fechamento da safra em quatro linhas.
 *
 * WhatsApp é para ser lido de relance, e mensagem longa não se lê no trator.
 * Mas a base do número vai junto: é ali que ela mais importa, porque a mensagem
 * é encaminhada e vira captura de tela sem nenhum contexto em volta.
 */
async function responderSobreSafra(ctx, texto) {
  // Só o consultor pergunta por outra pessoa. O produtor fala de uma lavoura
  // só — a dele —, e procurar nome no texto dele só criaria chance de errar.
  if (ctx.tenant) {
    const { achado, ambiguos } = await cadastro.procurarProdutorNoTexto(ctx, texto);
    if (ambiguos) {
      return `Achei mais de um: ${ambiguos.map((p) => p.nome).join(', ')}.\n`
        + 'Escreva o nome mais completo.';
    }
    if (achado) {
      const dele = await caderno.resultadoDaSafra(ctx, null, achado.id);
      return `${achado.nome} — ${resumoDaSafra(dele)}`;
    }
  }

  const r = await caderno.resultadoDaSafra(ctx);
  if (!r?.safra) {
    return ctx.tenant
      ? 'Ainda não tenho plantio registrado na sua carteira.'
      : 'Ainda não tenho plantio registrado no seu nome.';
  }
  return maiuscula(resumoDaSafra(r));
}

/** Quando a frase ABRE a mensagem, a primeira letra sobe. */
const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * O fechamento da safra em quatro linhas.
 *
 * Uma função só para os dois casos — a carteira do consultor e o produtor que
 * ele nomeou — porque a forma da resposta não muda, e duas versões divergiriam
 * na primeira vez que alguém mexesse numa delas.
 */
function resumoDaSafra(r) {
  if (!r?.safra) return 'não tenho plantio registrado.';
  if (r.mediaPonderadaScHa === null) {
    return `safra ${r.safra}: ainda não há colheita registrada `
      + `(${r.talhoes} talhão(ões) plantados).`;
  }

  const n = (v) => Number(v).toLocaleString('pt-BR');
  const linhas = [
    `safra ${r.safra}: ${n(r.mediaPonderadaScHa)} sc/ha na média, `
    + `${n(r.areaColhidaHa)} ha colhidos (${r.colhidos} de ${r.talhoes} talhões).`,
  ];
  if (r.anterior) {
    linhas.push(`${r.anterior.variacaoPct > 0 ? '+' : ''}${n(r.anterior.variacaoPct)}% `
      + `em relação à safra ${r.anterior.safra}.`);
  }
  const melhor = r.porTalhao.find((t) => t.produtividadeScHa !== null);
  if (melhor) linhas.push(`Melhor: ${melhor.talhao}, ${n(melhor.produtividadeScHa)} sc/ha.`);
  linhas.push('Média ponderada pela área colhida.');
  return linhas.join('\n');
}

async function responderSobrePedido(ctx) {
  const lista = await pedidos.listar(ctx, { situacao: 'andamento' });
  if (lista.length === 0) return 'Não encontrei pedido em andamento no seu nome.';

  const linhas = lista.slice(0, 3).map(
    (p) => `${p.numero}: ${String(p.etapa_nome).toLowerCase()}`);
  return `Seus pedidos em andamento:\n${linhas.join('\n')}`;
}

/**
 * Enfileira uma resposta.
 *
 * Só existe atrelada a uma entrada recente — sem âncora, a linha nem nasce: o
 * banco recusa. É assim que "o WhatsApp nunca dispara" deixa de depender de
 * quem escreve o gateway.
 */
async function responder(tenantId, telefone, respondeA, texto) {
  const ancora = respondeA
    ?? await repo.ultimaEntradaDe(dono, tenantId, telefone, JANELA_RESPOSTA_H);
  if (!ancora) return null;
  return repo.gravarSaida(dono, { tenantId, telefone, texto, respondeA: ancora });
}

export const saidasPendentes = (limite = 50) => repo.saidasPendentes(dono, limite);
export const marcarEnviada = (id) => repo.marcarEnviada(dono, id);

/* ----------------------------------------------------------- fila do time */

export function relatos(ctx, filtros = {}) {
  const situacao = filtros.situacao
    ? umDe(filtros.situacao, ['aguardando_extracao', 'pendente', 'validado', 'descartado'], 'situacao')
    : null;
  return comContexto(ctx, (cx) => repo.relatos(cx, situacao));
}

/** Validar é o ato do consultor — é ele quem fecha, como no RDO do Construtivo. */
export function decidir(ctx, id, acao, corpo = {}) {
  uuidValido(id, 'id');
  const situacao = acao === 'validar' ? 'validado' : 'descartado';
  if (situacao === 'descartado') textoObrigatorio(corpo.observacao, 'observacao', 300);
  const talhaoId = corpo.talhaoId ? uuidValido(corpo.talhaoId, 'talhaoId') : null;

  const decidido = comContexto(ctx, async (cx) => {
    const r = await repo.buscarRelato(cx, id);
    if (!r) throw new NaoEncontrado('relato');
    const n = await repo.decidirRelato(cx, id, situacao, corpo.observacao, talhaoId);
    if (n === 0) throw new ErroDeUso(`relato já ${r.situacao}`);
    return repo.buscarRelato(cx, id);
  });

  // Relato de visita validado vira visita de verdade. É o ponto onde o áudio
  // do WhatsApp entra na mesma tabela do formulário — sem isso os dois canais
  // nunca seriam comparáveis, e a H1 revisada pede exatamente essa comparação.
  return decidido.then(async (r) => {
    if (r.situacao !== 'validado') return r;
    if (r.tipo === 'visita') await visitas.registrarDeRelato(ctx, r, corpo.duracaoSeg);
    // Lavoura e lote viram plantio quando a extração trouxe cultivar e marca.
    // Sem os dois não há o que registrar, e inventar a marca seria pior.
    else await caderno.registrarDePlanteRelato(ctx, r);
    return r;
  });
}

/* ------------------------------------------- reprocessar a fila represada */

/**
 * Passa o extrator na fila que ficou guardada enquanto ele não existia.
 *
 * É o que torna a espera reversível: nada do que chegou antes se perde, e no
 * dia em que o plano sem-treino for fechado, a base de campo acumulada entra
 * de uma vez.
 */
export async function extrairPendentes({ limite = 100 } = {}) {
  if (!extratorLigado()) return { extrator: 'desligado', processados: 0 };
  const fila = await repo.aguardandoExtracao(dono, limite);
  let n = 0;
  for (const r of fila) {
    const lido = await extrair({ tipo: r.tipo, texto: r.texto, midiaId: r.midia_id });
    if (!lido) continue;
    await repo.aplicarExtracao(dono, r.id, lido.transcricao, lido.extraido, lido.tipo);
    n++;
  }
  return { extrator: 'ligado', processados: n };
}

/* ------------------------------------------------------- canais (gateway) */

export const canaisAtivos = () => repo.canaisAtivos(dono);
export const marcarConectado = (numero) => repo.marcarConectado(dono, soDigitos(numero));

/* ------------------------------------------------------- mídia (gateway) */

/**
 * Guarda o binário que o gateway recebeu, antes da mensagem que o acompanha.
 *
 * O tenant sai do canal e o produtor sai do telefone — o gateway não informa
 * nem um nem outro. Assim ele não guarda arquivo em nome de quem quiser, e
 * mídia de número desconhecido nasce sem dono, alcançável só pela empresa.
 */
export async function guardarMidia({ numeroDoCanal, telefone, mime, bytes }) {
  const tenantId = await repo.tenantDoNumero(dono, soDigitos(numeroDoCanal));
  if (!tenantId) throw new NaoEncontrado('canal');

  const quem = await repo.identificar(dono, soDigitos(telefone), tenantId);
  return midia.guardar({ tenantId, produtorId: quem.produtorId, mime, bytes });
}

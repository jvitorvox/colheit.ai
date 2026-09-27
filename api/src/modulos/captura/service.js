import { dono } from '../../db.js';
import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { extrair, extratorLigado } from './extrator.js';
import * as pedidos from '../pedidos/service.js';
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
    midiaRef: entrada.midiaRef ?? null,
    produtorId: quem.produtorId, usuarioId: quem.usuarioId,
  });

  // Telefone que ninguém conhece não vira relato. Vira convite a se vincular —
  // e é a única resposta que faz sentido dar a quem não sabemos quem é.
  if (!quem.produtorId && !quem.usuarioId) {
    await responder(tenantId, telefone, msg.id,
      'Não reconheci este número. Peça ao seu consultor para enviar o convite de acesso.');
    return { mensagemId: msg.id, desfecho: 'nao_identificado' };
  }

  if (tipo === 'texto' && ehPergunta(entrada.texto)) {
    const resposta = await responderSobrePedido(quem, tenantId);
    await responder(tenantId, telefone, msg.id, resposta);
    return { mensagemId: msg.id, desfecho: 'respondido' };
  }

  // Relato do campo. Sem produtor identificado — caso do consultor mandando a
  // visita — o produtor virá da extração; até lá não há relato a criar.
  if (!quem.produtorId) {
    return { mensagemId: msg.id, desfecho: 'guardado', nota: 'relato de consultor depende da extração' };
  }

  const lido = await extrair({ tipo, texto: entrada.texto, midiaRef: entrada.midiaRef });
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

const PERGUNTAS = /(cad[eê]|onde|status|chegou|entrega|pedido|nota|boleto)/i;
const ehPergunta = (t) => PERGUNTAS.test(String(t ?? ''));

async function responderSobrePedido(quem, tenantId) {
  const ctx = quem.produtorId
    ? { produtor: quem.produtorId }
    : { tenant: tenantId, usuario: quem.usuarioId };

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

  return comContexto(ctx, async (cx) => {
    const r = await repo.buscarRelato(cx, id);
    if (!r) throw new NaoEncontrado('relato');
    const n = await repo.decidirRelato(cx, id, situacao, corpo.observacao, talhaoId);
    if (n === 0) throw new ErroDeUso(`relato já ${r.situacao}`);
    return repo.buscarRelato(cx, id);
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
    const lido = await extrair({ tipo: r.tipo, texto: r.texto, midiaRef: r.midia_ref });
    if (!lido) continue;
    await repo.aplicarExtracao(dono, r.id, lido.transcricao, lido.extraido, lido.tipo);
    n++;
  }
  return { extrator: 'ligado', processados: n };
}

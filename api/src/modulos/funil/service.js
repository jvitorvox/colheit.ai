import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { textoObrigatorio, umDe, uuidValido, areaValida } from '../cadastro/validar.js';

// A ordem importa: o funil anda para frente, e fechar é sair dele.
const ABERTOS = ['prospeccao', 'qualificacao', 'proposta', 'negociacao'];
const FECHADOS = ['ganha', 'perdida'];
const ESTAGIOS = [...ABERTOS, ...FECHADOS];

// Sacos por hectare. Sai da agronomia, não daqui — o padrão existe só para a
// estimativa não ficar em branco enquanto ninguém informou o número da cultura.
const SC_POR_HA_PADRAO = 1.0;

export function abrir(ctx, corpo = {}) {
  const o = {
    produtorId: uuidValido(corpo.produtorId, 'produtorId'),
    safra: textoObrigatorio(corpo.safra, 'safra', 10),
    potencialSc: areaValida(corpo.potencialSc, 'potencialSc'),
    responsavelId: corpo.responsavelId ? uuidValido(corpo.responsavelId, 'responsavelId') : null,
  };
  // Quem informa o número manda nele; sem informação, fica estimado da área.
  o.origemPotencial = o.potencialSc === null ? 'estimado' : 'informado';

  return comContexto(ctx, async (cx) => {
    if (!(await repo.produtorNaCarteira(cx, o.produtorId))) {
      throw new ErroDeUso('produtor não está na carteira desta empresa', 'produtorId');
    }
    if (await repo.porProdutorSafra(cx, o.produtorId, o.safra)) {
      throw new ErroDeUso('este produtor já tem oportunidade nesta safra', 'produtorId');
    }
    const id = await repo.abrir(cx, o);
    await repo.registrarEtapa(cx, id, 'prospeccao', 'oportunidade aberta');
    return repo.buscar(cx, id);
  });
}

/**
 * Move a oportunidade de estágio.
 *
 * Perder exige motivo — perder sem dizer por quê é como o funil vira relatório
 * de desculpa, e o motivo é justamente o que a safra seguinte precisa ler.
 */
export function mover(ctx, id, corpo = {}) {
  uuidValido(id, 'id');
  const estagio = umDe(corpo.estagio, ESTAGIOS, 'estagio');
  const motivo = estagio === 'perdida'
    ? textoObrigatorio(corpo.motivoPerda, 'motivoPerda', 300) : null;
  const concorrente = corpo.concorrente
    ? textoObrigatorio(corpo.concorrente, 'concorrente', 80) : null;

  return comContexto(ctx, async (cx) => {
    const o = await repo.buscar(cx, id);
    if (!o) throw new NaoEncontrado('oportunidade');
    if (o.estagio === estagio) throw new ErroDeUso(`já está em ${estagio}`);
    if (FECHADOS.includes(o.estagio) && FECHADOS.includes(estagio)) {
      throw new ErroDeUso(`oportunidade já ${o.estagio}`);
    }

    await repo.mover(cx, id, estagio, motivo, concorrente);
    await repo.registrarEtapa(cx, id, estagio, motivo ?? corpo.observacao);
    return repo.buscar(cx, id);
  });
}

export function definirPotencial(ctx, id, corpo = {}) {
  uuidValido(id, 'id');
  const potencial = areaValida(corpo.potencialSc, 'potencialSc');
  if (potencial === null) throw new ErroDeUso('potencialSc é obrigatório', 'potencialSc');
  return comContexto(ctx, async (cx) => {
    if (!(await repo.buscar(cx, id))) throw new NaoEncontrado('oportunidade');
    await repo.definirPotencial(cx, id, potencial, 'informado');
    return repo.buscar(cx, id);
  });
}

export function listar(ctx, filtros = {}) {
  if (filtros.estagio) umDe(filtros.estagio, ESTAGIOS, 'estagio');
  return comContexto(ctx, (cx) => repo.listar(cx, filtros));
}

export function buscar(ctx, id) {
  uuidValido(id, 'id');
  return comContexto(ctx, async (cx) => {
    const o = await repo.buscar(cx, id);
    if (!o) throw new NaoEncontrado('oportunidade');
    return { ...o, historico: await repo.historico(cx, id) };
  });
}

/** O funil por estágio, na ordem em que a conversa acontece. */
export function resumo(ctx, safra) {
  return comContexto(ctx, async (cx) => {
    const linhas = await repo.resumo(cx, safra ?? null);
    const porEstagio = Object.fromEntries(linhas.map((l) => [l.estagio, l]));
    return ESTAGIOS.map((estagio) => ({
      estagio,
      aberto: ABERTOS.includes(estagio),
      quantas: porEstagio[estagio]?.quantas ?? 0,
      potencialSc: Number(porEstagio[estagio]?.potencial_sc ?? 0),
    }));
  });
}

/**
 * O laço: a área que o campo cadastrou vira potencial, e o potencial encontra
 * o que foi vendido de verdade.
 *
 * A lacuna é onde o concorrente está. Mas repare no que isto NÃO diz: qual
 * marca ocupa a lacuna. Isso só o talhão conta, e quem traz o talhão é o
 * caderno de campo — dizer a marca sem ele seria inventar.
 */
export function penetracao(ctx, { safra, scPorHa } = {}) {
  const s = textoObrigatorio(safra, 'safra', 10);
  const taxa = areaValida(scPorHa, 'scPorHa') ?? SC_POR_HA_PADRAO;

  return comContexto(ctx, async (cx) => {
    const linhas = await repo.penetracao(cx, s, taxa);
    return {
      safra: s,
      scPorHa: taxa,
      origemDaTaxa: scPorHa ? 'informada' : 'padrão — confirmar com a agronomia',
      linhas: linhas.map((l) => {
        const potencial = Number(l.potencial_sc ?? 0);
        const comprado = Number(l.comprado_sc ?? 0);
        return {
          produtorId: l.produtor_id,
          produtor: l.produtor,
          areaHa: Number(l.area_ha ?? 0),
          potencialSc: potencial,
          compradoSc: comprado,
          lacunaSc: Math.max(potencial - comprado, 0),
          penetracao: l.penetracao === null ? null : Number(l.penetracao),
        };
      }),
    };
  });
}

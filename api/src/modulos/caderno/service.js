import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { textoObrigatorio, umDe, uuidValido, areaValida } from '../cadastro/validar.js';

const CICLOS = ['safra', 'safrinha'];

/**
 * Registra o plantio de um talhão.
 *
 * A marca é obrigatória, sempre — nossa ou de terceiro. É ela que responde a
 * H5, e é o único lugar de onde o share do concorrente pode sair: a
 * distribuidora não o entregaria, e o franqueado, sendo exclusivo, não o tem.
 *
 * Se o cultivar estiver no nosso catálogo, o vínculo é feito sozinho — é assim
 * que "nossa ou deles" se calcula sem ninguém classificar à mão.
 */
export function registrarPlantio(ctx, corpo = {}) {
  const p = {
    talhaoId: uuidValido(corpo.talhaoId, 'talhaoId'),
    safra: textoObrigatorio(corpo.safra, 'safra', 10),
    ciclo: umDe(corpo.ciclo, CICLOS, 'ciclo', 'safra'),
    cultura: corpo.cultura ? textoObrigatorio(corpo.cultura, 'cultura', 40) : null,
    cultivar: textoObrigatorio(corpo.cultivar, 'cultivar', 60),
    marca: textoObrigatorio(corpo.marca, 'marca', 60),
    lote: corpo.lote ? textoObrigatorio(corpo.lote, 'lote', 40) : null,
    areaHa: areaValida(corpo.areaHa, 'areaHa'),
    plantadoEm: corpo.plantadoEm ?? null,
    populacao: areaValida(corpo.populacao, 'populacao'),
    relatoId: corpo.relatoId ? uuidValido(corpo.relatoId, 'relatoId') : null,
  };

  return comContexto(ctx, async (cx) => {
    if (!(await repo.talhaoExiste(cx, p.talhaoId))) throw new NaoEncontrado('talhão');
    const doCatalogo = await repo.produtoDoCatalogo(cx, p.cultivar);
    const id = await repo.registrarPlantio(cx, { ...p, produtoId: doCatalogo?.id ?? null });
    return repo.buscarPlantio(cx, id);
  });
}

export function listarPlantios(ctx, filtros = {}) {
  if (filtros.talhaoId) uuidValido(filtros.talhaoId, 'talhaoId');
  if (filtros.produtorId) uuidValido(filtros.produtorId, 'produtorId');
  return comContexto(ctx, (cx) => repo.listarPlantios(cx, filtros));
}

export function buscarPlantio(ctx, id) {
  uuidValido(id, 'id');
  return comContexto(ctx, async (cx) => {
    const p = await repo.buscarPlantio(cx, id);
    if (!p) throw new NaoEncontrado('plantio');
    return p;
  });
}

/** O fim do laço: a semente virou saco por hectare. */
export function registrarColheita(ctx, plantioId, corpo = {}) {
  uuidValido(plantioId, 'plantioId');
  const c = {
    plantioId,
    colhidoEm: corpo.colhidoEm ?? null,
    produtividadeScHa: areaValida(corpo.produtividadeScHa, 'produtividadeScHa'),
    umidade: corpo.umidade === undefined || corpo.umidade === null
      ? null : areaValida(corpo.umidade, 'umidade'),
    observacao: corpo.observacao ? textoObrigatorio(corpo.observacao, 'observacao', 2000) : null,
  };
  if (c.produtividadeScHa === null) {
    throw new ErroDeUso('produtividadeScHa é obrigatória', 'produtividadeScHa');
  }

  return comContexto(ctx, async (cx) => {
    if (!(await repo.buscarPlantio(cx, plantioId))) throw new NaoEncontrado('plantio');
    await repo.registrarColheita(cx, c);
    return repo.buscarPlantio(cx, plantioId);
  });
}

/**
 * O share por marca — o último item de fosso, com número em vez de opinião.
 *
 * O denominador é a área plantada que NÓS enxergamos, não o mercado inteiro. A
 * resposta diz isso junto com o número, porque um share que se apresenta como
 * absoluto vira decisão errada na reunião seguinte.
 */
export function sharePorMarca(ctx, safra) {
  const s = textoObrigatorio(safra, 'safra', 10);
  return comContexto(ctx, async (cx) => {
    const linhas = await repo.sharePorMarca(cx, s);
    const total = linhas.reduce((soma, l) => soma + Number(l.area_ha ?? 0), 0);
    const nosso = linhas.filter((l) => l.nossa)
      .reduce((soma, l) => soma + Number(l.area_ha ?? 0), 0);
    return {
      safra: s,
      areaObservadaHa: total,
      nossoShare: total > 0 ? Number((nosso / total * 100).toFixed(1)) : null,
      base: 'área plantada que registramos — não o mercado do território',
      marcas: linhas.map((l) => ({
        marca: l.marca,
        nossa: l.nossa,
        areaHa: Number(l.area_ha ?? 0),
        talhoes: l.talhoes,
        share: l.share === null ? null : Number(l.share),
      })),
    };
  });
}

export function desempenho(ctx, safra) {
  return comContexto(ctx, (cx) => repo.desempenho(cx, safra ?? null));
}

/**
 * O relato de campo validado vira plantio.
 *
 * Chamado pelo módulo de captura quando o consultor valida um relato de tipo
 * lavoura ou lote. Sem cultivar e marca extraídos não há o que registrar — e
 * inventar a marca seria pior que não ter o registro.
 */
export async function registrarDePlanteRelato(ctx, relato) {
  const e = relato.extraido ?? {};
  if (!relato.talhao_id || !e.cultivar || !e.marca) return null;
  return registrarPlantio(ctx, {
    talhaoId: relato.talhao_id,
    safra: e.safra ?? String(new Date().getFullYear()).slice(2) + '/'
      + String(new Date().getFullYear() + 1).slice(2),
    ciclo: e.ciclo,
    cultura: e.cultura,
    cultivar: e.cultivar,
    marca: e.marca,
    lote: e.lote,
    areaHa: e.areaHa,
    populacao: e.populacao,
    relatoId: relato.id,
  });
}

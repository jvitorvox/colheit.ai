import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import * as midia from '../midia/service.js';
import { textoObrigatorio, umDe, uuidValido, areaValida } from '../cadastro/validar.js';

// O corte que o bench encontrou no concorrente e que a planilha de origem já
// gritava em outra forma: produtor sem visita há mais de quinze dias.
export const DIAS_DE_ALERTA = 15;

// Acima disto não é registro de visita, é aba esquecida aberta. Guardar o
// número seria envenenar a mediana que decide o produto.
const DURACAO_MAXIMA_SEG = 60 * 30;

// Bordadura, meio do talhão, praga de perto. Mais que isso não é registro de
// visita: é álbum, e cada foto é uma subida a mais numa conexão de fazenda.
const MAXIMO_FOTOS = 6;

export function registrar(ctx, corpo = {}) {
  const v = {
    produtorId: uuidValido(corpo.produtorId, 'produtorId'),
    propriedadeId: corpo.propriedadeId ? uuidValido(corpo.propriedadeId, 'propriedadeId') : null,
    talhaoId: corpo.talhaoId ? uuidValido(corpo.talhaoId, 'talhaoId') : null,
    em: corpo.em ?? null,
    canal: umDe(corpo.canal, ['app', 'whatsapp'], 'canal', 'app'),
    duracaoSeg: normalizarDuracao(corpo.duracaoSeg),
    estagio: corpo.estagio ? textoObrigatorio(corpo.estagio, 'estagio', 20) : null,
    estande: areaValida(corpo.estande, 'estande'),
    observacao: corpo.observacao ? textoObrigatorio(corpo.observacao, 'observacao', 2000) : null,
    relatoId: corpo.relatoId ? uuidValido(corpo.relatoId, 'relatoId') : null,
    // A chave do reenvio. Vem do aplicativo, que a gera ANTES de tentar
    // enviar — é isso que a torna a mesma nas duas tentativas.
    clienteId: corpo.clienteId ? uuidValido(corpo.clienteId, 'clienteId') : null,
  };

  // As fotos do talhão, já guardadas por POST /midia antes de chegar aqui. O
  // aplicativo sobe primeiro e manda os identificadores junto com a visita:
  // assim o reenvio não carrega o binário de novo.
  const midiaIds = (corpo.midiaIds ?? []).map((id, i) => uuidValido(id, `midiaIds[${i}]`));
  if (midiaIds.length > MAXIMO_FOTOS) {
    throw new ErroDeUso(`no máximo ${MAXIMO_FOTOS} fotos por visita`, 'midiaIds');
  }

  return comContexto(ctx, async (cx) => {
    if (!(await repo.produtorNaCarteira(cx, v.produtorId))) {
      throw new ErroDeUso('produtor não está na carteira desta empresa', 'produtorId');
    }

    // Reenvio é o normal de quem trabalha sem sinal, não a exceção: o rádio cai
    // no meio do POST, a resposta não chega, e o aplicativo tenta de novo sem
    // ter como saber se gravou. Devolver a visita que já existe é o que impede
    // uma visita de virar três registros de dez segundos na mediana da H1.
    const novo = await repo.registrar(cx, v);
    const id = novo ?? await repo.porClienteId(cx, v.clienteId);

    // O vínculo roda TAMBÉM no reenvio, e não só quando a visita nasce: se o
    // sinal caiu entre gravar a visita e pendurar as fotos, a segunda tentativa
    // é a única chance de completar. As duas escritas são idempotentes.
    if (midiaIds.length) {
      await repo.vincularMidia(cx, id, midiaIds);
      // Quem carimba de quem é a foto é este ponto, porque é aqui que o produtor
      // já foi conferido contra a carteira. É o que a faz aparecer no portal
      // dele: a lavoura é do produtor, e a foto dela também.
      await midia.atribuirAoProdutor(cx, midiaIds, v.produtorId);
    }

    return {
      ...(await repo.buscar(cx, id)),
      fotos: await repo.midiaDaVisita(cx, id),
      repetida: novo === null,
    };
  });
}

/**
 * O relato de campo validado vira visita.
 *
 * Chamado pelo módulo de captura quando o consultor valida um relato de tipo
 * visita — é o ponto onde o áudio do WhatsApp entra na mesma tabela do
 * formulário, e é o que permite comparar os dois canais na mesma régua.
 */
export function registrarDeRelato(ctx, relato, duracaoSeg) {
  return registrar(ctx, {
    produtorId: relato.produtor_id,
    talhaoId: relato.talhao_id ?? null,
    canal: 'whatsapp',
    duracaoSeg,
    em: relato.criado_em,
    estagio: relato.extraido?.estagio ?? null,
    estande: relato.extraido?.estande ?? null,
    observacao: relato.transcricao ?? null,
    relatoId: relato.id,
  });
}

function normalizarDuracao(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Math.round(Number(valor));
  if (!Number.isFinite(n) || n < 0) return null;
  return n > DURACAO_MAXIMA_SEG ? null : n;
}

export function listar(ctx, filtros = {}) {
  if (filtros.produtorId) uuidValido(filtros.produtorId, 'produtorId');
  return comContexto(ctx, (cx) => repo.listar(cx, filtros));
}

export function buscar(ctx, id) {
  uuidValido(id, 'id');
  return comContexto(ctx, async (cx) => {
    const v = await repo.buscar(cx, id);
    if (!v) throw new NaoEncontrado('visita');
    return { ...v, fotos: await repo.midiaDaVisita(cx, id) };
  });
}

/** A fila do dia, já marcando quem passou do corte. */
export function fila(ctx) {
  return comContexto(ctx, async (cx) => {
    const linhas = await repo.fila(cx);
    return linhas.map((l) => ({
      ...l,
      nunca: l.ultima_em === null,
      atrasado: l.ultima_em === null || l.dias > DIAS_DE_ALERTA,
      corteDias: DIAS_DE_ALERTA,
    }));
  });
}

/**
 * Como a H1 está indo.
 *
 * O veredito é do número, não da opinião: abaixo de 60 s de mediana confirma,
 * acima de 90 s mata. Devolver os dois canais lado a lado é o que responde a
 * pergunta que sobrou — se o canal de captura é o WhatsApp ou o aplicativo.
 */
export function medicaoH1(ctx, dias = 90) {
  const janela = Math.min(Math.max(Number(dias) || 90, 1), 730);
  return comContexto(ctx, async (cx) => {
    const porCanal = await repo.medicaoH1(cx, janela);
    const todas = porCanal.reduce((s, c) => s + c.visitas, 0);
    const medidas = porCanal.reduce((s, c) => s + c.medidas, 0);
    return {
      janelaDias: janela,
      visitas: todas,
      medidas,
      confirmaAbaixoDe: 60,
      mataAcimaDe: 90,
      porCanal,
    };
  });
}

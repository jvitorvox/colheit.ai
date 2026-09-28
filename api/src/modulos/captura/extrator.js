/**
 * A costura da IA — transcrever o áudio e estruturar o relato.
 *
 * ⚠️ DESLIGADA POR PADRÃO, e isso é decisão registrada, não esquecimento.
 *
 * Áudio de produtor descrevendo a própria lavoura é o dado mais sensível que o
 * projeto captura, e o plano sem-treino do provedor está pendente desde o
 * copiloto do CRM. Enquanto não estiver fechado, a mensagem é recebida e
 * guardada — o relato fica em `aguardando_extracao`, que é o estado honesto:
 * chegou, está seguro, ninguém leu.
 *
 * Nada se perde no caminho. Quando o extrator entrar, a fila é reprocessável.
 */
import { criarExtratorGemini } from './gemini.js';
import { lerComoDono } from '../midia/service.js';

let extratorAtual = null;

/** Liga um extrator. O teste injeta o dele; a produção injeta o de verdade. */
export function usarExtrator(fn) {
  extratorAtual = fn;
}

export function extratorLigado() {
  return extratorAtual !== null;
}

/**
 * Devolve { transcricao, extraido, tipo } ou null quando não há extrator.
 *
 * Nunca lança por falta de extrator: a ausência é um estado previsto do
 * sistema, não um erro da mensagem que chegou.
 */
export async function extrair(mensagem) {
  if (!extratorAtual) return null;
  return extratorAtual(mensagem);
}

/* ------------------------------------------------------------- a trava */

/**
 * Liga o extrator de verdade, se — e só se — o ambiente autorizar.
 *
 * São DUAS chaves, e a segunda não é técnica: `IA_PLANO=sem-treino` é a
 * declaração de que o contrato com o provedor proíbe treinar no que sobe. Ela
 * não tem efeito nenhum no código, e é justamente por isso que existe. Quem
 * liga a leitura automática precisa afirmar isso por escrito, num arquivo de
 * ambiente que alguém revisa, em vez de descobrir depois que a base de campo
 * do cliente virou dado de treino de terceiro.
 *
 * Só falta a chave? Fica desligado. Só falta a declaração? Fica desligado, e o
 * motivo aparece no log — é o caso que mais importa não passar em silêncio.
 *
 * Devolve o estado para quem subiu poder dizer em voz alta o que está valendo.
 */
export function ligarSeAutorizado({ registro = console } = {}) {
  const chave = process.env.IA_CHAVE;
  const plano = process.env.IA_PLANO;

  if (!chave) return { ligado: false, motivo: 'IA_CHAVE ausente' };

  if (plano !== 'sem-treino') {
    registro.warn?.(
      'extrator DESLIGADO: há IA_CHAVE, mas IA_PLANO não declara `sem-treino`. '
      + 'Áudio de produtor não sobe para provedor que pode treinar nele. '
      + 'A fila continua guardada em aguardando_extracao.');
    return { ligado: false, motivo: 'IA_PLANO não declarado' };
  }

  usarExtrator(criarExtratorGemini({ chave, lerMidia: lerComoDono, registro }));
  return {
    ligado: true,
    modelo: process.env.IA_MODELO || 'gemini-2.5-flash',
  };
}

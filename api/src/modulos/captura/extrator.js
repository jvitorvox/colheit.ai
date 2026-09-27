/**
 * A costura da IA — transcrever o áudio e estruturar o relato.
 *
 * ⚠️ DESLIGADA POR PADRÃO, e isso é decisão registrada, não esquecimento.
 *
 * Áudio de produtor descrevendo a própria lavoura é o dado mais sensível que o
 * projeto vai capturar, e o plano sem-treino do provedor está pendente desde o
 * copiloto do CRM. Enquanto não estiver fechado, a mensagem é recebida e
 * guardada — o relato fica em `aguardando_extracao`, que é o estado honesto:
 * chegou, está seguro, ninguém leu.
 *
 * Nada se perde no caminho. Quando o extrator entrar, a fila é reprocessável.
 */

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

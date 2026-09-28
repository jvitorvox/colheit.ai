// O extrator de verdade: transcreve o áudio e estrutura o relato.
//
// ⚠️ Este arquivo fala com um provedor externo, e o que ele manda é a voz de um
// produtor descrevendo a própria lavoura. Duas coisas decorrem disso e estão
// escritas em código, não em recomendação:
//
//   1. Nada sobe sem `IA_PLANO=sem-treino` declarado. A trava está em
//      extrator.js, e existe porque o plano do provedor é a única coisa que
//      separa "leitura automática" de "doar a base de campo do cliente".
//   2. O prompt NÃO leva nome, telefone, propriedade nem tenant. Vai o áudio e
//      um glossário. O provedor não precisa saber de quem é a voz para
//      transcrever o que ela diz, e o que ele não recebe não vaza.
//
// A saída é esquematizada pelo próprio provedor (`responseSchema`), não lida de
// prosa: campo de negócio extraído de texto livre por expressão regular é a
// receita de número errado com cara de número certo.

const MODELO_PADRAO = 'gemini-2.5-flash';
const TIMEOUT_PADRAO_MS = 20_000;

const url = (modelo) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

/* --------------------------------------------------------------- o esquema */

// Os nomes NÃO são livres: `cultivar`, `marca`, `lote`, `safra`, `ciclo`,
// `areaHa` e `populacao` são lidos por caderno.registrarDePlanteRelato, e
// `estagio` e `estande` por visitas.registrarDeRelato. Renomear um aqui quebra
// o laço lá sem quebrar teste nenhum deste arquivo — por isso ficam anotados.
const ESQUEMA = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['lavoura', 'visita', 'lote'] },
    transcricao: { type: 'string' },
    cultura: { type: 'string', nullable: true },
    cultivar: { type: 'string', nullable: true },
    marca: { type: 'string', nullable: true },
    lote: { type: 'string', nullable: true },
    safra: { type: 'string', nullable: true },
    ciclo: { type: 'string', enum: ['safra', 'safrinha'], nullable: true },
    areaHa: { type: 'number', nullable: true },
    populacao: { type: 'number', nullable: true },
    estagio: { type: 'string', nullable: true },
    estande: { type: 'number', nullable: true },
    talhao: { type: 'string', nullable: true },
    achado: { type: 'string', nullable: true },
    confianca: { type: 'number' },
  },
  required: ['tipo', 'transcricao', 'confianca'],
};

/* ---------------------------------------------------------------- o prompt */

const INSTRUCAO = `Você lê relatos de campo de produtores e consultores agrícolas no Brasil, falados em português, em áudio de WhatsApp ou foto.

Devolva JSON no esquema pedido. Regras, em ordem de importância:

1. NÃO INVENTE. Campo que não foi dito fica null. Preencher por probabilidade é o pior erro possível aqui: o consultor confere o que você escreveu, e um campo plausível e errado passa; um campo vazio ele preenche.
2. Transcreva literalmente em "transcricao", incluindo hesitação e nome próprio como foi falado. Não resuma, não corrija gramática, não traduza jargão.
3. "marca" é a empresa da semente (a marca do saco), "cultivar" é o material (por exemplo FS560, NS7709, TMG7067). Só preencha "marca" se ela foi DITA. Deduzir a marca pelo prefixo da cultivar é adivinhação.
4. "tipo": "visita" quando é o consultor relatando que passou na área; "lote" quando é a etiqueta ou o número do lote do saco; "lavoura" para o resto.
5. "talhao" é o nome como foi falado ("Gleba 4", "pivô do fundo"). Não tente identificar qual talhão cadastrado é — quem aponta isso é o consultor.
6. Unidade: "areaHa" em hectares, "estande" em plantas por metro, "populacao" em mil plantas por hectare. Se a unidade falada for outra, converta; se não der para saber qual é, deixe null.
7. "confianca" de 0 a 1: o quanto o áudio estava audível e o relato foi explícito. Áudio ruim com vento e trator é confiança baixa mesmo que você tenha entendido algo.

Glossário: safra é o plantio principal, safrinha é o segundo ciclo do mesmo ano. Talhão/gleba/quadra é a divisão da área. Estande é plantas por metro. "sc/ha" é sacas por hectare. Estádio fenológico vem como V2..V8, R1..R8. Bonificada ou GD é semente de geração de demanda.`;

/* ------------------------------------------------------------- o adaptador */

/**
 * Monta o extrator.
 *
 * `chamar` e `lerMidia` são injetados para o teste exercer o comportamento
 * inteiro — esquema, recusa, tempo esgotado, repetição — sem rede e sem chave.
 */
export function criarExtratorGemini({
  chave,
  modelo = process.env.IA_MODELO || MODELO_PADRAO,
  timeoutMs = Number(process.env.IA_TIMEOUT_MS) || TIMEOUT_PADRAO_MS,
  chamar = fetch,
  lerMidia,
  registro = console,
} = {}) {
  if (!chave) throw new Error('IA_CHAVE é obrigatória para ligar o extrator');

  return async function extrair({ tipo, texto, midiaId }) {
    const partes = [{ text: INSTRUCAO }];

    if (tipo === 'texto') {
      if (!texto?.trim()) return null;
      partes.push({ text: `Relato escrito:\n${texto}` });
    } else {
      if (!midiaId) return null;
      const m = await lerMidia(midiaId);
      if (!m?.bytes?.length) {
        registro.error?.(`extrator: mídia ${midiaId} não abriu`);
        return null;
      }
      partes.push({ inlineData: { mimeType: m.mime, data: m.bytes.toString('base64') } });
      // A legenda da foto costuma ser onde vem o número do lote.
      if (texto?.trim()) partes.push({ text: `Legenda enviada junto:\n${texto}` });
    }

    const corpo = {
      contents: [{ role: 'user', parts: partes }],
      generationConfig: {
        // Extração não é redação: variação aqui só produz campo diferente para
        // o mesmo áudio, e ninguém consegue conferir isso duas vezes.
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: ESQUEMA,
      },
    };

    const bruto = await pedir({ chamar, modelo, chave, corpo, timeoutMs, registro });
    if (!bruto) return null;
    return arrumar(bruto, registro);
  };
}

/**
 * Faz a chamada, com uma repetição só.
 *
 * Falha NUNCA lança: quem chama é o `receber` do gateway e o leitor da fila, e
 * nos dois o relato precisa continuar em `aguardando_extracao`. Devolver null
 * é o que mantém a mensagem viva para a próxima volta.
 */
async function pedir({ chamar, modelo, chave, corpo, timeoutMs, registro }) {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const abortar = AbortSignal.timeout(timeoutMs);
    try {
      const resp = await chamar(url(modelo), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': chave },
        body: JSON.stringify(corpo),
        signal: abortar,
      });

      if (resp.ok) return await resp.json();

      // 429 e 5xx passam; 400 e 403 são nossos (chave, cota, esquema) e
      // repetir só gasta. Chave errada tem de aparecer no log, não sumir.
      const passageiro = resp.status === 429 || resp.status >= 500;
      registro.error?.(`extrator: provedor devolveu ${resp.status}`);
      if (!passageiro || tentativa === 2) return null;
    } catch (erro) {
      registro.error?.(`extrator: ${erro.name === 'TimeoutError' ? 'tempo esgotado' : erro.message}`);
      if (tentativa === 2) return null;
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return null;
}

/**
 * Traduz a resposta para o contrato do módulo: { transcricao, extraido, tipo }.
 *
 * Campo nulo é descartado em vez de virar `null` no JSON guardado: o cartão do
 * consultor lista o que veio, e uma lista de "cultivar: null" seria ruído.
 */
function arrumar(bruto, registro) {
  const texto = bruto?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) {
    // Resposta vazia costuma ser bloqueio de segurança do provedor ou corte por
    // tamanho. Some no log com o motivo para não parecer relato mudo.
    registro.error?.(`extrator: resposta sem conteúdo (${bruto?.candidates?.[0]?.finishReason ?? 'sem motivo'})`);
    return null;
  }

  let lido;
  try {
    lido = JSON.parse(texto);
  } catch {
    registro.error?.('extrator: resposta não era JSON');
    return null;
  }

  const { tipo, transcricao, ...resto } = lido;
  const extraido = {};
  for (const [k, v] of Object.entries(resto)) {
    if (v !== null && v !== undefined && v !== '') extraido[k] = v;
  }

  return {
    tipo: ['lavoura', 'visita', 'lote'].includes(tipo) ? tipo : 'lavoura',
    transcricao: typeof transcricao === 'string' ? transcricao : null,
    extraido: Object.keys(extraido).length ? extraido : null,
  };
}

export const esquemaDaExtracao = ESQUEMA;
export const instrucaoDaExtracao = INSTRUCAO;

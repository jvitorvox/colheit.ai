// O laço do gateway: recebe do WhatsApp e entrega à API; busca o que a API
// quer responder e devolve ao WhatsApp.
//
// Nenhuma linha daqui conhece o Baileys. É de propósito: a biblioteca é a
// parte que não dá para testar sem WhatsApp, e ela fica isolada em
// whatsapp.js. Isto aqui roda em teste com um cliente de mentira, e é o que
// permite exercitar o comportamento inteiro sem número nenhum.

/** Ritmo de envio. Rajada é o que mais chama atenção — e atenção vira bloqueio. */
const PAUSA_ENTRE_ENVIOS_MS = 1200;

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

/**
 * Trata uma mensagem que chegou.
 *
 * Grupo, status e mensagem nossa são descartados antes de qualquer coisa: o
 * canal é de conversa de um para um, e responder num grupo seria disparo aos
 * olhos de quem só estava lendo.
 */
export function criarRecebedor({ api, registro = console }) {
  const vistas = new Set();

  return async function receber(bruta) {
    if (!bruta || bruta.deMim || bruta.deGrupo || bruta.deStatus) return { ignorada: true };

    // O mesmo id pode chegar duas vezes numa reconexão. Guardar só o que cabe
    // na memória: é fila de minutos, não histórico.
    if (bruta.id && vistas.has(bruta.id)) return { repetida: true };
    if (bruta.id) {
      vistas.add(bruta.id);
      if (vistas.size > 5000) vistas.delete(vistas.values().next().value);
    }

    const de = soDigitos(bruta.de);
    const para = soDigitos(bruta.para);
    if (!de || !para) return { ignorada: true };

    // O binário sobe primeiro, e o que segue na mensagem é o identificador.
    // Se a subida falhar, a mensagem vai mesmo assim: o produtor mandou e vai
    // cobrar — o consultor ao menos vê que chegou algo dele, o que é melhor do
    // que o silêncio de uma mensagem descartada.
    let midiaId = null;
    if (bruta.bytes?.length) {
      try {
        midiaId = (await api.guardarMidia({ de, para, mime: bruta.mime, bytes: bruta.bytes })).id;
      } catch (erro) {
        registro.error?.(`falhou a mídia de ${de}: ${erro.message}`);
      }
    }

    try {
      const r = await api.entregarMensagem({
        de, para, tipo: bruta.tipo, texto: bruta.texto ?? null, midiaId,
        // Só o áudio tem duração, e é ela que mede a H1 deste canal.
        duracaoSeg: bruta.duracaoSeg ?? null,
      });
      registro.info?.(`entrada ${bruta.tipo} de ${de}: ${r.desfecho}`);
      return r;
    } catch (erro) {
      // Mensagem que não entrou na API não pode sumir sem rastro: o produtor
      // mandou e vai cobrar. Sai no log com o remetente para dar para buscar.
      registro.error?.(`falhou a entrada de ${de}: ${erro.message}`);
      return { erro: erro.message };
    }
  };
}

/**
 * Drena a fila de saída.
 *
 * A API só cria saída atrelada a uma entrada — o banco recusa o contrário —,
 * então aqui não há decisão a tomar sobre disparar ou não. O gateway envia o
 * que lhe deram, na ordem, com pausa.
 */
export function criarEnviador({ api, conexoes, registro = console, pausaMs = PAUSA_ENTRE_ENVIOS_MS }) {
  return async function despachar() {
    let saidas;
    try {
      saidas = await api.saidasPendentes();
    } catch (erro) {
      registro.error?.(`não consegui ler a fila: ${erro.message}`);
      return { lidas: 0, enviadas: 0, semConexao: 0 };
    }

    const resumo = { lidas: saidas.length, enviadas: 0, semConexao: 0, falhas: 0 };

    for (const s of saidas) {
      const conexao = conexoes.get(soDigitos(s.de));
      if (!conexao) {
        // Número não conectado agora. A saída fica na fila: quando a conexão
        // voltar, ela sai. Melhor tarde que nunca, para resposta que o
        // produtor está esperando.
        resumo.semConexao++;
        continue;
      }
      try {
        await conexao.enviarTexto(soDigitos(s.para), s.texto);
        await api.marcarEnviada(s.id);
        resumo.enviadas++;
      } catch (erro) {
        registro.error?.(`falha ao enviar ${s.id}: ${erro.message}`);
        resumo.falhas++;
      }
      if (pausaMs) await espera(pausaMs);
    }
    return resumo;
  };
}

/**
 * Sobe uma conexão por canal e mantém o laço rodando.
 *
 * `abrirConexao` é injetado: em produção é o Baileys, em teste é um dublê.
 * Devolve `parar()` para o processo poder encerrar limpo.
 */
export async function iniciar({ api, abrirConexao, registro = console, intervaloMs = 4000, pausaMs }) {
  const conexoes = new Map();
  const receber = criarRecebedor({ api, registro });
  const despachar = criarEnviador({ api, conexoes, registro, pausaMs });

  const canais = await api.canais();
  if (canais.length === 0) registro.warn?.('nenhum canal ativo — nada a conectar');

  for (const canal of canais) {
    const numero = soDigitos(canal.numero);

    // A conexão pode abrir antes de `abrirConexao` devolver o objeto — o
    // Baileys emite `connection.update` assim que o socket sobe, e uma sessão
    // já pareada abre de imediato. Por isso a variável é declarada antes e o
    // registro é tentado dos dois lados: quem chegar por último completa.
    let conexao = null;
    let abriu = false;
    const registrar = () => {
      if (!abriu || !conexao || conexoes.get(numero) === conexao) return;
      conexoes.set(numero, conexao);
      api.marcarConectado(numero).catch(() => {});
      registro.info?.(`canal ${numero} conectado`);
    };

    conexao = await abrirConexao({
      numero,
      aoReceber: (m) => receber({ ...m, para: numero }),
      aoConectar: () => { abriu = true; registrar(); },
      // Bloqueio não se resolve reconectando: o número foi embora, e insistir
      // só queima o próximo. Some da lista e fica registrado bem visível.
      aoCair: ({ definitivo, motivo }) => {
        abriu = false;
        conexoes.delete(numero);
        if (definitivo) registro.error?.(`canal ${numero} ENCERRADO (${motivo}) — precisa de novo pareamento`);
        else registro.warn?.(`canal ${numero} caiu (${motivo}), reconectando`);
      },
    });
    registrar();
  }

  const relogio = setInterval(() => { despachar().catch(() => {}); }, intervaloMs);

  return {
    conexoes,
    despachar,
    receber,
    async parar() {
      clearInterval(relogio);
      for (const c of conexoes.values()) await c.fechar?.().catch?.(() => {});
    },
  };
}

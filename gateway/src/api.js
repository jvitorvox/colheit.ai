// Cliente da API. O gateway não é usuário e não tem sessão: identifica-se por
// segredo compartilhado, e é a única porta dele para dentro.

const BASE = process.env.API_BASE ?? 'http://api:3000';
const SEGREDO = process.env.GATEWAY_SEGREDO ?? '';

async function chamar(caminho, { metodo = 'GET', corpo } = {}) {
  if (!SEGREDO || SEGREDO.length < 16) {
    throw new Error('GATEWAY_SEGREDO ausente ou curto demais');
  }
  const resp = await fetch(BASE + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-gateway-segredo': SEGREDO },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(dados?.erro ?? `api ${resp.status}`);
  return dados;
}

/**
 * Sobe o binário. Corpo cru em vez de JSON porque base64 num campo de texto
 * inchava o áudio em um terço para nada — e o destino é um arquivo, não um
 * documento.
 *
 * O gateway não diz de quem é: manda o canal e o remetente, e a API resolve.
 */
async function subirMidia({ de, para, mime, bytes }) {
  if (!SEGREDO || SEGREDO.length < 16) {
    throw new Error('GATEWAY_SEGREDO ausente ou curto demais');
  }
  const resp = await fetch(`${BASE}/captura/midia`, {
    method: 'POST',
    headers: {
      'content-type': mime,
      'x-gateway-segredo': SEGREDO,
      'x-canal': para,
      'x-de': de,
    },
    body: bytes,
  });
  const dados = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(dados?.erro ?? `api ${resp.status}`);
  return dados;
}

export const api = {
  guardarMidia: subirMidia,
  canais: () => chamar('/captura/canais'),
  marcarConectado: (numero) => chamar(`/captura/canais/${numero}/conectado`, { metodo: 'POST' }),
  entregarMensagem: (m) => chamar('/captura/mensagens', { metodo: 'POST', corpo: m }),
  saidasPendentes: () => chamar('/captura/saidas'),
  marcarEnviada: (id) => chamar(`/captura/saidas/${id}/enviada`, { metodo: 'POST' }),
};

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

export const api = {
  canais: () => chamar('/captura/canais'),
  marcarConectado: (numero) => chamar(`/captura/canais/${numero}/conectado`, { metodo: 'POST' }),
  entregarMensagem: (m) => chamar('/captura/mensagens', { metodo: 'POST', corpo: m }),
  saidasPendentes: () => chamar('/captura/saidas'),
  marcarEnviada: (id) => chamar(`/captura/saidas/${id}/enviada`, { metodo: 'POST' }),
};

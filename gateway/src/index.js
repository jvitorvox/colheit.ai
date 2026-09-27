import { api } from './api.js';
import { abrirConexao } from './whatsapp.js';
import { iniciar } from './laco.js';

// Sobe uma conexão por canal e mantém o laço. Se a API ainda não estiver de
// pé, espera — o gateway sozinho não serve para nada, e desistir no primeiro
// erro só faria o contêiner reiniciar em laço.
async function esperarApi(tentativas = 30) {
  for (let i = 0; i < tentativas; i++) {
    try { return await api.canais(); } catch { await new Promise((o) => setTimeout(o, 2000)); }
  }
  throw new Error('a API não respondeu a tempo');
}

const canais = await esperarApi();
console.log(`gateway: ${canais.length} canal(is) para conectar`);

const laco = await iniciar({ api, abrirConexao });

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => { await laco.parar(); process.exit(0); });
}

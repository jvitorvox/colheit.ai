// Service worker do aplicativo de campo.
//
// Faz UMA coisa: garantir que o app abra e mostre a fila do dia sem sinal.
//
// Ele NÃO reenvia a fila de saída. A fila mora em IndexedDB e o reenvio mora na
// página, e é decisão: o token de sessão está na página, e replicá-lo aqui para
// o service worker poder enviar com o app fechado significaria guardar
// credencial num lugar que o botão Sair não alcança. O consultor volta ao
// sinal com o app aberto ou reabre o app — e `escoar()` roda nos dois casos.
//
// Escopo `/consultor`: o portal do produtor tem o `sw.js` dele, que serve
// leitura e push e não quer saber de fila de escrita.

const VERSAO = 'campo-v2';
const CASCA = `casca-${VERSAO}`;
const DADOS = `dados-${VERSAO}`;

const ARQUIVOS = [
  '/consultor', '/consultor.html', '/consultor.js', '/base.css',
  '/manifest-consultor.json', '/icone-192.png',
];

// Só a fila do dia e quem sou eu. Nada de /auth/login: resposta de
// autenticação não se guarda, nem em cache de casca.
const GUARDAVEIS = ['/visitas/fila', '/auth/eu', '/caderno/resultado'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CASCA)
      // `addAll` é tudo-ou-nada: um arquivo fora do ar deixaria o app sem
      // casca nenhuma. Um a um, o que der certo fica.
      .then((c) => Promise.all(ARQUIVOS.map((a) => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes.filter((n) => n.endsWith('-campo') || (n.includes('campo') && !n.endsWith(VERSAO)))
          .map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const { request } = ev;
  // POST de visita NUNCA passa por aqui: quem controla o reenvio é a fila da
  // página, e um service worker tentando ajudar criaria uma segunda fila que
  // ninguém governa.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (GUARDAVEIS.some((raiz) => url.pathname.startsWith(raiz))) {
    ev.respondWith(redePrimeiro(request));
    return;
  }

  if (url.pathname.startsWith('/auth/')) return;   // nunca guardar sessão

  ev.respondWith(
    caches.match(request).then((achado) => achado ?? fetch(request).then((resp) => {
      if (resp.ok) {
        const copia = resp.clone();
        caches.open(CASCA).then((c) => c.put(request, copia));
      }
      return resp;
    })),
  );
});

/**
 * Rede primeiro, cópia guardada como última carta.
 *
 * A resposta que vem do cache sai marcada com `x-do-cache`, e a tela diz isso
 * ao consultor. Fila de ontem passando por fila de hoje é pior que fila
 * nenhuma: ele dirige até um produtor que o colega já visitou.
 */
async function redePrimeiro(request) {
  try {
    const resp = await fetch(request);
    if (resp.ok) {
      const copia = resp.clone();
      caches.open(DADOS).then((c) => c.put(request, copia));
    }
    return resp;
  } catch (erro) {
    const guardado = await caches.match(request);
    if (!guardado) throw erro;
    const corpo = await guardado.text();
    return new Response(corpo, {
      headers: { 'content-type': 'application/json', 'x-do-cache': '1' },
    });
  }
}

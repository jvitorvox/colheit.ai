// Service worker do portal.
//
// Faz duas coisas, e nenhuma a mais: guarda a casca para o app abrir sem
// conexão, e recebe o push. Escrita offline NÃO entra aqui — o portal do
// produtor é de leitura, e fila de sincronização é problema do aplicativo do
// consultor, que é quem trabalha em área sem sinal.

const VERSAO = 'v1';
const CASCA = `casca-${VERSAO}`;
const DADOS = `dados-${VERSAO}`;

const ARQUIVOS = ['/', '/index.html', '/app.js', '/manifest.json', '/icone-192.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CASCA).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes.filter((n) => !n.endsWith(VERSAO)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const { request } = ev;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Dados da API: rede primeiro, e o cache é a última carta — mostrar dado
  // velho identificado como velho é melhor que tela em branco no meio do
  // talhão. Nunca guardamos resposta de autenticação.
  if (ehApi(url.pathname)) {
    if (url.pathname.startsWith('/auth/')) return;
    ev.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp.ok) {
            const copia = resp.clone();
            caches.open(DADOS).then((c) => c.put(request, copia));
          }
          return resp;
        })
        .catch(async () => {
          const guardado = await caches.match(request);
          if (!guardado) throw new Error('sem conexão e sem cópia');
          const corpo = await guardado.json();
          return new Response(JSON.stringify(corpo), {
            headers: { 'content-type': 'application/json', 'x-do-cache': '1' },
          });
        }),
    );
    return;
  }

  // Casca: cache primeiro. Ela quase não muda, e é o que faz o app abrir.
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

const ehApi = (p) => ['/auth/', '/pedidos', '/cadastro/', '/push/', '/captura/']
  .some((raiz) => p.startsWith(raiz));

/* ------------------------------------------------------------------ push */

self.addEventListener('push', (ev) => {
  let dados = { titulo: 'colheit.ai', texto: 'Novidade no seu pedido.' };
  try { dados = { ...dados, ...ev.data.json() }; } catch { /* payload vazio ou texto */ }

  ev.waitUntil(self.registration.showNotification(dados.titulo, {
    body: dados.texto,
    icon: '/icone-192.png',
    badge: '/icone-192.png',
    tag: dados.pedidoId ? `pedido-${dados.pedidoId}` : 'geral',
    renotify: true,
    data: { pedidoId: dados.pedidoId ?? null },
  }));
});

// Tocar no aviso abre o pedido — e reaproveita a janela aberta, se houver.
self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const destino = ev.notification.data?.pedidoId
    ? `/#/pedido/${ev.notification.data.pedidoId}`
    : '/';
  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const j of janelas) {
        if (j.url.includes(self.location.origin)) {
          j.navigate(destino);
          return j.focus();
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});

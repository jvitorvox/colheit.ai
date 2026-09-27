// O laço do gateway, exercitado inteiro com um WhatsApp de mentira.
//
// A parte que conhece o Baileys (whatsapp.js) não entra aqui — não há como
// testá-la sem um número de verdade, e é por isso que ela não decide nada.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { criarRecebedor, criarEnviador, iniciar } from '../gateway/src/laco.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const NUMERO = '5566999000033';
const TEL = '5566999440088';
let req, base, fechar, tGestor, produtorId;

/** O cliente da API como o gateway o usa, apontando para o servidor de teste. */
function clienteApi() {
  const h = { 'content-type': 'application/json', 'x-gateway-segredo': process.env.GATEWAY_SEGREDO };
  const chamar = async (caminho, metodo = 'GET', corpo) => {
    const r = await fetch(base + caminho, {
      method: metodo, headers: h, body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.erro ?? `api ${r.status}`);
    return d;
  };
  const guardarMidia = async ({ de, para, mime, bytes }) => {
    const r = await fetch(`${base}/captura/midia`, {
      method: 'POST',
      headers: { 'content-type': mime, 'x-gateway-segredo': h['x-gateway-segredo'], 'x-canal': para, 'x-de': de },
      body: bytes,
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.erro ?? `api ${r.status}`);
    return d;
  };

  return {
    guardarMidia,
    canais: () => chamar('/captura/canais'),
    marcarConectado: (n) => chamar(`/captura/canais/${n}/conectado`, 'POST'),
    entregarMensagem: (m) => chamar('/captura/mensagens', 'POST', m),
    saidasPendentes: () => chamar('/captura/saidas'),
    marcarEnviada: (id) => chamar(`/captura/saidas/${id}/enviada`, 'POST'),
  };
}

const mudo = { info() {}, warn() {}, error() {} };

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ({ req, base, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');

  await req('/captura/canal', { metodo: 'POST', token: tGestor, corpo: { numero: NUMERO } });
  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  await req('/auth/convites', { metodo: 'POST', token: tGestor, corpo: { produtorId, telefone: TEL } });
});

after(async () => { await fechar(); await encerrar(); });

/* ------------------------------------------------------------ o que entra */

test('mensagem de grupo, de status e nossa são descartadas antes de tudo', async () => {
  const receber = criarRecebedor({ api: clienteApi(), registro: mudo });
  for (const bruta of [
    { id: 'a', de: TEL, para: NUMERO, tipo: 'texto', texto: 'oi', deGrupo: true },
    { id: 'b', de: TEL, para: NUMERO, tipo: 'texto', texto: 'oi', deStatus: true },
    { id: 'c', de: TEL, para: NUMERO, tipo: 'texto', texto: 'oi', deMim: true },
  ]) {
    assert.equal((await receber(bruta)).ignorada, true,
      'responder num grupo seria disparo aos olhos de quem só estava lendo');
  }
});

test('a mesma mensagem que chega duas vezes entra uma', async () => {
  const receber = criarRecebedor({ api: clienteApi(), registro: mudo });
  const bruta = { id: 'repetida-1', de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'a.ogg' };

  const um = await receber(bruta);
  const dois = await receber(bruta);
  assert.ok(um.relatoId, 'a primeira entra');
  assert.equal(dois.repetida, true, 'reconexão reentrega — e não pode duplicar o relato');
});

test('o áudio sobe primeiro, e a mensagem sai apontando para ele', async () => {
  const receber = criarRecebedor({ api: clienteApi(), registro: mudo });
  const r = await receber({
    id: 'nova-1', de: TEL, para: NUMERO, tipo: 'audio',
    bytes: Buffer.from('OggS voz de gente no meio da lavoura'), mime: 'audio/ogg; codecs=opus',
  });
  assert.equal(r.desfecho, 'relato_aguardando_extracao');

  const fila = await req('/captura/relatos', { token: tGestor });
  assert.ok(fila.corpo.length >= 2);
  assert.ok(fila.corpo.some((x) => x.midia_id), 'o relato do áudio aponta para a mídia');
});

test('mídia que não sobe não derruba a mensagem', async () => {
  // O produtor mandou e vai cobrar. Sem o áudio o relato fica pobre, mas o
  // consultor ao menos vê que chegou algo dele — silêncio seria pior.
  const quebrado = { ...clienteApi(), guardarMidia: async () => { throw new Error('armazém fora'); } };
  const registrado = [];
  const receber = criarRecebedor({ api: quebrado, registro: { ...mudo, error: (m) => registrado.push(m) } });

  const r = await receber({
    id: 'nova-2', de: TEL, para: NUMERO, tipo: 'imagem',
    bytes: Buffer.from('\xff\xd8\xff foto da soja'), mime: 'image/jpeg',
  });
  assert.equal(r.desfecho, 'relato_aguardando_extracao');
  assert.match(registrado[0], /armazém fora/);
  assert.match(registrado[0], new RegExp(TEL));
});

test('falha da API não faz a mensagem sumir em silêncio', async () => {
  const quebrado = { ...clienteApi(), entregarMensagem: async () => { throw new Error('api fora'); } };
  const registrado = [];
  const receber = criarRecebedor({ api: quebrado, registro: { ...mudo, error: (m) => registrado.push(m) } });

  const r = await receber({ id: 'perdida-1', de: TEL, para: NUMERO, tipo: 'texto', texto: 'oi' });
  assert.equal(r.erro, 'api fora');
  assert.match(registrado[0], new RegExp(TEL), 'o remetente sai no log para dar para buscar');
});

/* -------------------------------------------------------------- o que sai */

test('envia só o que a API enfileirou, e marca como enviada', async () => {
  const enviadas = [];
  const conexoes = new Map([[NUMERO, { enviarTexto: async (p, t) => enviadas.push({ p, t }) }]]);
  const despachar = criarEnviador({ api: clienteApi(), conexoes, registro: mudo, pausaMs: 0 });

  const r = await despachar();
  assert.ok(r.enviadas > 0);
  assert.ok(enviadas.every((e) => e.p === TEL));
  assert.ok(enviadas.some((e) => /guardei|conferir/.test(e.t)));

  const depois = await despachar();
  assert.equal(depois.lidas, 0, 'o que saiu não volta para a fila');
});

test('sem conexão, a saída espera em vez de se perder', async () => {
  const receber = criarRecebedor({ api: clienteApi(), registro: mudo });
  await receber({ id: 'espera-1', de: TEL, para: NUMERO, tipo: 'texto', texto: 'cadê meu pedido?' });

  const semNada = criarEnviador({ api: clienteApi(), conexoes: new Map(), registro: mudo, pausaMs: 0 });
  const r = await semNada();
  assert.equal(r.semConexao, 1);
  assert.equal(r.enviadas, 0);

  const enviadas = [];
  const conexoes = new Map([[NUMERO, { enviarTexto: async (p, t) => enviadas.push({ p, t }) }]]);
  const agora = criarEnviador({ api: clienteApi(), conexoes, registro: mudo, pausaMs: 0 });
  assert.equal((await agora()).enviadas, 1, 'quando a conexão volta, a resposta sai');
});

test('falha de envio não marca como enviada — ela tenta de novo depois', async () => {
  const receber = criarRecebedor({ api: clienteApi(), registro: mudo });
  await receber({ id: 'falha-1', de: TEL, para: NUMERO, tipo: 'texto', texto: 'e o pedido?' });

  const ruim = new Map([[NUMERO, { enviarTexto: async () => { throw new Error('socket caiu'); } }]]);
  const r = await criarEnviador({ api: clienteApi(), conexoes: ruim, registro: mudo, pausaMs: 0 })();
  assert.equal(r.falhas, 1);
  assert.equal(r.enviadas, 0);

  const bom = new Map([[NUMERO, { enviarTexto: async () => {} }]]);
  const dnv = await criarEnviador({ api: clienteApi(), conexoes: bom, registro: mudo, pausaMs: 0 })();
  assert.equal(dnv.enviadas, 1, 'continuava na fila');
});

/* ------------------------------------------------------- o laço completo */

test('o laço sobe uma conexão por canal e roda ponta a ponta', async () => {
  const enviadas = [];
  let aoReceberDoCanal;

  const abrirConexao = async ({ numero, aoReceber, aoConectar }) => {
    assert.equal(numero, NUMERO);
    aoReceberDoCanal = aoReceber;
    const conexao = { enviarTexto: async (p, t) => enviadas.push({ p, t }), fechar: async () => {} };
    queueMicrotask(aoConectar);
    return conexao;
  };

  const laco = await iniciar({
    api: clienteApi(), abrirConexao, registro: mudo, intervaloMs: 60000, pausaMs: 0,
  });
  try {
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(laco.conexoes.size, 1, "um número por tenant");

    // chega uma pergunta, e a resposta sai pelo mesmo canal
    await aoReceberDoCanal({ id: "laco-1", de: TEL, tipo: "texto", texto: "cadê meu pedido?" });
    const r = await laco.despachar();
    assert.ok(r.enviadas >= 1);
    assert.ok(enviadas.some((e) => e.p === TEL));
  } finally {
    // Sem isto, uma asserção que falha deixa o intervalo vivo e a suíte inteira
    // fica pendurada esperando o laço de eventos esvaziar.
    await laco.parar();
  }
});

test('a conexão que cai definitivo some da lista — bloqueio não se reconecta', async () => {
  let derrubar;
  const abrirConexao = async ({ aoConectar, aoCair }) => {
    const conexao = { enviarTexto: async () => {}, fechar: async () => {} };
    queueMicrotask(aoConectar);
    derrubar = aoCair;
    return conexao;
  };

  const avisos = [];
  const laco = await iniciar({
    api: clienteApi(), abrirConexao, intervaloMs: 60000, pausaMs: 0,
    registro: { ...mudo, error: (m) => avisos.push(m) },
  });
  try {
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(laco.conexoes.size, 1);

    derrubar({ definitivo: true, motivo: 401 });
    assert.equal(laco.conexoes.size, 0);
    assert.match(avisos[0], /ENCERRADO/, "insistir só queimaria o próximo número");
  } finally {
    await laco.parar();
  }
});

test('marca o canal como conectado na API', async () => {
  const { dono } = await import('../api/src/db.js');
  const { rows } = await dono.query('select conectado_em from canal_whatsapp where numero = $1', [NUMERO]);
  assert.ok(rows[0].conectado_em, 'dá para ver na base quando o número apareceu pela última vez');
});

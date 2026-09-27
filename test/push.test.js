// Push: assinar a própria caixa, e o despacho da fila com os três desfechos.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { despachar } from '../api/src/modulos/push/despachante.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const TEL = '5566999550033';
let req, fechar, revenda, tRevenda, tProdutor, produtorId, propriedadeId;

/** Assinatura como o navegador manda: endpoint https e o par de chaves. */
const assinatura = (n) => ({
  endpoint: `https://push.exemplo/ab${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
  agente: n === 9 ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)' : 'Mozilla/5.0 (Android 14)',
});

async function pedidoComAviso(numero) {
  const p = await req('/pedidos', {
    metodo: 'POST', token: tRevenda,
    corpo: { numero, safra: '26/27', produtorId, propriedadeId,
      itens: [{ cultivar: 'FS695', quantidade: 100 }] },
  });
  // etapa 2 avisa
  await req(`/pedidos/${p.corpo.id}/avancar`, { metodo: 'POST', token: tRevenda, corpo: {} });
  return p.corpo.id;
}

const pendentes = async () => (await dono.query(
  'select count(*)::int as n from notificacao where enviada_em is null and descartada_em is null')
).rows[0].n;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ({ req, fechar } = await subirApi());
  tRevenda = await entrar(req, 'gestora@3t.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT' },
  });
  propriedadeId = f.corpo.id;

  await req('/auth/convites', { metodo: 'POST', token: tRevenda, corpo: { produtorId, telefone: TEL } });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: cod.corpo.codigo },
  });
  tProdutor = ent.corpo.token;
});

after(async () => { await fechar(); await encerrar(); });

/* ------------------------------------------------------------- assinatura */

test('a chave pública sai sem sessão — o navegador precisa dela antes', async () => {
  const r = await req('/push/chave-publica');
  assert.equal(r.status, 200);
  assert.ok(r.corpo.chavePublica.length > 80);
});

test('o produtor assina a própria caixa', async () => {
  const r = await req('/push/assinaturas', {
    metodo: 'POST', token: tProdutor, corpo: assinatura(1),
  });
  assert.equal(r.status, 201);

  const minhas = await req('/push/assinaturas', { token: tProdutor });
  assert.equal(minhas.corpo.length, 1);
});

test('assinar de novo o mesmo navegador atualiza, não duplica', async () => {
  await req('/push/assinaturas', { metodo: 'POST', token: tProdutor, corpo: assinatura(1) });
  const minhas = await req('/push/assinaturas', { token: tProdutor });
  assert.equal(minhas.corpo.length, 1, 'o endpoint é a identidade do navegador');
});

test('celular e desktop são duas assinaturas da mesma pessoa', async () => {
  await req('/push/assinaturas', { metodo: 'POST', token: tProdutor, corpo: assinatura(2) });
  const minhas = await req('/push/assinaturas', { token: tProdutor });
  assert.equal(minhas.corpo.length, 2);
});

test('endpoint torto é recusado', async () => {
  const r = await req('/push/assinaturas', {
    metodo: 'POST', token: tProdutor, corpo: { endpoint: 'http://inseguro', keys: { p256dh: 'a', auth: 'b' } },
  });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'endpoint');
});

test('a empresa não enxerga a caixa do produtor', async () => {
  const r = await req('/push/assinaturas', { token: tRevenda });
  assert.deepEqual(r.corpo, []);
});

test('sem sessão não se assina nada', async () => {
  const r = await req('/push/assinaturas', { metodo: 'POST', corpo: assinatura(3) });
  assert.equal(r.status, 401);
});

/* ---------------------------------------------------------------- despacho */

test('entrega o aviso e marca a fila', async () => {
  await pedidoComAviso('PD-0001');
  assert.ok(await pendentes() > 0);

  const vistos = [];
  const r = await despachar({ enviar: async (a, carga) => { vistos.push({ a, carga }); return { ok: true }; } });

  assert.equal(r.enviadas > 0, true);
  assert.equal(await pendentes(), 0);
  assert.equal(vistos.length, 2, 'os dois navegadores dele recebem');
  assert.match(vistos[0].carga.texto, /PD-0001/);
  assert.equal(vistos[0].carga.etapa, 2);
});

test('basta um navegador receber para o aviso estar entregue', async () => {
  await pedidoComAviso('PD-0002');
  const r = await despachar({
    enviar: async (a) => (a.endpoint.endsWith('ab1')
      ? { ok: true }
      : { ok: false, morta: false, motivo: 'timeout' }),
  });
  assert.equal(r.enviadas, 1);
  assert.equal(await pendentes(), 0, 'quem tem celular e desktop não precisa dos dois de pé');
});

test('assinatura morta é removida, não reprocessada', async () => {
  await pedidoComAviso('PD-0003');
  const r = await despachar({
    enviar: async (a) => (a.endpoint.endsWith('ab2')
      ? { ok: false, morta: true, motivo: 'http 410' }
      : { ok: true }),
  });
  assert.equal(r.assinaturasRemovidas, 1);

  const minhas = await req('/push/assinaturas', { token: tProdutor });
  assert.equal(minhas.corpo.length, 1, 'navegador desinstalado sai da base');
});

test('falha passageira adia, e desiste depois de três tentativas', async () => {
  await pedidoComAviso('PD-0004');
  const cair = async () => ({ ok: false, morta: false, motivo: 'servidor fora' });

  const um = await despachar({ enviar: cair });
  assert.equal(um.adiadas, 1);
  assert.equal(await pendentes(), 1, 'ainda vai tentar');

  await despachar({ enviar: cair });
  const tres = await despachar({ enviar: cair });
  assert.equal(tres.descartadas, 1);
  assert.equal(await pendentes(), 0, 'aviso velho não serve — o histórico do pedido guarda');

  const { rows } = await dono.query(
    "select motivo from notificacao where descartada_em is not null order by criada_em desc limit 1");
  assert.match(rows[0].motivo, /servidor fora/);
});

test('produtor sem assinatura: descarta com motivo, não acumula fila', async () => {
  await req('/push/assinaturas', { metodo: 'DELETE', token: tProdutor, corpo: assinatura(1) });
  await pedidoComAviso('PD-0005');

  const r = await despachar({ enviar: async () => { throw new Error('não devia ser chamado'); } });
  assert.equal(r.descartadas, 1);

  const { rows } = await dono.query(
    "select motivo from notificacao where descartada_em is not null order by criada_em desc limit 1");
  assert.match(rows[0].motivo, /sem assinatura/);
});

test('o agente fica guardado — é como se mede a fricção do iPhone', async () => {
  await req('/push/assinaturas', { metodo: 'POST', token: tProdutor, corpo: assinatura(9) });
  const minhas = await req('/push/assinaturas', { token: tProdutor });
  const iphone = minhas.corpo.find((a) => /iPhone/.test(a.agente ?? ''));
  assert.ok(iphone, 'sem isso, a ressalva do iOS vira suposição em vez de número');
});

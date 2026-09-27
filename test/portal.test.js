// O portal: a casca que o navegador baixa, e o que a sessão do produtor lê.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const TEL = '5566999660044';
let req, base, fechar, tRevenda, tProdutor, produtorId, propriedadeId;

const buscar = (caminho) => fetch(base + caminho);

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ({ req, base, fechar } = await subirApi());
  tRevenda = await entrar(req, 'gestora@3t.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 840 },
  });
  propriedadeId = f.corpo.id;
  await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba 1', areaHa: 420 },
  });

  await req('/auth/convites', { metodo: 'POST', token: tRevenda, corpo: { produtorId, telefone: TEL } });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: cod.corpo.codigo },
  });
  tProdutor = ent.corpo.token;
});

after(async () => { await fechar(); await encerrar(); });

/* -------------------------------------------------------------- a casca */

test('a casca do PWA é servida pela própria API — mesma origem', async () => {
  const r = await buscar('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<link rel="manifest" href="\/manifest.json">/);
  assert.match(html, /src="\/app.js"/);
});

test('o manifest aponta para ícones que existem de verdade', async () => {
  const m = await (await buscar('/manifest.json')).json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  for (const icone of m.icons) {
    const r = await buscar(icone.src);
    assert.equal(r.status, 200, `${icone.src} não existe`);
    assert.match(r.headers.get('content-type'), /image\/png/);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'sem maskable o ícone sai cortado');
});

test('o service worker é servido na raiz — é o que dá escopo a tudo', async () => {
  const r = await buscar('/sw.js');
  assert.equal(r.status, 200);
  const js = await r.text();
  assert.match(js, /addEventListener\('push'/, 'sem isso o aviso não aparece');
  assert.match(js, /notificationclick/, 'tocar no aviso tem que abrir o pedido');
});

/* ------------------------------------------------------ o que o portal lê */

test('o produtor lê a própria lavoura, com os talhões dentro', async () => {
  const r = await req('/cadastro/minha-lavoura', { token: tProdutor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.length, 1);
  assert.equal(r.corpo[0].nome, 'Fazenda Sabo');
  assert.equal(r.corpo[0].meu_papel, 'proprietario');
  assert.deepEqual(r.corpo[0].talhoes.map((t) => t.nome), ['Gleba 1']);
});

test('a lavoura não é porta dos fundos para o resto do cadastro', async () => {
  const r = await req('/cadastro/produtores', { token: tProdutor });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('a empresa não entra pela rota do portal', async () => {
  const r = await req('/cadastro/minha-lavoura', { token: tRevenda });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /portal do produtor/);
});

test('a jornada inteira do portal, numa sessão só', async () => {
  const eu = await req('/auth/eu', { token: tProdutor });
  assert.equal(eu.corpo.tipo, 'produtor');
  assert.equal(eu.corpo.vinculos.length, 1);

  const ped = await req('/pedidos', {
    metodo: 'POST', token: tRevenda,
    corpo: { numero: 'PD-0900', safra: '26/27', produtorId, propriedadeId,
      itens: [{ cultivar: 'FS695', quantidade: 1200 }] },
  });
  await req(`/pedidos/${ped.corpo.id}/avancar`, { metodo: 'POST', token: tRevenda, corpo: {} });

  const lista = await req('/pedidos', { token: tProdutor });
  assert.equal(lista.corpo.length, 1);

  const detalhe = await req(`/pedidos/${ped.corpo.id}`, { token: tProdutor });
  assert.equal(detalhe.corpo.etapa, 2);
  assert.ok(Array.isArray(detalhe.corpo.historico), 'a tela de detalhe desenha o histórico');

  const chave = await buscar('/push/chave-publica');
  assert.equal(chave.status, 200, 'o app pede a chave antes de assinar');

  const lavoura = await req('/cadastro/minha-lavoura', { token: tProdutor });
  assert.equal(lavoura.corpo.length, 1);
});

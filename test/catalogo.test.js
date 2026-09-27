// Catálogo: produto genérico desde o schema, preço por safra e canal,
// royalties e a bonificada — que é o que faz o preço médio mentir.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

let req, fechar, tGestor, tRival, produtorId, fs695, fs560;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  const rival = await criarTenant('Rival', '22222222000122');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  await criarUsuario(rival, 'Rival', 'rival@rv.com', 'gestor');
  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');
  tRival = await entrar(req, 'rival@rv.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
});

after(async () => { await fechar(); await encerrar(); });

/* ---------------------------------------------------------------- produto */

test('produto nasce com categoria genérica, mesmo sendo semente', async () => {
  const r = await req('/catalogo/produtos', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'FS695', cultura: 'milho', embalagem: '60.000 sementes' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.categoria, 'semente');
  assert.equal(r.corpo.unidade, 'sc');
  fs695 = r.corpo.id;

  const defensivo = await req('/catalogo/produtos', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Glifosato X', categoria: 'defensivo', unidade: 'L' },
  });
  assert.equal(defensivo.status, 201,
    'defensivo entra sem migração — é a razão de a categoria ser genérica');
});

test('nome repetido na mesma empresa é recusado', async () => {
  const r = await req('/catalogo/produtos', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'FS695' },
  });
  assert.equal(r.status, 400);
});

test('o catálogo é de quem vende — a rival não enxerga', async () => {
  const r = await req('/catalogo/produtos', { token: tRival });
  assert.deepEqual(r.corpo, []);

  const mesmoNome = await req('/catalogo/produtos', {
    metodo: 'POST', token: tRival, corpo: { nome: 'FS695' },
  });
  assert.equal(mesmoNome.status, 201, 'duas empresas podem vender o mesmo cultivar');
});

/* ------------------------------------------------------------------ preço */

test('preço por safra e canal, com royalties ao lado', async () => {
  const r = await req(`/catalogo/produtos/${fs695}/precos`, {
    metodo: 'POST', token: tGestor,
    corpo: { safra: '26/27', canal: 'direto', valor: 179, royaltiesSc: 12.5,
      vigenteDe: '2026-08-01' },
  });
  assert.equal(r.status, 201);

  await req(`/catalogo/produtos/${fs695}/precos`, {
    metodo: 'POST', token: tGestor,
    corpo: { safra: '26/27', canal: 'distribuidor', valor: 162, royaltiesSc: 12.5,
      vigenteDe: '2026-08-01' },
  });

  const lista = await req('/catalogo/produtos?safra=26/27', { token: tGestor });
  const p = lista.corpo.find((x) => x.id === fs695);
  const canais = Object.fromEntries(p.precos.map((x) => [x.canal, Number(x.valor)]));
  assert.equal(canais.direto, 179);
  assert.equal(canais.distribuidor, 162, 'venda ao canal tem preço próprio');
});

test('reajuste vira linha nova, e o vigente passa a ser o mais recente', async () => {
  await req(`/catalogo/produtos/${fs695}/precos`, {
    metodo: 'POST', token: tGestor,
    corpo: { safra: '26/27', canal: 'direto', valor: 189, royaltiesSc: 12.5,
      vigenteDe: '2026-09-01' },
  });
  const hist = await req(`/catalogo/produtos/${fs695}/precos`, { token: tGestor });
  const diretos = hist.corpo.filter((x) => x.canal === 'direto');
  assert.equal(diretos.length, 2, 'cada vigência é uma linha — o passado fica');

  const lista = await req('/catalogo/produtos?safra=26/27', { token: tGestor });
  const p = lista.corpo.find((x) => x.id === fs695);
  const direto = p.precos.find((x) => x.canal === 'direto');
  assert.equal(Number(direto.valor), 189, 'vale o mais recente que já entrou em vigor');
});

/* ----------------------------------------------- o carimbo no pedido */

test('o pedido carimba o preço e os royalties da hora da venda', async () => {
  const r = await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-2001', safra: '26/27', produtorId, canal: 'direto',
      itens: [{ produtoId: fs695, quantidade: 1000 }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  const item = r.corpo.itens[0];
  assert.equal(item.cultivar, 'FS695', 'o nome fica escrito no item');
  assert.equal(Number(item.precoUnit), 189);
  assert.equal(Number(item.royaltiesSc), 12.5);
});

test('mudar a tabela depois não reescreve pedido antigo', async () => {
  await req(`/catalogo/produtos/${fs695}/precos`, {
    metodo: 'POST', token: tGestor,
    corpo: { safra: '26/27', canal: 'direto', valor: 999, royaltiesSc: 99 },
  });
  const lista = await req('/pedidos', { token: tGestor });
  const antigo = lista.corpo.find((p) => p.numero === 'PD-2001');
  const det = await req(`/pedidos/${antigo.id}`, { token: tGestor });
  assert.equal(Number(det.corpo.itens[0].precoUnit), 189,
    'é a mesma razão do carimbo de território');
});

test('canal distribuidor pega o preço do canal', async () => {
  const r = await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-2002', safra: '26/27', produtorId, canal: 'distribuidor',
      itens: [{ produtoId: fs695, quantidade: 500 }] },
  });
  assert.equal(Number(r.corpo.itens[0].precoUnit), 162);
});

test('item digitado à mão continua valendo — o catálogo não é obrigatório', async () => {
  const r = await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-2003', safra: '26/27', produtorId,
      itens: [{ cultivar: 'Semente de vizinho', quantidade: 10, precoUnit: 50 }] },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.itens[0].produtoId ?? null, null);
});

test('produto arquivado não entra em pedido novo', async () => {
  const velho = await req('/catalogo/produtos', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'FS560' },
  });
  fs560 = velho.corpo.id;
  await req(`/catalogo/produtos/${fs560}/arquivar`, { metodo: 'PATCH', token: tGestor });

  const r = await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-2004', safra: '26/27', produtorId,
      itens: [{ produtoId: fs560, quantidade: 1 }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /arquivado/);
});

/* -------------------------------------------------------------- bonificada */

test('bonificada não cobra o saco, mas o royalty continua devido', async () => {
  const r = await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-2005', safra: '26/27', produtorId, canal: 'direto',
      itens: [{ produtoId: fs695, quantidade: 200, bonificada: true }] },
  });
  const item = r.corpo.itens[0];
  assert.equal(Number(item.precoUnit), 0, 'geração de demanda não é cobrada');
  assert.ok(Number(item.royaltiesSc) > 0,
    'o detentor da tecnologia recebe do mesmo jeito — é o que a torna cara');
  assert.equal(item.bonificada, true);
});

test('o resumo separa volume de receita — é o que impede o número de mentir', async () => {
  const r = await req('/catalogo/resumo?safra=26/27', { token: tGestor });
  const fs = r.corpo.find((x) => x.produto === 'FS695');

  assert.equal(fs.quantidade, 1700, '1000 + 500 + 200 bonificados');
  assert.equal(fs.bonificada, 200);
  assert.ok(fs.precoMedioEfetivo < fs.precoMedioCobrado,
    'a bonificada derruba o preço médio, e a diferença é o custo da GD');
  assert.ok(fs.royalties > 0);
});

test('o produtor não enxerga o catálogo da empresa', async () => {
  const r = await req('/catalogo/produtos', { token: tRival });
  assert.equal(r.status, 200);
  const semSessao = await req('/catalogo/produtos');
  assert.equal(semSessao.status, 401);
});

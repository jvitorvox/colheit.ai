// A área da empresa: a casca do console e tudo que ele precisa da API.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

let req, base, fechar, tGestor, tConsultor, produtorId;
const buscar = (caminho) => fetch(base + caminho);

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  await criarUsuario(revenda, 'Ercules', 'ercules@3t.com', 'consultor');
  ({ req, base, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');
  tConsultor = await entrar(req, 'ercules@3t.com');
});

after(async () => { await fechar(); await encerrar(); });

/* ------------------------------------------------------------------ casca */

test('o console é servido em /empresa, sem precisar da extensão', async () => {
  const r = await buscar('/empresa');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /empresa\.js/);
  assert.match(html, /base\.css/, 'usa os mesmos tokens do portal');
  assert.match(html, /noindex/, 'área interna não entra em busca');
});

test('portal e console dividem o mesmo arquivo de tokens', async () => {
  const css = await (await buscar('/base.css')).text();
  assert.match(css, /--marca:/);
  const portal = await (await buscar('/')).text();
  assert.match(portal, /base\.css/, 'se divergirem, as duas telas se afastam sozinhas');
});

test('o service worker deixa o console de fora', async () => {
  const js = await (await buscar('/sw.js')).text();
  assert.match(js, /FORA\(url\.pathname\)/);
  assert.match(js, /startsWith\('\/empresa'\)/);
});

/* -------------------------------------- o que cada tela do console chama */

test('painel: pedidos, etapas e a fila do campo, tudo com a sessão da empresa', async () => {
  for (const caminho of ['/pedidos', '/pedidos/etapas', '/captura/relatos?situacao=pendente']) {
    const r = await req(caminho, { token: tGestor });
    assert.equal(r.status, 200, `${caminho} devolveu ${r.status}`);
    assert.ok(Array.isArray(r.corpo));
  }
});

test('carteira: cria produtor sem documento e convida pelo telefone', async () => {
  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo', documentos: [] },
  });
  assert.equal(p.status, 201);
  produtorId = p.corpo.id;

  const convite = await req('/auth/convites', {
    metodo: 'POST', token: tGestor, corpo: { produtorId, telefone: '5566999880011' },
  });
  assert.equal(convite.status, 201, 'é o gancho que a H2 mede');
});

test('pedido: abre, avança e a etapa 4 cobra a nota — como a tela mostra', async () => {
  const novo = await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-1000', safra: '26/27', produtorId,
      itens: [{ cultivar: 'FS695', quantidade: 1200 }] },
  });
  assert.equal(novo.status, 201);
  const id = novo.corpo.id;

  await req(`/pedidos/${id}/avancar`, { metodo: 'POST', token: tGestor, corpo: {} });
  await req(`/pedidos/${id}/avancar`, { metodo: 'POST', token: tGestor, corpo: {} });

  const semNota = await req(`/pedidos/${id}/avancar`, { metodo: 'POST', token: tGestor, corpo: {} });
  assert.equal(semNota.status, 400, 'o console mostra o aviso vindo daqui');

  const nota = await req(`/pedidos/${id}/nota`, {
    metodo: 'POST', token: tGestor,
    corpo: { numero: '88412', valor: 214800, emitidaEm: '2026-09-20' },
  });
  assert.equal(nota.status, 201);

  const agora = await req(`/pedidos/${id}/avancar`, { metodo: 'POST', token: tGestor, corpo: {} });
  assert.equal(agora.corpo.etapa, 4);

  const detalhe = await req(`/pedidos/${id}`, { token: tGestor });
  assert.ok(detalhe.corpo.historico.length >= 4, 'a tela desenha o histórico com quem fez');
  assert.ok(detalhe.corpo.historico.some((h) => h.por === 'Gestora'));
});

test('crédito recusado aparece para o gestor', async () => {
  const lista = await req('/pedidos', { token: tGestor });
  const id = lista.corpo[0].id;
  const r = await req(`/pedidos/${id}/credito`, {
    metodo: 'PATCH', token: tGestor, corpo: { credito: 'recusado' },
  });
  assert.equal(r.corpo.credito, 'recusado');
});

/* ---------------------------------------------- os dois papéis do console */

test('o consultor vê só a carteira dele; o gestor vê a empresa', async () => {
  const doConsultor = await req('/cadastro/produtores', { token: tConsultor });
  assert.deepEqual(doConsultor.corpo, [], 'ele não cadastrou ninguém ainda');

  const doGestor = await req('/cadastro/produtores', { token: tGestor });
  assert.equal(doGestor.corpo.length, 1);
});

test('o consultor não define senha de ninguém', async () => {
  const r = await req('/auth/usuarios/00000000-0000-0000-0000-000000000000/senha', {
    metodo: 'POST', token: tConsultor, corpo: { senha: 'outra-senha-boa-123' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /só gestor/);
});

test('a sessão do portal não entra no console', async () => {
  await req('/auth/convites', {
    metodo: 'POST', token: tGestor,
    corpo: { produtorId, telefone: '5566999880011' },
  });
  const cod = await req('/auth/produtor/codigo', {
    metodo: 'POST', corpo: { telefone: '5566999880011' },
  });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: '5566999880011', codigo: cod.corpo.codigo },
  });

  const r = await req('/cadastro/produtores', { token: ent.corpo.token });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

// Armazenamento de mídia: quem consegue guardar, quem consegue baixar, e os
// dois armazéns rodando o mesmo caminho.
//
// O binário é o dado mais sensível que o projeto captura — áudio de produtor
// descrevendo a própria lavoura. Aqui se verifica que ele não sai por engano.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { armazem, armazemDeDisco, usarArmazem } from '../api/src/modulos/midia/armazem.js';
import { guardar } from '../api/src/modulos/midia/service.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const SEGREDO = process.env.GATEWAY_SEGREDO;
const CANAL = '5566999000123';
const TEL_PRODUTOR = '5566999881100';
const TEL_OUTRO = '5566999882200';

// Um ogg de mentira: o que importa é o tipo declarado e os bytes voltarem
// iguais. Transcodificar áudio de verdade não diria mais nada.
const AUDIO = Buffer.from('OggS\0\u0002ruído de trator e voz de gente'.repeat(8));
const OUTRO_AUDIO = Buffer.from('OggS\0\u0002outra conversa, outro dia'.repeat(8));

let base, req, fechar;
let tRevenda, tOutraRevenda, tProdutor, tOutroProdutor;
let revendaId;
let tempDir;

/** POST de corpo cru — o helper `req` só sabe JSON, e aqui é arquivo. */
const subir = (bytes, mime, { de = TEL_PRODUTOR, canal = CANAL, segredo = SEGREDO } = {}) =>
  fetch(`${base}/captura/midia`, {
    method: 'POST',
    headers: {
      'content-type': mime,
      'x-canal': canal,
      'x-de': de,
      ...(segredo ? { 'x-gateway-segredo': segredo } : {}),
    },
    body: bytes,
  }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }));

const baixar = (id, token) =>
  fetch(`${base}/midia/${id}`, { headers: { authorization: `Bearer ${token}` } });

/** Cria um produtor com acesso ao portal, e devolve o token dele. */
async function produtorComAcesso(token, nome, telefone) {
  const p = await req('/cadastro/produtores', { metodo: 'POST', token, corpo: { nome } });
  await req('/auth/convites', {
    metodo: 'POST', token, corpo: { produtorId: p.corpo.id, telefone },
  });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone, codigo: cod.corpo.codigo },
  });
  return { id: p.corpo.id, token: ent.corpo.token };
}

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('Agro Norte', '22222222000122', 'distribuidor');
  revendaId = revenda;
  await criarUsuario(revenda, 'Gestora', 'gestora@norte.com', 'gestor');
  const outra = await criarTenant('Agro Sul', '33333333000133', 'distribuidor');
  await criarUsuario(outra, 'Gestor', 'gestor@sul.com', 'gestor');

  ({ base, req, fechar } = await subirApi());
  tRevenda = await entrar(req, 'gestora@norte.com');
  tOutraRevenda = await entrar(req, 'gestor@sul.com');

  await req('/captura/canal', { metodo: 'POST', token: tRevenda, corpo: { numero: CANAL } });

  ({ token: tProdutor } = await produtorComAcesso(tRevenda, 'José Sabo', TEL_PRODUTOR));
  ({ token: tOutroProdutor } = await produtorComAcesso(tRevenda, 'Ana Trevisan', TEL_OUTRO));

  tempDir = await mkdtemp(join(tmpdir(), 'colheitai-midia-'));
});

after(async () => {
  usarArmazem(null);
  await rm(tempDir, { recursive: true, force: true });
  await fechar();
  await encerrar();
});

/* ------------------------------------------------------------ o gateway sobe */

test('sem o segredo, não se guarda arquivo nenhum', async () => {
  const r = await subir(AUDIO, 'audio/ogg', { segredo: null });
  assert.equal(r.status, 401);
});

test('canal desconhecido é recusado — não há tenant a quem atribuir', async () => {
  const r = await subir(AUDIO, 'audio/ogg', { canal: '5511000000000' });
  assert.equal(r.status, 404);
});

test('tipo que não aceitamos não entra', async () => {
  const r = await subir(Buffer.from('#!/bin/sh\nrm -rf /'), 'application/x-sh');
  assert.equal(r.status, 400);
});

test('arquivo vazio não entra', async () => {
  const r = await subir(Buffer.alloc(0), 'audio/ogg');
  assert.equal(r.status, 400);
});

let idDoAudio;

test('o áudio do produtor é guardado', async () => {
  const r = await subir(AUDIO, 'audio/ogg; codecs=opus');
  assert.equal(r.status, 201);
  assert.equal(r.corpo.repetido, false);
  idDoAudio = r.corpo.id;
});

test('o mesmo áudio de novo reaproveita a linha', async () => {
  // Reconexão do gateway reentrega o que já veio. Duas cópias do mesmo minuto
  // seriam só custo — e duas linhas seriam dois relatos do mesmo relato.
  const r = await subir(AUDIO, 'audio/ogg; codecs=opus');
  assert.equal(r.status, 201);
  assert.equal(r.corpo.repetido, true);
  assert.equal(r.corpo.id, idDoAudio);
});

/* ------------------------------------------------------------ quem alcança */

test('a empresa dona do canal baixa e recebe os bytes inteiros', async () => {
  const r = await baixar(idDoAudio, tRevenda);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/ogg');
  // Nunca cache compartilhado: seria o mesmo vazamento por outro caminho.
  assert.match(r.headers.get('cache-control'), /private/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), AUDIO);
});

test('o produtor alcança o que ele mesmo mandou', async () => {
  const r = await baixar(idDoAudio, tProdutor);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), AUDIO);
});

test('outro produtor não alcança o áudio alheio', async () => {
  const r = await baixar(idDoAudio, tOutroProdutor);
  assert.equal(r.status, 404);
});

test('outra revenda não alcança — nem sabe que existe', async () => {
  const r = await baixar(idDoAudio, tOutraRevenda);
  assert.equal(r.status, 404);
});

test('sem sessão não se baixa nada', async () => {
  const r = await fetch(`${base}/midia/${idDoAudio}`);
  assert.equal(r.status, 401);
});

test('a listagem da empresa mostra o que é dela', async () => {
  const r = await req('/midia', { token: tRevenda });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.some((m) => m.id === idDoAudio));

  const outra = await req('/midia', { token: tOutraRevenda });
  assert.equal(outra.corpo.length, 0);
});

/* ------------------------------------------------------- os dois armazéns */

test('o armazém de disco guarda e devolve igual ao de objetos', async () => {
  // O caminho de produção é o S3; o de disco existe para quem não sobe nada.
  // Rodar o mesmo guardar/baixar nos dois é o que impede que um deles
  // apodreça sem ninguém notar.
  const disco = armazemDeDisco(tempDir);
  usarArmazem(disco);
  try {
    const { id } = await guardar({
      tenantId: revendaId,
      produtorId: null, mime: 'image/jpeg', bytes: OUTRO_AUDIO,
    });
    const r = await baixar(id, tRevenda);
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), OUTRO_AUDIO);
  } finally {
    usarArmazem(null);
  }
});

test('o armazém de disco recusa chave que sai do lugar', async () => {
  const disco = armazemDeDisco(tempDir);
  await assert.rejects(
    () => disco.guardar('../fora/do/lugar', Buffer.from('x')),
    /chave inválida/);
});

test('o armazém de objetos está de pé e é o padrão do ambiente', async () => {
  usarArmazem(null);
  const a = await armazem();
  assert.equal(a.nome, process.env.ARMAZEM === 's3' ? 's3' : 'disco');
});

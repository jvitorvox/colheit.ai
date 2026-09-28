// O que o aplicativo de campo exige do servidor.
//
// O app trabalha sem sinal e guarda a visita numa fila local que ele reenvia.
// Reenvio é o normal desse desenho, não a exceção — o rádio cai no meio do
// POST e o app não tem como saber se gravou. Se cada tentativa virasse uma
// visita, a mediana da H1 passaria a contar três registros de dez segundos: o
// número que decide o produto, envenenado pela peça que existe para alimentá-lo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

let req, base, fechar, tConsultor, tOutraRevenda, tProdutor, produtorId;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('Agro Norte', '99999999000199', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@norte.com', 'gestor');
  const consultorId = await criarUsuario(revenda, 'Ana', 'ana@norte.com', 'consultor');
  const outra = await criarTenant('Agro Sul', '10101010000110', 'distribuidor');
  await criarUsuario(outra, 'Gestor Sul', 'gestor@sul.com', 'gestor');

  ({ req, base, fechar } = await subirApi());
  const tGestor = await entrar(req, 'gestora@norte.com');
  tConsultor = await entrar(req, 'ana@norte.com');
  tOutraRevenda = await entrar(req, 'gestor@sul.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  await req('/cadastro/propriedades', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 1200 },
  });
  await dono.query(
    `insert into consultor_carteira (vinculo_id, usuario_id)
     select v.id, $2 from produtor_vinculo v where v.produtor_id = $1`,
    [produtorId, consultorId]);
});

after(async () => { await fechar(); await encerrar(); });

/** O corpo que o app monta: o clienteId nasce no celular, antes de tentar. */
const visitaDoApp = (clienteId, extra = {}) => ({
  produtorId, canal: 'app', clienteId,
  em: new Date().toISOString(), duracaoSeg: 41,
  estagio: 'V6', estande: 58, observacao: 'Estande bom, lagarta na bordadura.',
  ...extra,
});

const registrar = (corpo, token = tConsultor) =>
  req('/visitas', { metodo: 'POST', token, corpo });

/* ------------------------------------------------------ a fila é a carteira */

test('a fila do dia do consultor é a carteira dele, sem ele pedir', async () => {
  const r = await req('/visitas/fila', { token: tConsultor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.length, 1);
  assert.equal(r.corpo[0].produtor, 'José Cesar Sabo');
  assert.equal(r.corpo[0].nunca, true, 'nunca visitado vem primeiro');
  assert.equal(r.corpo[0].atrasado, true);
});

/* --------------------------------------------------------- o reenvio é seguro */

test('a visita entra com o que o app mediu', async () => {
  const r = await registrar(visitaDoApp(randomUUID()));
  assert.equal(r.status, 201);
  assert.equal(r.corpo.repetida, false);
  assert.equal(r.corpo.duracao_seg, 41);
  assert.equal(r.corpo.canal, 'app');
  assert.equal(r.corpo.estagio, 'V6');
  assert.equal(r.corpo.consultor, 'Ana', 'a visita é de quem registrou');
});

test('reenviar a MESMA visita devolve a que já existe, sem criar outra', async () => {
  const chave = randomUUID();
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;

  const um = await registrar(visitaDoApp(chave));
  const dois = await registrar(visitaDoApp(chave));
  const tres = await registrar(visitaDoApp(chave, { duracaoSeg: 9, estagio: 'R1' }));

  assert.equal(um.corpo.repetida, false);
  assert.equal(dois.corpo.repetida, true);
  assert.equal(tres.corpo.repetida, true);
  assert.equal(dois.corpo.id, um.corpo.id);
  assert.equal(tres.corpo.id, um.corpo.id);

  // O reenvio não reescreve: vale o que foi medido na primeira gravação.
  assert.equal(tres.corpo.duracao_seg, 41);
  assert.equal(tres.corpo.estagio, 'V6');

  const depois = (await req('/visitas', { token: tConsultor })).corpo.length;
  assert.equal(depois, antes + 1, 'três tentativas, uma visita');
});

test('dois reenvios ao mesmo tempo também dão uma visita só', async () => {
  // A corrida que o desenho prevê: o app volta ao sinal e o consultor toca em
  // "tentar agora" no mesmo instante.
  const chave = randomUUID();
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;

  const respostas = await Promise.all(
    Array.from({ length: 4 }, () => registrar(visitaDoApp(chave))));

  assert.ok(respostas.every((r) => r.status === 201), JSON.stringify(respostas.map((r) => r.corpo)));
  const ids = new Set(respostas.map((r) => r.corpo.id));
  assert.equal(ids.size, 1, 'todas devolvem a mesma visita');
  assert.equal(respostas.filter((r) => r.corpo.repetida === false).length, 1,
    'exatamente uma gravou');

  const depois = (await req('/visitas', { token: tConsultor })).corpo.length;
  assert.equal(depois, antes + 1);
});

test('visitas diferentes no mesmo produtor continuam sendo duas', async () => {
  // O freio é o reenvio, não o produtor: passar duas vezes no mesmo dia é
  // trabalho de verdade, e travar isso seria pior do que o problema.
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;
  await registrar(visitaDoApp(randomUUID()));
  await registrar(visitaDoApp(randomUUID()));
  const depois = (await req('/visitas', { token: tConsultor })).corpo.length;
  assert.equal(depois, antes + 2);
});

test('sem clienteId nada muda — é o caminho do console e do WhatsApp', async () => {
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;
  const um = await registrar({ produtorId, canal: 'app', duracaoSeg: 30 });
  const dois = await registrar({ produtorId, canal: 'app', duracaoSeg: 30 });
  assert.equal(um.status, 201);
  assert.equal(dois.status, 201);
  assert.notEqual(um.corpo.id, dois.corpo.id);
  assert.equal((await req('/visitas', { token: tConsultor })).corpo.length, antes + 2);
});

test('clienteId que não é uuid é recusado, e o app vê o motivo', async () => {
  const r = await registrar(visitaDoApp('não-é-uuid'));
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'clienteId');
});

/* ------------------------------------------------------------ o isolamento */

test('a chave do app é por empresa — colisão não revela nada de outra', async () => {
  // Chave que o cliente gera não pode servir de sonda: a mesma chave em outra
  // revenda grava normalmente, em vez de devolver a visita alheia.
  const chave = randomUUID();
  const minha = await registrar(visitaDoApp(chave));
  assert.equal(minha.corpo.repetida, false);

  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tOutraRevenda, corpo: { nome: 'Wilson Kuhn' },
  });
  const dela = await req('/visitas', {
    metodo: 'POST', token: tOutraRevenda,
    corpo: { produtorId: outro.corpo.id, canal: 'app', clienteId: chave, duracaoSeg: 20 },
  });
  assert.equal(dela.status, 201);
  assert.equal(dela.corpo.repetida, false, 'gravou, não reaproveitou');
  assert.notEqual(dela.corpo.id, minha.corpo.id);
});

test('o produtor não registra visita — quem registra é quem foi ao campo', async () => {
  await req('/auth/convites', {
    metodo: 'POST', token: tConsultor, corpo: { produtorId, telefone: '5566999550011' },
  });
  const cod = await req('/auth/produtor/codigo', {
    metodo: 'POST', corpo: { telefone: '5566999550011' },
  });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: '5566999550011', codigo: cod.corpo.codigo },
  });
  tProdutor = ent.corpo.token;
  const r = await registrar(visitaDoApp(randomUUID()), tProdutor);
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

/* -------------------------------------------------------------- a medição */

test('a duração medida no celular chega à H1 pelo canal app', async () => {
  const h1 = await req('/visitas/h1', { token: tConsultor });
  const app = h1.corpo.porCanal.find((c) => c.canal === 'app');
  assert.ok(app, 'o canal do aplicativo é medido');
  assert.ok(app.mediana_seg > 0);
  assert.equal(h1.corpo.confirmaAbaixoDe, 60);
  assert.equal(h1.corpo.mataAcimaDe, 90);
});

/* ------------------------------------------------------- a foto do talhão */

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

/** Sobe uma foto como o app sobe: corpo cru, com a sessão. */
const subirFoto = (bytes, token = tConsultor, mime = 'image/jpeg') =>
  fetch(`${base}/midia`, {
    method: 'POST',
    headers: { 'content-type': mime, authorization: `Bearer ${token}` },
    body: bytes,
  }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }));

test('o app sobe a foto com a sessão, sem passar pelo gateway', async () => {
  const r = await subirFoto(JPEG);
  assert.equal(r.status, 201);
  assert.ok(r.corpo.id);
});

test('a foto sobe sem dono, e quem carimba é o vínculo com a visita', async () => {
  const foto = await subirFoto(Buffer.concat([JPEG, Buffer.from('bordadura')]));
  const { rows: [antes] } = await dono.query(
    'select produtor_id from midia where id = $1', [foto.corpo.id]);
  assert.equal(antes.produtor_id, null,
    'aceitar produtorId na subida deixaria pendurar foto na lavoura alheia');

  const v = await registrar(visitaDoApp(randomUUID(), { midiaIds: [foto.corpo.id] }));
  assert.equal(v.status, 201);
  assert.equal(v.corpo.fotos.length, 1);

  const { rows: [depois] } = await dono.query(
    'select produtor_id from midia where id = $1', [foto.corpo.id]);
  assert.equal(depois.produtor_id, produtorId, 'a lavoura é do produtor, e a foto dela também');
});

test('o produtor enxerga a foto da visita à lavoura dele', async () => {
  const foto = await subirFoto(Buffer.concat([JPEG, Buffer.from('gleba 4')]));
  await registrar(visitaDoApp(randomUUID(), { midiaIds: [foto.corpo.id] }));

  const r = await fetch(`${base}/midia/${foto.corpo.id}`, {
    headers: { authorization: `Bearer ${tProdutor}` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
});

test('outra revenda não alcança a foto — nem sabe que existe', async () => {
  const foto = await subirFoto(Buffer.concat([JPEG, Buffer.from('so nossa')]));
  await registrar(visitaDoApp(randomUUID(), { midiaIds: [foto.corpo.id] }));
  const r = await fetch(`${base}/midia/${foto.corpo.id}`, {
    headers: { authorization: `Bearer ${tOutraRevenda}` },
  });
  assert.equal(r.status, 404);
});

test('reenviar a visita com as mesmas fotos não duplica o vínculo', async () => {
  const chave = randomUUID();
  const a = await subirFoto(Buffer.concat([JPEG, Buffer.from('foto a')]));
  const b = await subirFoto(Buffer.concat([JPEG, Buffer.from('foto b')]));
  const ids = [a.corpo.id, b.corpo.id];

  const um = await registrar(visitaDoApp(chave, { midiaIds: ids }));
  const dois = await registrar(visitaDoApp(chave, { midiaIds: ids }));

  assert.equal(um.corpo.repetida, false);
  assert.equal(dois.corpo.repetida, true);
  assert.equal(dois.corpo.fotos.length, 2);
  const { rows } = await dono.query(
    'select count(*)::int as n from visita_midia where visita_id = $1', [um.corpo.id]);
  assert.equal(rows[0].n, 2, 'duas fotos, dois vínculos — não quatro');
});

test('o sinal caiu entre gravar a visita e pendurar a foto: o reenvio completa', async () => {
  // Foi exatamente isso que o aplicativo faz quando perde o rádio no meio.
  const chave = randomUUID();
  const semFoto = await registrar(visitaDoApp(chave));
  assert.equal(semFoto.corpo.fotos.length, 0);

  const foto = await subirFoto(Buffer.concat([JPEG, Buffer.from('chegou depois')]));
  const comFoto = await registrar(visitaDoApp(chave, { midiaIds: [foto.corpo.id] }));

  assert.equal(comFoto.corpo.repetida, true);
  assert.equal(comFoto.corpo.id, semFoto.corpo.id, 'é a mesma visita');
  assert.equal(comFoto.corpo.fotos.length, 1, 'e agora ela tem a foto');
});

test('a mesma foto subida duas vezes reaproveita a linha', async () => {
  const bytes = Buffer.concat([JPEG, Buffer.from('reenvio do binario')]);
  const um = await subirFoto(bytes);
  const dois = await subirFoto(bytes);
  assert.equal(dois.corpo.id, um.corpo.id);
  assert.equal(dois.corpo.repetido, true);
});

test('arquivo que não é imagem nem áudio não entra por esta porta', async () => {
  const r = await subirFoto(Buffer.from('#!/bin/sh'), tConsultor, 'application/x-sh');
  assert.equal(r.status, 400);
});

test('o portal do produtor não sobe foto — quem registra é quem foi ao campo', async () => {
  const r = await subirFoto(JPEG, tProdutor);
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('mais fotos do que cabem numa visita é recusado', async () => {
  const r = await registrar(visitaDoApp(randomUUID(), {
    midiaIds: Array.from({ length: 7 }, () => randomUUID()),
  }));
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'midiaIds');
});

test('a listagem já traz os ids das fotos, sem uma ida por visita', async () => {
  const lista = await req('/visitas', { token: tConsultor });
  assert.equal(lista.status, 200);
  assert.ok(lista.corpo.every((v) => Array.isArray(v.fotos)));
  assert.ok(lista.corpo.some((v) => v.fotos.length > 0));
});

/* -------------------------------------------------- o resultado da safra */

let plantioAberto;

test('o consultor fecha a colheita do campo — e só a da carteira dele', async () => {
  const gestor = await entrar(req, 'gestora@norte.com');
  const prop = (await req('/cadastro/produtores', { token: tConsultor })).corpo[0];
  assert.ok(prop);

  const f = (await req('/cadastro/propriedades', { token: gestor })).corpo
    .find((x) => x.produtor_id === produtorId) ?? null;
  const propriedadeId = f?.id
    ?? (await req('/cadastro/propriedades', {
      metodo: 'POST', token: gestor,
      corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 1200 },
    })).corpo.id;

  const t = await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: gestor, corpo: { nome: 'Gleba 1', areaHa: 600 },
  });
  const pl = await req('/caderno/plantios', {
    metodo: 'POST', token: gestor,
    corpo: {
      talhaoId: t.corpo.id, safra: '26/27', cultivar: 'FS560',
      marca: 'FS Sementes', areaHa: 600,
    },
  });
  assert.equal(pl.status, 201, JSON.stringify(pl.corpo));
  plantioAberto = pl.corpo.id;

  // É o consultor quem está no campo quando a colhedora passa.
  const r = await req(`/caderno/plantios/${plantioAberto}/colheita`, {
    metodo: 'POST', token: tConsultor,
    corpo: { produtividadeScHa: 64.8, umidade: 13.2 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
});

test('reenviar a colheita grava o mesmo número — uma por plantio', async () => {
  // É o que torna o reenvio da fila seguro sem chave de cliente: `colheita`
  // tem `plantio_id unique`, e o insert é upsert.
  const de_novo = await req(`/caderno/plantios/${plantioAberto}/colheita`, {
    metodo: 'POST', token: tConsultor,
    corpo: { produtividadeScHa: 64.8, umidade: 13.2 },
  });
  assert.equal(de_novo.status, 201);

  const { rows } = await dono.query(
    'select count(*)::int as n from colheita where plantio_id = $1', [plantioAberto]);
  assert.equal(rows[0].n, 1, 'duas tentativas, uma colheita');
});

test('o resultado por produtor é o que ele leva para a porteira', async () => {
  const r = await req(`/caderno/resultado?produtorId=${produtorId}`, { token: tConsultor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.mediaPonderadaScHa, 64.8);
  assert.equal(r.corpo.porTalhao[0].talhao, 'Gleba 1');
  assert.ok(r.corpo.porTalhao[0].plantioId,
    'o app precisa do plantio para saber onde registrar a colheita que falta');
});

test('o filtro por produtor não é porta dos fundos para a terra de outro', async () => {
  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tOutraRevenda, corpo: { nome: 'Fora da carteira' },
  });
  const r = await req(`/caderno/resultado?produtorId=${outro.corpo.id}`, { token: tConsultor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.talhoes, 0, 'a política filtra antes do parâmetro');
});

test('produtorId que não é uuid é recusado', async () => {
  const r = await req('/caderno/resultado?produtorId=qualquer-coisa', { token: tConsultor });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'produtorId');
});

test('a leitura comercial da safra não abre para o app do consultor por engano', async () => {
  // Ele é empresa, então LÊ — o que não pode é o endpoint se confundir com o
  // que o portal do produtor consome.
  const r = await req('/caderno/resultado-por-origem?safra=26/27', { token: tConsultor });
  assert.equal(r.status, 200);
  const doPortal = await req('/caderno/resultado?safra=26/27', { token: tConsultor });
  assert.equal(doPortal.corpo.porOrigem, undefined);
});

/* --------------------------------------- o benchmark que ele leva à porteira */

test('o consultor lê a região do produtor que vai visitar', async () => {
  const gestor = await entrar(req, 'gestora@norte.com');
  const prop = (await req('/cadastro/propriedades', { token: gestor })).corpo
    .find((x) => x.operadores?.some((o) => o.produtorId === produtorId))
    ?? (await req('/cadastro/propriedades', { token: gestor })).corpo[0];

  // Cinco vizinhos no mesmo município, para o piso fechar.
  for (let i = 1; i <= 5; i++) {
    const p = await req('/cadastro/produtores', {
      metodo: 'POST', token: gestor, corpo: { nome: `Vizinho ${i}` },
    });
    const f = await req('/cadastro/propriedades', {
      metodo: 'POST', token: gestor,
      corpo: {
        nome: `Fazenda Vizinho ${i}`, produtorId: p.corpo.id,
        municipio: prop.municipio, uf: prop.uf, areaHa: 400,
      },
    });
    const t = await req(`/cadastro/propriedades/${f.corpo.id}/talhoes`, {
      metodo: 'POST', token: gestor, corpo: { nome: 'Gleba única', areaHa: 400 },
    });
    const pl = await req('/caderno/plantios', {
      metodo: 'POST', token: gestor,
      corpo: {
        talhaoId: t.corpo.id, safra: '26/27', cultivar: 'FS560',
        marca: 'FS Sementes', areaHa: 400,
      },
    });
    await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
      metodo: 'POST', token: gestor,
      corpo: { colhidoEm: '2027-03-08', produtividadeScHa: 55 + i },
    });
  }

  const r = await req(`/caderno/benchmark?produtorId=${produtorId}`, { token: tConsultor });
  assert.equal(r.status, 200);
  assert.ok(r.corpo, 'ele leva o número da vizinhança para a conversa');
  assert.equal(r.corpo.produtores, 5);
  assert.match(r.corpo.base, /sem nome e sem número individual/);
});

test('a carteira do consultor não é alavanca — a exclusão é do produtor, não dele', async () => {
  // No benchmark do gestor a região INCLUI a carteira, porque ele a controla.
  // Aqui a exclusão é só o produtor consultado, que ele não escolhe: mudar a
  // carteira não move o número de ninguém.
  const antes = (await req(`/caderno/benchmark?produtorId=${produtorId}`,
    { token: tConsultor })).corpo.mediaPonderadaScHa;

  const gestor = await entrar(req, 'gestora@norte.com');
  const novo = await req('/cadastro/produtores', {
    metodo: 'POST', token: gestor, corpo: { nome: 'Entrou na carteira' },
  });
  assert.equal(novo.status, 201);

  const depois = (await req(`/caderno/benchmark?produtorId=${produtorId}`,
    { token: tConsultor })).corpo.mediaPonderadaScHa;
  assert.equal(depois, antes, 'mexer na carteira não move a régua do produtor');
});

test('produtor fora do alcance dele não tem benchmark', async () => {
  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tOutraRevenda, corpo: { nome: 'De outra revenda' },
  });
  const r = await req(`/caderno/benchmark?produtorId=${outro.corpo.id}`, { token: tConsultor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo, null, 'a política filtra antes do parâmetro');
});

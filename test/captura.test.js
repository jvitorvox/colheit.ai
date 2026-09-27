// Captura pelo WhatsApp: o que chega do campo, e a regra de nunca disparar.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { usarExtrator } from '../api/src/modulos/captura/extrator.js';
import { extrairPendentes } from '../api/src/modulos/captura/service.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const NUMERO = '5566999000001';   // o canal da revenda
const TEL = '5566999770022';      // o produtor
const SEGREDO = process.env.GATEWAY_SEGREDO;

let req, fechar, tRevenda, tProdutor, produtorId, propriedadeId;

const doGateway = (caminho, corpo, metodo = 'POST') =>
  req(caminho, { metodo, corpo, cabecalhos: { 'x-gateway-segredo': SEGREDO } });

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  usarExtrator(null);

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ({ req, fechar } = await subirApi());
  tRevenda = await entrar(req, 'gestora@3t.com');

  await req('/captura/canal', { metodo: 'POST', token: tRevenda, corpo: { numero: NUMERO } });

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

after(async () => { usarExtrator(null); await fechar(); await encerrar(); });

/* ---------------------------------------------------------------- gateway */

test('sem o segredo, o gateway não entra', async () => {
  const r = await req('/captura/mensagens', {
    metodo: 'POST', corpo: { de: TEL, para: NUMERO, tipo: 'texto', texto: 'oi' },
  });
  assert.equal(r.status, 401);
});

test('número de canal desconhecido é recusado', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: '5511000000000', tipo: 'texto', texto: 'oi',
  });
  assert.equal(r.status, 404);
});

test('telefone que ninguém conhece recebe convite, não vira relato', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: '5511911112222', para: NUMERO, tipo: 'texto', texto: 'bom dia',
  });
  assert.equal(r.corpo.desfecho, 'nao_identificado');

  const saidas = await doGateway('/captura/saidas', null, 'GET');
  const resposta = saidas.corpo.find((s) => s.para === '5511911112222');
  assert.match(resposta.texto, /convite de acesso/);
});

/* --------------------------------------------------- captura sem extrator */

test('áudio chega e fica guardado, mesmo com a IA desligada', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/aud-1.ogg',
  });
  assert.equal(r.corpo.desfecho, 'relato_aguardando_extracao');
  assert.equal(r.corpo.extratorLigado, false);

  const fila = await req('/captura/relatos', { token: tRevenda });
  const guardado = fila.corpo.find((x) => x.id === r.corpo.relatoId);
  assert.equal(guardado.situacao, 'aguardando_extracao');
  assert.equal(guardado.transcricao, null, 'chegou e está seguro — ninguém leu ainda');
});

test('o produtor recebe confirmação de que chegou', async () => {
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  const pro = saidas.corpo.filter((s) => s.para === TEL);
  assert.ok(pro.some((s) => /guardei/.test(s.texto)));
});

/* ------------------------------------------------------- nunca dispara */

test('o banco recusa saída que não responde a nada', async () => {
  await assert.rejects(
    dono.query(`insert into mensagem_whatsapp (tenant_id, telefone, direcao, tipo, texto)
                select tenant_id, $1, 'saida', 'texto', 'promoção!' from canal_whatsapp limit 1`, [TEL]),
    /violates check constraint/,
    'nunca disparar deixou de depender de quem escreve o gateway',
  );
});

test('toda saída existente aponta para uma entrada', async () => {
  const { rows } = await dono.query(
    "select count(*)::int as n from mensagem_whatsapp where direcao = 'saida' and responde_a is null");
  assert.equal(rows[0].n, 0);
});

/* ------------------------------------------------- pergunta tem resposta */

test('"cadê meu pedido?" responde na hora, com a etapa', async () => {
  const ped = await req('/pedidos', {
    metodo: 'POST', token: tRevenda,
    corpo: { numero: 'PD-0412', safra: '26/27', produtorId, propriedadeId,
      itens: [{ cultivar: 'FS695', quantidade: 1200 }] },
  });
  await req(`/pedidos/${ped.corpo.id}/avancar`, { metodo: 'POST', token: tRevenda, corpo: {} });

  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'cadê meu pedido?',
  });
  assert.equal(r.corpo.desfecho, 'respondido');

  const saidas = await doGateway('/captura/saidas', null, 'GET');
  const ultima = saidas.corpo.filter((s) => s.para === TEL).at(-1);
  assert.match(ultima.texto, /PD-0412/);
  assert.match(ultima.texto, /pedido/i, 'diz em que etapa está');
});

test('o gateway marca o que já enviou', async () => {
  const antes = await doGateway('/captura/saidas', null, 'GET');
  assert.ok(antes.corpo.length > 0);
  for (const s of antes.corpo) await doGateway(`/captura/saidas/${s.id}/enviada`, {});
  const depois = await doGateway('/captura/saidas', null, 'GET');
  assert.deepEqual(depois.corpo, []);
});

/* ------------------------------------------------------ validação humana */

test('o consultor valida, e é ele quem fecha', async () => {
  const fila = await req('/captura/relatos', { token: tRevenda, });
  const alvo = fila.corpo.find((r) => r.situacao === 'aguardando_extracao');

  const r = await req(`/captura/relatos/${alvo.id}/validar`, {
    metodo: 'POST', token: tRevenda, corpo: {},
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.situacao, 'validado');
  assert.ok(r.corpo.validado_em);
});

test('não se valida duas vezes', async () => {
  const fila = await req('/captura/relatos', { token: tRevenda });
  const jaValidado = fila.corpo.find((r) => r.situacao === 'validado');
  const r = await req(`/captura/relatos/${jaValidado.id}/validar`, {
    metodo: 'POST', token: tRevenda, corpo: {},
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /já validado/);
});

test('descartar exige motivo', async () => {
  const nova = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'imagem', midiaRef: 'midia/foto-1.jpg',
  });
  const semMotivo = await req(`/captura/relatos/${nova.corpo.relatoId}/descartar`, {
    metodo: 'POST', token: tRevenda, corpo: {},
  });
  assert.equal(semMotivo.status, 400);

  const ok = await req(`/captura/relatos/${nova.corpo.relatoId}/descartar`, {
    metodo: 'POST', token: tRevenda, corpo: { observacao: 'foto do caminhão, não da lavoura' },
  });
  assert.equal(ok.corpo.situacao, 'descartado');
});

test('o produtor vê o que mandou, e não valida', async () => {
  const meus = await req('/captura/relatos', { token: tProdutor });
  assert.ok(meus.corpo.length > 0);

  const fila = await req('/captura/relatos', { token: tRevenda });
  const algum = fila.corpo[0];
  const r = await req(`/captura/relatos/${algum.id}/validar`, {
    metodo: 'POST', token: tProdutor, corpo: {},
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

/* ------------------------------------------ a fila represada é reversível */

test('ligar o extrator depois recupera tudo que ficou guardado', async () => {
  const antes = await extrairPendentes();
  assert.equal(antes.extrator, 'desligado');

  usarExtrator(async (m) => ({
    transcricao: m.tipo === 'audio'
      ? 'Passei na Gleba 4, tem lagarta na bordadura.'
      : 'Foto da etiqueta do saco.',
    extraido: { talhao: 'Gleba 4', achado: 'lagarta na bordadura' },
    tipo: 'lavoura',
  }));

  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/aud-2.ogg',
  });

  const r = await extrairPendentes();
  assert.equal(r.extrator, 'ligado');

  const fila = await req('/captura/relatos', { token: tRevenda, });
  const lido = fila.corpo.find((x) => /lagarta/.test(x.transcricao ?? ''));
  assert.ok(lido, 'nada do que chegou antes se perde');
  assert.equal(lido.situacao, 'pendente');
  assert.equal(lido.extraido.achado, 'lagarta na bordadura');
});

test('com o extrator ligado, a mensagem já nasce pendente de validação', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/aud-3.ogg',
  });
  assert.equal(r.corpo.desfecho, 'relato_pendente');
  assert.equal(r.corpo.extratorLigado, true);
});

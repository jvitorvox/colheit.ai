// O extrator de IA, exercitado inteiro com um provedor de mentira.
//
// Nenhuma chamada sai daqui: `chamar` e `lerMidia` são injetados. O que se
// verifica é o que o provedor RECEBE (e o que ele não recebe), e o que o módulo
// faz com o que ele devolve — inclusive quando ele devolve lixo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { criarExtratorGemini } from '../api/src/modulos/captura/gemini.js';
import { ligarSeAutorizado, usarExtrator, extratorLigado, extrair } from '../api/src/modulos/captura/extrator.js';
import { lerComoDono, guardar } from '../api/src/modulos/midia/service.js';
import { criarTenant, limparBase } from './ajuda.js';

const mudo = { info() {}, warn() {}, error() {} };

/** Um provedor de mentira que guarda o que recebeu e devolve o que mandarem. */
function provedor(respostas) {
  const pedidos = [];
  const fila = [...respostas];
  const chamar = async (url, opc) => {
    pedidos.push({ url, cabecalhos: opc.headers, corpo: JSON.parse(opc.body) });
    const r = fila.shift() ?? { status: 500 };
    if (r.erro) throw r.erro;
    return {
      ok: r.status === undefined || r.status === 200,
      status: r.status ?? 200,
      json: async () => r.json,
    };
  };
  return { chamar, pedidos };
}

/** Molda a resposta do provedor como ele a devolve de verdade. */
const respondendo = (obj) => ({
  json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] },
});

const extratorDe = (prov, opc = {}) => criarExtratorGemini({
  chave: 'chave-de-mentira', chamar: prov.chamar, lerMidia: async () => null,
  registro: mudo, ...opc,
});

before(async () => { await migrar({ silencioso: true }); await limparBase(); });
after(async () => { usarExtrator(null); await encerrar(); });

/* ------------------------------------------------------------- a trava */

test('sem chave, não liga', () => {
  delete process.env.IA_CHAVE;
  delete process.env.IA_PLANO;
  const r = ligarSeAutorizado({ registro: mudo });
  assert.equal(r.ligado, false);
  assert.match(r.motivo, /IA_CHAVE/);
  assert.equal(extratorLigado(), false);
});

test('com chave e SEM a declaração do plano, continua desligado', () => {
  // É o caso que mais importa: alguém coloca a chave, esquece o contrato, e o
  // áudio do produtor começaria a subir para treinar modelo de terceiro.
  process.env.IA_CHAVE = 'chave-de-mentira';
  process.env.IA_PLANO = '';
  const avisos = [];
  const r = ligarSeAutorizado({ registro: { ...mudo, warn: (m) => avisos.push(m) } });
  assert.equal(r.ligado, false);
  assert.match(r.motivo, /IA_PLANO/);
  assert.equal(extratorLigado(), false, 'a fila continua guardada');
  assert.match(avisos[0], /sem-treino/, 'o motivo não passa em silêncio');
});

test('plano escrito errado não vale — não há quase-declarado', () => {
  process.env.IA_PLANO = 'sem treino';
  assert.equal(ligarSeAutorizado({ registro: mudo }).ligado, false);
  process.env.IA_PLANO = 'sim';
  assert.equal(ligarSeAutorizado({ registro: mudo }).ligado, false);
});

test('com as duas, liga', () => {
  process.env.IA_PLANO = 'sem-treino';
  const r = ligarSeAutorizado({ registro: mudo });
  assert.equal(r.ligado, true);
  assert.equal(extratorLigado(), true);
  usarExtrator(null);
  delete process.env.IA_CHAVE;
  delete process.env.IA_PLANO;
});

/* --------------------------------------------------- o que o provedor vê */

test('o áudio sobe, e o nome e o telefone do produtor NÃO', async () => {
  const prov = provedor([respondendo({
    tipo: 'lavoura', transcricao: 'Plantei a Gleba 1 com FS560 da FS Sementes.',
    cultivar: 'FS560', marca: 'FS Sementes', areaHa: 500, confianca: 0.9,
  })]);
  const extrator = extratorDe(prov, {
    lerMidia: async () => ({ mime: 'audio/ogg', bytes: Buffer.from('voz no meio da lavoura') }),
  });

  await extrator({ tipo: 'audio', midiaId: 'qualquer-id' });

  const enviado = JSON.stringify(prov.pedidos[0].corpo);
  assert.match(enviado, /inlineData/, 'o áudio vai');
  for (const vazamento of ['José', 'Sabo', '5566', 'tenant', 'Fazenda']) {
    assert.doesNotMatch(enviado, new RegExp(vazamento),
      `${vazamento} não tem por que subir para transcrever uma voz`);
  }
  assert.equal(prov.pedidos[0].cabecalhos['x-goog-api-key'], 'chave-de-mentira');
});

test('a extração é esquematizada pelo provedor, não lida de prosa', async () => {
  const prov = provedor([respondendo({ tipo: 'lote', transcricao: 'lote 24-0904', confianca: 0.7 })]);
  await extratorDe(prov, { lerMidia: async () => ({ mime: 'image/jpeg', bytes: Buffer.from('foto') }) })
    ({ tipo: 'imagem', midiaId: 'x' });

  const cfg = prov.pedidos[0].corpo.generationConfig;
  assert.equal(cfg.responseMimeType, 'application/json');
  assert.equal(cfg.temperature, 0, 'mesmo áudio, mesmo campo — senão não dá para conferir');
  // Os nomes do esquema são o contrato com caderno e visitas.
  for (const campo of ['cultivar', 'marca', 'lote', 'safra', 'ciclo', 'areaHa',
    'populacao', 'estagio', 'estande']) {
    assert.ok(cfg.responseSchema.properties[campo], `${campo} faz parte do laço`);
  }
});

test('o relato escrito não carrega mídia nenhuma', async () => {
  const prov = provedor([respondendo({ tipo: 'lavoura', transcricao: 'lagarta na bordadura', confianca: 0.8 })]);
  const r = await extratorDe(prov)({ tipo: 'texto', texto: 'tem lagarta na bordadura' });
  assert.equal(r.transcricao, 'lagarta na bordadura');
  assert.doesNotMatch(JSON.stringify(prov.pedidos[0].corpo), /inlineData/);
});

test('a legenda da foto sobe junto — é onde vem o número do lote', async () => {
  const prov = provedor([respondendo({ tipo: 'lote', transcricao: '24-0904', lote: '24-0904', confianca: 0.9 })]);
  await extratorDe(prov, { lerMidia: async () => ({ mime: 'image/jpeg', bytes: Buffer.from('f') }) })
    ({ tipo: 'imagem', midiaId: 'x', texto: 'lote do saco' });
  assert.match(JSON.stringify(prov.pedidos[0].corpo), /lote do saco/);
});

/* ------------------------------------------------- o que ele faz da volta */

test('campo nulo é descartado em vez de virar ruído no cartão', async () => {
  const prov = provedor([respondendo({
    tipo: 'visita', transcricao: 'Passei na Gleba 4.', estagio: 'V6', estande: 58,
    cultivar: null, marca: null, lote: '', confianca: 0.8,
  })]);
  const r = await extratorDe(prov)({ tipo: 'texto', texto: 'passei na gleba 4' });
  assert.deepEqual(r.extraido, { estagio: 'V6', estande: 58, confianca: 0.8 });
  assert.equal(r.tipo, 'visita');
});

test('tipo que o banco não aceita vira lavoura em vez de derrubar o relato', async () => {
  const prov = provedor([respondendo({ tipo: 'colheita', transcricao: 'colhi', confianca: 0.5 })]);
  const r = await extratorDe(prov)({ tipo: 'texto', texto: 'colhi' });
  assert.equal(r.tipo, 'lavoura', 'o check do banco tem três valores, e ele não inventa um quarto');
});

test('resposta que não é JSON não vira relato', async () => {
  const prov = provedor([{ json: { candidates: [{ content: { parts: [{ text: 'desculpe, não entendi' }] } }] } }]);
  assert.equal(await extratorDe(prov)({ tipo: 'texto', texto: 'oi' }), null);
});

test('resposta sem conteúdo — bloqueio ou corte — não vira relato mudo', async () => {
  const prov = provedor([{ json: { candidates: [{ finishReason: 'SAFETY' }] } }]);
  assert.equal(await extratorDe(prov)({ tipo: 'texto', texto: 'oi' }), null);
});

/* ------------------------------------------------------ quando dá errado */

test('erro passageiro é tentado de novo; o segundo acerto vale', async () => {
  const prov = provedor([{ status: 503 }, respondendo({
    tipo: 'lavoura', transcricao: 'entrou na segunda', confianca: 0.6,
  })]);
  const r = await extratorDe(prov)({ tipo: 'texto', texto: 'oi' });
  assert.equal(prov.pedidos.length, 2);
  assert.equal(r.transcricao, 'entrou na segunda');
});

test('chave errada não é tentada de novo — repetir só gasta', async () => {
  const prov = provedor([{ status: 403 }, { status: 403 }]);
  assert.equal(await extratorDe(prov)({ tipo: 'texto', texto: 'oi' }), null);
  assert.equal(prov.pedidos.length, 1);
});

test('tempo esgotado devolve null, e o relato continua na fila', async () => {
  const lento = {
    chamar: async () => { const e = new Error('demorou'); e.name = 'TimeoutError'; throw e; },
    pedidos: [],
  };
  assert.equal(await extratorDe(lento)({ tipo: 'texto', texto: 'oi' }), null);
});

test('mídia que não abre não derruba nada', async () => {
  const prov = provedor([respondendo({ tipo: 'lavoura', transcricao: 'x', confianca: 1 })]);
  const r = await extratorDe(prov, { lerMidia: async () => null })({ tipo: 'audio', midiaId: 'sumiu' });
  assert.equal(r, null);
  assert.equal(prov.pedidos.length, 0, 'não gasta chamada com o que não tem áudio');
});

test('texto vazio não gasta chamada', async () => {
  const prov = provedor([]);
  assert.equal(await extratorDe(prov)({ tipo: 'texto', texto: '   ' }), null);
  assert.equal(prov.pedidos.length, 0);
});

/* ------------------------------------------- o extrator lê a mídia guardada */

test('o extrator abre a mídia pelo dono — job não tem sessão', async () => {
  const tenantId = await criarTenant('Agro Leste', '55555555000155', 'distribuidor');
  const bytes = Buffer.from('OggS voz de gente no meio da lavoura'.repeat(4));
  const { id } = await guardar({ tenantId, produtorId: null, mime: 'audio/ogg', bytes });

  const m = await lerComoDono(id);
  assert.deepEqual(m.bytes, bytes);
  assert.equal(m.mime, 'audio/ogg');

  // E é essa função que o extrator de verdade recebe — o áudio chega inteiro.
  const prov = provedor([respondendo({ tipo: 'lavoura', transcricao: 'ok', confianca: 0.9 })]);
  await criarExtratorGemini({ chave: 'x', chamar: prov.chamar, lerMidia: lerComoDono, registro: mudo })
    ({ tipo: 'audio', midiaId: id });
  const enviado = prov.pedidos[0].corpo.contents[0].parts.find((p) => p.inlineData);
  assert.equal(enviado.inlineData.data, bytes.toString('base64'));
});

test('sem extrator ligado, extrair devolve null em vez de lançar', async () => {
  usarExtrator(null);
  assert.equal(await extrair({ tipo: 'audio', midiaId: 'x' }), null);
});

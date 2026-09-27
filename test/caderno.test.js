// Caderno de campo — e o share por marca, que é o último item de fosso.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { usarExtrator } from '../api/src/modulos/captura/extrator.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const NUMERO = '5566999000022';
const TEL = '5566999110077';
let req, fechar, tGestor, tFranqueado, tProdutor, produtorId, propriedadeId, t1, t2, t3, plantioNosso;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  usarExtrator(null);

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  const franqueado = await criarTenant('FS Sementes', '22222222000122', 'franqueado');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  await criarUsuario(franqueado, 'Chefe', 'chefe@fs.com', 'gestor');
  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');
  tFranqueado = await entrar(req, 'chefe@fs.com');

  // FS695 é do nosso catálogo; o resto é marca de terceiro.
  await req('/catalogo/produtos', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'FS695', cultura: 'milho' },
  });

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 1000 },
  });
  propriedadeId = f.corpo.id;

  const talhao = async (nome, areaHa) => (await req(
    `/cadastro/propriedades/${propriedadeId}/talhoes`,
    { metodo: 'POST', token: tGestor, corpo: { nome, areaHa } })).corpo.id;
  t1 = await talhao('Gleba 1', 500);
  t2 = await talhao('Gleba 2', 300);
  t3 = await talhao('Gleba 3', 200);

  await req('/captura/canal', { metodo: 'POST', token: tGestor, corpo: { numero: NUMERO } });
  await req('/auth/convites', { metodo: 'POST', token: tGestor, corpo: { produtorId, telefone: TEL } });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: cod.corpo.codigo },
  });
  tProdutor = ent.corpo.token;
});

after(async () => { usarExtrator(null); await fechar(); await encerrar(); });

/* ---------------------------------------------------------------- plantio */

test('o cultivar do catálogo se reconhece sozinho como nosso', async () => {
  const r = await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId: t1, safra: '26/27', cultivar: 'FS695', marca: 'FS Sementes',
      cultura: 'milho', areaHa: 500, plantadoEm: '2026-09-12', populacao: 62 },
  });
  assert.equal(r.status, 201);
  assert.ok(r.corpo.produto_id, 'ligou ao catálogo sem ninguém classificar à mão');
  plantioNosso = r.corpo.id;
});

test('marca de terceiro entra igual, e é o que responde a H5', async () => {
  const r = await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId: t2, safra: '26/27', cultivar: 'XB200', marca: 'Marca B', areaHa: 300 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.produto_id, null, 'nulo significa marca de terceiro');
});

test('safra e safrinha convivem no mesmo talhão', async () => {
  const soja = await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId: t3, safra: '26/27', ciclo: 'safra', cultivar: 'Soja X',
      marca: 'Marca C', areaHa: 200 },
  });
  assert.equal(soja.status, 201);

  const milho = await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId: t3, safra: '26/27', ciclo: 'safrinha', cultivar: 'FS695',
      marca: 'FS Sementes', areaHa: 200 },
  });
  assert.equal(milho.status, 201, 'a planilha de origem era de milho safrinha');

  const lista = await req(`/caderno/plantios?talhaoId=${t3}`, { token: tGestor });
  assert.equal(lista.corpo.length, 2);
});

test('replantar o mesmo talhão e ciclo corrige em vez de duplicar', async () => {
  const r = await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId: t2, safra: '26/27', cultivar: 'XB250', marca: 'Marca B', areaHa: 300 },
  });
  assert.equal(r.status, 201);
  const lista = await req(`/caderno/plantios?talhaoId=${t2}`, { token: tGestor });
  assert.equal(lista.corpo.length, 1);
  assert.equal(lista.corpo[0].cultivar, 'XB250', 'corrigiu o registro anterior');
});

test('marca é obrigatória — sem ela o registro não serve para nada', async () => {
  const r = await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId: t1, safra: '25/26', cultivar: 'Qualquer' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'marca');
});

/* ------------------------------------------------------------------ share */

test('o share por marca sai por área, como o glossário define', async () => {
  const r = await req('/caderno/share?safra=26/27', { token: tGestor });
  assert.equal(r.corpo.areaObservadaHa, 1200, '500 + 300 + 200 + 200');

  const porMarca = Object.fromEntries(r.corpo.marcas.map((m) => [m.marca, m]));
  assert.equal(porMarca['FS Sementes'].nossa, true);
  assert.equal(porMarca['FS Sementes'].areaHa, 700, 'gleba 1 e a safrinha da gleba 3');
  assert.equal(porMarca['Marca B'].nossa, false);
  assert.equal(r.corpo.nossoShare, 58.3);
});

test('o share diz de que base ele saiu, em vez de se passar por absoluto', async () => {
  const r = await req('/caderno/share?safra=26/27', { token: tGestor });
  assert.match(r.corpo.base, /não o mercado do território/);
});

/* --------------------------------------------------------------- colheita */

test('a colheita fecha o laço: a semente virou saco por hectare', async () => {
  const r = await req(`/caderno/plantios/${plantioNosso}/colheita`, {
    metodo: 'POST', token: tGestor,
    corpo: { produtividadeScHa: 112, umidade: 13.5, colhidoEm: '2027-02-20' },
  });
  assert.equal(r.status, 201);
  assert.equal(Number(r.corpo.colheita.produtividade_sc_ha), 112);
});

test('colher de novo corrige, não duplica', async () => {
  await req(`/caderno/plantios/${plantioNosso}/colheita`, {
    metodo: 'POST', token: tGestor, corpo: { produtividadeScHa: 118 },
  });
  const r = await req(`/caderno/plantios/${plantioNosso}`, { token: tGestor });
  assert.equal(Number(r.corpo.colheita.produtividade_sc_ha), 118);
});

test('o desempenho compara cultivares, inclusive os de terceiros', async () => {
  const outro = await req(`/caderno/plantios?talhaoId=${t2}`, { token: tGestor });
  await req(`/caderno/plantios/${outro.corpo[0].id}/colheita`, {
    metodo: 'POST', token: tGestor, corpo: { produtividadeScHa: 96 },
  });

  const r = await req('/caderno/desempenho?safra=26/27', { token: tGestor });
  assert.equal(r.corpo[0].cultivar, 'FS695', 'ordenado pela média');
  assert.equal(Number(r.corpo[0].media_sc_ha), 118);
  const deles = r.corpo.find((x) => x.marca === 'Marca B');
  assert.equal(deles.nossa, false);
  assert.equal(Number(deles.media_sc_ha), 96);
});

/* ------------------------------------------------ quem enxerga o caderno */

test('o produtor vê a lavoura dele — é camada técnica, compartilhada', async () => {
  const r = await req('/caderno/plantios', { token: tProdutor });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.length >= 3);
  assert.ok(r.corpo.some((p) => p.marca === 'Marca B'),
    'ele vê o que plantou, de qualquer marca — o histórico é dele');
});

test('o produtor não escreve no caderno: quem fecha é o consultor', async () => {
  const r = await req('/caderno/plantios', {
    metodo: 'POST', token: tProdutor,
    corpo: { talhaoId: t1, safra: '26/27', cultivar: 'X', marca: 'Y' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('o produtor não vê o share — é leitura comercial', async () => {
  const r = await req('/caderno/share?safra=26/27', { token: tProdutor });
  assert.equal(r.status, 400);
});

test('o franqueado alcança o talhão pelos pedidos que carimbam o território dele', async () => {
  const antes = await req('/caderno/plantios?safra=26/27', { token: tFranqueado });
  assert.deepEqual(antes.corpo, [], 'sem venda no território, não enxerga nada');

  await req('/cadastro/territorios', { metodo: 'POST', token: tGestor, corpo: {} })
    .catch(() => null);
  const { dono } = await import('../api/src/db.js');
  const fq = (await dono.query("select id from tenant where tipo = 'franqueado'")).rows[0].id;
  await dono.query(
    'insert into territorio (municipio, uf, franqueado_id) values ($1,$2,$3)',
    ['Sorriso', 'MT', fq]);

  await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-4001', safra: '26/27', produtorId, propriedadeId,
      itens: [{ cultivar: 'FS695', quantidade: 500 }] },
  });

  const depois = await req('/caderno/plantios?safra=26/27', { token: tFranqueado });
  assert.ok(depois.corpo.length > 0,
    'ele vendeu pelo canal e agora enxerga o que foi plantado — é o que ele compra');
});

/* ------------------------------------------- o laço com a captura de campo */

test('relato de lavoura validado vira plantio, quando traz cultivar e marca', async () => {
  usarExtrator(async () => ({
    transcricao: 'Plantei a Gleba 1 com FS560 da FS Sementes.',
    extraido: { cultivar: 'FS560', marca: 'FS Sementes', safra: '25/26', areaHa: 500 },
    tipo: 'lavoura',
  }));

  const msg = await req('/captura/mensagens', {
    metodo: 'POST', cabecalhos: { 'x-gateway-segredo': process.env.GATEWAY_SEGREDO },
    corpo: { de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/plantio.ogg' },
  });

  // O consultor aponta o talhão ao validar — a IA não adivinha qual é.
  await req(`/captura/relatos/${msg.corpo.relatoId}/validar`, {
    metodo: 'POST', token: tGestor, corpo: { talhaoId: t1 },
  });

  const r = await req(`/caderno/plantios?safra=25/26`, { token: tGestor });
  const novo = r.corpo.find((p) => p.cultivar === 'FS560');
  assert.ok(novo, 'o áudio virou registro de lavoura');
  assert.equal(novo.marca, 'FS Sementes');
});

test('relato sem marca extraída não vira plantio — inventar seria pior', async () => {
  usarExtrator(async () => ({
    transcricao: 'A lavoura está bonita.',
    extraido: { estagio: 'V6' },
    tipo: 'lavoura',
  }));
  const msg = await req('/captura/mensagens', {
    metodo: 'POST', cabecalhos: { 'x-gateway-segredo': process.env.GATEWAY_SEGREDO },
    corpo: { de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/vago.ogg' },
  });
  const antes = (await req('/caderno/plantios', { token: tGestor })).corpo.length;
  await req(`/captura/relatos/${msg.corpo.relatoId}/validar`, {
    metodo: 'POST', token: tGestor, corpo: { talhaoId: t1 },
  });
  const depois = (await req('/caderno/plantios', { token: tGestor })).corpo.length;
  assert.equal(depois, antes);
});

// O benchmark regional — o número mais fácil de vazar do sistema.
//
// Num município com dois produtores, a média da região É o número do vizinho:
// basta subtrair o próprio. O que se verifica aqui é que a regra de anonimato
// não depende de quem chama, porque ela mora dentro da função do banco.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { comContexto } from '../api/src/contexto.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const SAFRA = '26/27';
let req, fechar, tRevenda;
const produtores = [];

/** Um produtor com uma gleba colhida em Sorriso, salvo indicação contrária. */
async function fazendeiro(nome, scHa, { municipio = 'Sorriso', areaHa = 500 } = {}) {
  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome },
  });
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: `Fazenda ${nome}`, produtorId: p.corpo.id, municipio, uf: 'MT', areaHa },
  });
  const t = await req(`/cadastro/propriedades/${f.corpo.id}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba 1', areaHa },
  });
  const pl = await req('/caderno/plantios', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      talhaoId: t.corpo.id, safra: SAFRA, cultivar: 'FS560',
      marca: 'FS Sementes', areaHa,
    },
  });
  assert.equal(pl.status, 201, JSON.stringify(pl.corpo));
  if (scHa !== null) {
    await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
      metodo: 'POST', token: tRevenda,
      corpo: { colhidoEm: '2027-03-08', produtividadeScHa: scHa },
    });
  }
  produtores.push({ id: p.corpo.id, nome, scHa, areaHa, municipio });
  return p.corpo.id;
}

/** O benchmark como o banco o entrega, sem passar por rota nenhuma. */
const doBanco = (municipio, excluir, uf = 'MT', safra = SAFRA) =>
  comContexto({ tenant: null }, (cx) =>
    cx.query('select * from app.benchmark_regional($1,$2,$3,$4)',
      [safra, municipio, uf, excluir]).then((r) => r.rows[0] ?? null));

const quem = (nome) => produtores.find((p) => p.nome === nome);

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ({ req, fechar } = await subirApi());
  tRevenda = await entrar(req, 'gestora@3t.com');
  await req('/catalogo/produtos', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'FS560', categoria: 'semente' },
  });
});

after(async () => { await fechar(); await encerrar(); });

/* --------------------------------------------------- o piso de anonimato */

test('com um outro produtor não há benchmark — a média seria o número dele', async () => {
  await fazendeiro('Produtor A', 60);
  await fazendeiro('Produtor B', 80);
  assert.equal(await doBanco('Sorriso', quem('Produtor B').id), null);
});

test('com quatro outros ainda não — o piso é cinco', async () => {
  await fazendeiro('Produtor C', 64);
  await fazendeiro('Produtor D', 72);
  await fazendeiro('Produtor E', 58);
  assert.equal(await doBanco('Sorriso', quem('Produtor B').id), null,
    'A, C, D e E são quatro: ainda dá para deduzir subtraindo conhecidos');
});

test('com cinco outros o número aparece, e diz de quantos é', async () => {
  await fazendeiro('Produtor F', 68);

  const r = await doBanco('Sorriso', quem('Produtor B').id);
  assert.ok(r, 'cinco outros: A, C, D, E, F');
  assert.equal(r.nivel, 'município');
  assert.equal(r.produtores, 5);
  // (60 + 64 + 72 + 58 + 68) / 5, todas as glebas com 500 ha.
  assert.equal(Number(r.media_ponderada_sc_ha), 64.4);
});

test('quem pergunta nunca entra na própria comparação', async () => {
  const comEle = await doBanco('Sorriso', null);
  const semEle = await doBanco('Sorriso', quem('Produtor B').id);
  assert.equal(comEle.produtores, semEle.produtores + 1);
  assert.notEqual(Number(comEle.media_ponderada_sc_ha), Number(semEle.media_ponderada_sc_ha));
});

test('a função devolve agregado: nunca linha, nome ou identificador', async () => {
  const r = await doBanco('Sorriso', null);
  assert.deepEqual(Object.keys(r).sort(),
    ['area_ha', 'media_ponderada_sc_ha', 'nivel', 'produtores']);
});

/* ------------------------------------------------------ o recorte que sobe */

test('município magro sobe para o estado, e a resposta diz qual nível usou', async () => {
  const sozinho = await fazendeiro('Produtor Sinop', 55, { municipio: 'Sinop' });
  const r = await doBanco('Sinop', sozinho);
  assert.ok(r);
  assert.equal(r.nivel, 'estado',
    'sem dizer o nível, ele leria "região" achando que é a cidade dele');
  assert.ok(r.produtores >= 5);
});

test('estado magro também não inventa — devolve nada', async () => {
  assert.equal(await doBanco('Barreiras', null, 'BA'), null,
    'estado sem ninguém não vira média de zero');
});

test('safra sem colheita nenhuma não vira benchmark', async () => {
  assert.equal(await doBanco('Sorriso', null, 'MT', '30/31'), null);
});

/* ---------------------------------------------------------------- pela rota */

test('o produtor recebe a comparação pela rota, com a base colada', async () => {
  const b = quem('Produtor B');
  const tel = '5566999330022';
  await req('/auth/convites', {
    metodo: 'POST', token: tRevenda, corpo: { produtorId: b.id, telefone: tel },
  });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: tel } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: tel, codigo: cod.corpo.codigo },
  });

  const r = await req(`/caderno/benchmark?safra=${SAFRA}`, { token: ent.corpo.token });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.municipio, 'Sorriso');
  assert.equal(r.corpo.produtores, 5);
  assert.equal(r.corpo.mediaPonderadaScHa, 64.4);
  assert.match(r.corpo.base, /sem nome e sem número individual/);
  assert.equal(r.corpo.semGenteBastante, undefined);
});

test('sem produtorId e sem sessão de produtor, a rota recusa', async () => {
  const r = await req(`/caderno/benchmark?safra=${SAFRA}`, { token: tRevenda });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'produtorId');
});

test('a rota não é porta dos fundos: o piso vale por ela também', async () => {
  // O produtor de Sinop está sozinho lá; pela rota ele sobe para o estado, e
  // em nenhum caminho aparece um número de menos de cinco produtores.
  const s = quem('Produtor Sinop');
  const r = await req(`/caderno/benchmark?safra=${SAFRA}&produtorId=${s.id}`,
    { token: tRevenda });
  assert.equal(r.status, 200);
  if (r.corpo.semGenteBastante) assert.equal(r.corpo.mediaPonderadaScHa, undefined);
  else assert.ok(r.corpo.produtores >= 5);
});

test('sem safra pedida, vale a mais recente registrada', async () => {
  // A rota do portal não manda safra. Sem resolver pelo dado, a consulta ia por
  // nulo e voltava vazia — e "vazio" é indistinguível de "não há vizinhos
  // bastante", que é justamente a confusão que este módulo evita.
  const b = quem('Produtor B');
  const r = await req(`/caderno/benchmark?produtorId=${b.id}`, { token: tRevenda });
  assert.equal(r.status, 200);
  assert.ok(r.corpo, 'sem ?safra= também responde');
  assert.equal(r.corpo.produtores, 5);
});

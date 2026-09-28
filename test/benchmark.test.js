// O benchmark regional — o número mais fácil de vazar do sistema.
//
// Num município com dois produtores, a média da região É o número do vizinho:
// basta subtrair o próprio. O que se verifica aqui é que a regra de anonimato
// não depende de quem chama, porque ela mora dentro da função do banco.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
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

/* ------------------------------------------- a carteira contra a região */

test('a região da revenda INCLUI a carteira dela, e isso é decisão', async () => {
  // O produtor é excluído da própria comparação porque não escolhe quem mais
  // está no grupo. A revenda escolhe: se a região fosse "todos menos a minha
  // carteira", mover um produtor para dentro dela mudaria o número da região, e
  // a diferença entre duas consultas revelaria a lavoura daquele produtor.
  const r = await req(`/caderno/benchmark-por-municipio?safra=${SAFRA}`, { token: tRevenda });
  assert.equal(r.status, 200);
  const sorriso = r.corpo.find((m) => m.municipio === 'Sorriso');
  assert.ok(sorriso);

  // Todos os produtores de Sorriso são da carteira desta revenda, então a
  // comparação é contra si mesma e fica calada.
  assert.equal(sorriso.regiao, null,
    'carteira que é o município inteiro não se compara com ela mesma');
  assert.ok(sorriso.minhaMediaScHa > 0);
});

test('com gente de fora da carteira, a comparação aparece', async () => {
  const outra = await criarTenant('Agro Sul', '22222222000122', 'distribuidor');
  await criarUsuario(outra, 'Gestor Sul', 'gestor@sul.com', 'gestor');
  const tOutra = await entrar(req, 'gestor@sul.com');
  await req('/catalogo/produtos', {
    metodo: 'POST', token: tOutra, corpo: { nome: 'NS7709', categoria: 'semente' },
  });

  // Seis produtores da concorrente no mesmo município.
  const antes = tRevenda;
  tRevenda = tOutra;
  for (let i = 1; i <= 6; i++) await fazendeiro(`Da Concorrente ${i}`, 50 + i);
  tRevenda = antes;

  const r = await req(`/caderno/benchmark-por-municipio?safra=${SAFRA}`, { token: tRevenda });
  const sorriso = r.corpo.find((m) => m.municipio === 'Sorriso');
  assert.ok(sorriso.regiao, 'agora há gente além da carteira dela');
  assert.ok(sorriso.regiao.produtores > sorriso.produtoresMeus);
  assert.equal(typeof sorriso.regiao.variacaoPct, 'number');
});

test('o piso vale igual por este caminho', async () => {
  // Um município com poucos produtores não ganha comparação, venha a pergunta
  // do produtor ou da revenda.
  const r = await req(`/caderno/benchmark-por-municipio?safra=${SAFRA}`, { token: tRevenda });
  const sinop = r.corpo.find((m) => m.municipio === 'Sinop');
  if (sinop) {
    assert.ok(!sinop.regiao || sinop.regiao.produtores >= 5,
      'nunca um número de menos de cinco produtores');
  }
});

test('a rota é da empresa — o produtor tem a dele, com outra exclusão', async () => {
  const b = quem('Produtor B');
  const tel = '5566999330022';
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: tel } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: tel, codigo: cod.corpo.codigo },
  });
  assert.ok(ent.corpo.token, JSON.stringify(ent.corpo));
  const r = await req(`/caderno/benchmark-por-municipio?safra=${SAFRA}`,
    { token: ent.corpo.token });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
  assert.ok(b);
});

/* --------------------------------- a rede contra o território de cada um */

test('o franqueado é comparado com a região DELE, não com o outro franqueado', async () => {
  // Ranking entre franqueados carrega uma ressalva que o torna quase inútil
  // sozinho: quem está no topo pode apenas ter a melhor terra. Contra o próprio
  // território, o terroir sai da conta.
  const ind = await criarTenant('Indústria FS', '91000000000191', 'franqueadora');
  await criarUsuario(ind, 'Diretor', 'diretor@fs.com', 'gestor');
  const tInd = await entrar(req, 'diretor@fs.com');
  const fq = await criarTenant('FS Sorriso', '92000000000192', 'franqueado');
  await dono.query('insert into rede (franqueado_id, franqueadora_id) values ($1,$2)', [fq, ind]);
  await dono.query(
    'insert into territorio (municipio, uf, franqueado_id) values ($1,$2,$3)',
    ['Sorriso', 'MT', fq]);

  // Um pedido carimba o território e faz a lavoura descer para a rede.
  const b = quem('Produtor B');
  await req('/catalogo/produtos', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'FS560', categoria: 'semente' },
  });
  const prop = (await req('/cadastro/propriedades', { token: tRevenda })).corpo
    .find((x) => x.nome === 'Fazenda Produtor B');
  const ped = await req('/pedidos', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      numero: 'PED-REDE-1', safra: SAFRA, produtorId: b.id, propriedadeId: prop.id,
      itens: [{ cultivar: 'FS560', quantidade: 100, precoUnit: 300 }],
    },
  });
  assert.equal(ped.status, 201, JSON.stringify(ped.corpo));

  const r = await req(`/caderno/rede-contra-regiao?safra=${SAFRA}`, { token: tInd });
  assert.equal(r.status, 200);
  const linha = r.corpo.find((x) => x.franqueado === 'FS Sorriso');
  assert.ok(linha, 'a rede dela tem esse franqueado');
  assert.ok(linha.territorio, 'e Sorriso tem gente bastante');
  assert.equal(linha.territorio.municipios, 1);
  assert.ok(linha.territorio.produtores >= 5);
  assert.match(linha.territorio.base, /incluindo quem não comprou da rede/);
  // O Produtor B fez 80 num território que faz menos: a variação é positiva.
  assert.equal(linha.mediaPonderadaScHa, 80);
  assert.ok(linha.territorio.variacaoPct > 0);
});

test('o território inclui quem não comprou da rede — é o ponto', async () => {
  const tInd = await entrar(req, 'diretor@fs.com');
  const r = await req(`/caderno/rede-contra-regiao?safra=${SAFRA}`, { token: tInd });
  const linha = r.corpo.find((x) => x.franqueado === 'FS Sorriso');
  // A franqueadora enxerga UMA lavoura pela rede dela, e o território tem
  // muitas: o denominador vem da função, não do que ela alcança.
  assert.equal(linha.talhoes, 1);
  assert.ok(linha.territorio.produtores > 1);
});

test('o piso vale no território como vale no município', async () => {
  const ind = (await dono.query(
    "select id from tenant where documento = '91000000000191'")).rows[0].id;
  const magro = await criarTenant('FS Deserto', '93000000000193', 'franqueado');
  await dono.query('insert into rede (franqueado_id, franqueadora_id) values ($1,$2)',
    [magro, ind]);
  await dono.query(
    'insert into territorio (municipio, uf, franqueado_id) values ($1,$2,$3)',
    ['Água Boa', 'MT', magro]);

  const r = await comContexto({ tenant: null }, (cx) =>
    cx.query('select * from app.benchmark_do_territorio($1,$2)', [SAFRA, magro])
      .then((x) => x.rows[0] ?? null));
  assert.equal(r, null, 'território sem cinco produtores não devolve média');
});

test('quem não tem rede não recebe a comparação por franqueado', async () => {
  const r = await req(`/caderno/rede-contra-regiao?safra=${SAFRA}`, { token: tRevenda });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, [], 'a revenda não tem franqueados a comparar');
});

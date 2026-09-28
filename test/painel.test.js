// O painel do gestor: a tela de abertura da área da empresa.
//
// O que se verifica aqui não é aritmética — cada número já tem teste no módulo
// dono. É o que o painel promete: que a safra sai do dado e não de constante,
// que o corte de atenção é do módulo, que a base do share viaja colada ao
// número, e que gestor e consultor recebem a mesma resposta com a política
// decidindo o conteúdo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { safraDoCalendario } from '../api/src/modulos/painel/service.js';
import { DIAS_PARADO_DEMAIS } from '../api/src/modulos/pedidos/service.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const SAFRA = '26/27';
let req, fechar, tGestor, tConsultor, tOutra, produtorId, propriedadeId, talhaoId, talhaoVizinho;
let pedidoParado, pedidoNovo;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('Agro Norte', '66666666000166', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@norte.com', 'gestor');
  const consultorId = await criarUsuario(revenda, 'Consultor', 'consultor@norte.com', 'consultor');
  const outra = await criarTenant('Agro Sul', '77777777000177', 'distribuidor');
  await criarUsuario(outra, 'Gestor Sul', 'gestor@sul.com', 'gestor');

  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@norte.com');
  tConsultor = await entrar(req, 'consultor@norte.com');
  tOutra = await entrar(req, 'gestor@sul.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 1000 },
  });
  propriedadeId = f.corpo.id;
  // Dois talhões: o plantio é único por talhão/safra/ciclo — registrar duas
  // marcas na mesma gleba substitui a primeira, que é o certo para replantio
  // e errado para medir share.
  const novoTalhao = async (nome, areaHa) => {
    const t = await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
      metodo: 'POST', token: tGestor, corpo: { nome, areaHa },
    });
    assert.equal(t.status, 201, JSON.stringify(t.corpo));
    return t.corpo.id;
  };
  talhaoId = await novoTalhao('Gleba 1', 300);
  talhaoVizinho = await novoTalhao('Gleba 2', 100);

  // Carteira do consultor: é o que a política estreita para ele.
  await dono.query(
    `insert into consultor_carteira (vinculo_id, usuario_id)
     select v.id, $2 from produtor_vinculo v where v.produtor_id = $1`,
    [produtorId, consultorId]);

  await req('/catalogo/produtos', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'FS560', marca: 'FS Sementes', categoria: 'semente', unidade: 'sc' },
  });

  const abrir = async (numero, itens) => {
    const r = await req('/pedidos', {
      metodo: 'POST', token: tGestor,
      corpo: { numero, safra: SAFRA, produtorId, propriedadeId, itens },
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    return r.corpo.id;
  };

  pedidoParado = await abrir('PED-001', [
    { cultivar: 'FS560', quantidade: 800, precoUnit: 310, royaltiesSc: 12.5 },
    { cultivar: 'FS560', quantidade: 40, bonificada: true },
  ]);
  pedidoNovo = await abrir('PED-002', [
    { cultivar: 'FS560', quantidade: 200, precoUnit: 310 },
  ]);

  // Um dos dois está parado há muito tempo. É o que o gargalo tem de achar.
  await dono.query(
    `update pedido_etapa set em = now() - interval '20 days' where pedido_id = $1`,
    [pedidoParado]);
  await dono.query(
    `update pedido set criado_em = now() - interval '20 days' where id = $1`,
    [pedidoParado]);
});

after(async () => { await fechar(); await encerrar(); });

const painel = (token, q = '') => req(`/painel${q}`, { token });

/* ---------------------------------------------------------------- a porta */

test('o portal do produtor não abre o painel da empresa', async () => {
  await req('/auth/convites', {
    metodo: 'POST', token: tGestor, corpo: { produtorId, telefone: '5566999330011' },
  });
  const cod = await req('/auth/produtor/codigo', {
    metodo: 'POST', corpo: { telefone: '5566999330011' },
  });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: '5566999330011', codigo: cod.corpo.codigo },
  });
  const r = await painel(ent.corpo.token);
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('sem sessão não há painel', async () => {
  const r = await req('/painel');
  assert.equal(r.status, 401);
});

/* ---------------------------------------------------------------- a safra */

test('a safra sai do que foi vendido, não de constante no código', async () => {
  const r = await painel(tGestor);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.safra, SAFRA);
  assert.equal(r.corpo.safraVeioDe, 'última venda');
});

test('safra pedida na consulta manda', async () => {
  const r = await painel(tGestor, '?safra=20/21');
  assert.equal(r.corpo.safra, '20/21');
  assert.equal(r.corpo.safraVeioDe, 'pedida');
  assert.equal(r.corpo.venda.quantidadeSc, 0, 'safra sem venda mostra zero, não o total');
});

test('empresa que nunca vendeu cai no calendário em vez de ficar sem safra', async () => {
  const r = await painel(tOutra);
  assert.equal(r.corpo.safra, safraDoCalendario());
  assert.equal(r.corpo.safraVeioDe, 'calendário');
});

test('o calendário vira a safra em julho, quando começa o plantio', () => {
  assert.equal(safraDoCalendario(new Date('2026-06-30')), '25/26');
  assert.equal(safraDoCalendario(new Date('2026-07-01')), '26/27');
});

/* ---------------------------------------------------------------- a venda */

test('a bonificada aparece separada — senão a safra parece maior que a venda', async () => {
  const { venda } = (await painel(tGestor)).corpo;
  assert.equal(venda.quantidadeSc, 1040);
  assert.equal(venda.bonificadaSc, 40);
  assert.equal(venda.bonificadaPct, 3.8);
  assert.equal(venda.receita, 800 * 310 + 200 * 310);
  assert.equal(venda.royalties, 800 * 12.5);
  // O preço médio efetivo já desconta a bonificada: é o que ela custou.
  assert.ok(venda.precoMedioEfetivo < 310, 'a geração de demanda derruba o preço médio');
});

/* -------------------------------------------------------------- o gargalo */

test('o gargalo é tempo parado, não contagem de pedidos na etapa', async () => {
  const { operacao } = (await painel(tGestor)).corpo;
  assert.equal(operacao.emAndamento, 2);
  assert.equal(operacao.corteDias, DIAS_PARADO_DEMAIS, 'a régua é do módulo, não da tela');

  const etapa1 = operacao.etapas.find((e) => e.etapa === 1);
  assert.equal(etapa1.pedidos, 2);
  assert.equal(etapa1.pior_dias, 20);
  assert.equal(etapa1.pior_pedido, 'PED-001', 'o gestor vai atrás do pedido, não da média');
});

test('trabalhar no pedido tira ele de parado, mesmo sem avançar a etapa', async () => {
  // Registrar o crédito não avança nada, mas é trabalho. Marcar como parado o
  // pedido em que se mexeu ontem ensinaria o gestor a ignorar o indicador.
  const r = await req(`/pedidos/${pedidoParado}/credito`, {
    metodo: 'PATCH', token: tGestor, corpo: { credito: 'aprovado' },
  });
  assert.equal(r.status, 200);

  const { operacao } = (await painel(tGestor)).corpo;
  const etapa1 = operacao.etapas.find((e) => e.etapa === 1);
  assert.equal(etapa1.pior_dias, 0);
  assert.equal(operacao.pior, null, 'operação saudável não aponta gargalo nenhum');
});

/* ------------------------------------------------------- carteira e campo */

test('quem não comprou aparece, e a lacuna vem em sacos', async () => {
  const { carteira } = (await painel(tGestor)).corpo;
  assert.equal(carteira.produtores, 1);
  assert.equal(carteira.semCompra, 0, 'este comprou');
  assert.ok(carteira.origemDaTaxa.includes('agronomia'),
    'a taxa de sc/ha é estimativa, e a resposta diz isso');
});

test('a fila do campo e os relatos a validar entram no painel', async () => {
  const { campo } = (await painel(tGestor)).corpo;
  assert.equal(campo.naFila, 1);
  assert.equal(campo.nuncaVisitados, 1, 'nunca visitado entra como atrasado');
  assert.equal(campo.relatosAValidar, 0);
  assert.equal(campo.proximos[0].produtor, 'José Cesar Sabo');
});

/* -------------------------------------------------------------- o mercado */

test('o share vem com o denominador colado nele', async () => {
  await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId, safra: SAFRA, cultivar: 'FS560', marca: 'FS Sementes', areaHa: 300 },
  });
  await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: { talhaoId: talhaoVizinho, safra: SAFRA, cultivar: 'NS7709', marca: 'Nidera', areaHa: 100 },
  });

  const { mercado } = (await painel(tGestor)).corpo;
  assert.equal(mercado.nossoShare, 75);
  assert.match(mercado.base, /não o mercado/,
    'sem a frase, 75% é lido como share de mercado — outra ordem de grandeza');
  assert.equal(mercado.topo[0].nossa, true);
});

/* ------------------------------------------------ a política é que decide */

test('gestor e consultor recebem a mesma resposta; o conteúdo é que muda', async () => {
  const g = (await painel(tGestor)).corpo;
  const c = (await painel(tConsultor)).corpo;
  assert.deepEqual(Object.keys(g).sort(), Object.keys(c).sort(),
    'nenhum campo aparece ou some por papel — quem estreita é a política');
  assert.equal(c.carteira.produtores, 1, 'o produtor está na carteira deste consultor');
});

test('o painel de uma empresa não enxerga a outra', async () => {
  const r = (await painel(tOutra)).corpo;
  assert.equal(r.venda.quantidadeSc, 0);
  assert.equal(r.operacao.emAndamento, 0);
  assert.equal(r.carteira.produtores, 0);
  assert.equal(r.campo.naFila, 0);
});

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
import { comContexto } from '../api/src/contexto.js';
import { migrar } from '../api/src/migrar.js';
import { safraDoCalendario } from '../api/src/modulos/painel/service.js';
import { DIAS_PARADO_DEMAIS } from '../api/src/modulos/pedidos/service.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const SAFRA = '26/27';
let req, fechar, tGestor, tConsultor, tOutra, produtorId, propriedadeId, talhaoId, talhaoVizinho, tProdutorPainel;
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
  tProdutorPainel = ent.corpo.token;
  const r = await painel(tProdutorPainel);
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
  // Bloco sem dado vem AUSENTE, não zerado: "0 produtores atrasados" descreve
  // um problema que não existe, em vez de descrever a falta de carteira.
  assert.equal(r.operacao, null);
  assert.equal(r.carteira, null);
  assert.equal(r.campo, null);
  assert.equal(r.funil, null);
  assert.equal(r.mercado, null);
});

/* ---------------------------------------------- o fechamento da safra */

test('o painel fecha a safra com a ponderada, e não recalcula nada', async () => {
  // Um talhão pequeno e ótimo, um grande e mediano: a média simples daria 71,5.
  const t2 = await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: tGestor, corpo: { nome: 'Gleba 3', areaHa: 1800 },
  });
  const plantar = async (talhao, cultivar, marca, areaHa, scHa) => {
    const pl = await req('/caderno/plantios', {
      metodo: 'POST', token: tGestor,
      corpo: { talhaoId: talhao, safra: SAFRA, ciclo: 'safrinha', cultivar, marca, areaHa },
    });
    assert.equal(pl.status, 201, JSON.stringify(pl.corpo));
    await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
      metodo: 'POST', token: tGestor,
      corpo: { colhidoEm: '2027-03-10', produtividadeScHa: scHa },
    });
  };
  // FS560 está no catálogo desta revenda; Nidera não.
  await plantar(talhaoId, 'FS560', 'FS Sementes', 40, 88);
  await plantar(t2.corpo.id, 'NS7709', 'Nidera', 1800, 55);

  const { resultado: safra } = (await painel(tGestor)).corpo;
  assert.ok(safra, 'o painel fecha a safra');
  assert.equal(safra.areaColhidaHa, 1840);
  assert.equal(safra.mediaPonderadaScHa, 55.7, 'a média simples daria 71,5');
  assert.equal(safra.totalSc, 40 * 88 + 1800 * 55);
  assert.match(safra.base, /não é a média dos talhões/,
    'a frase vem do caderno, não é reescrita aqui');
  assert.equal(safra.melhores[0].produtividadeScHa, 88);
  assert.equal(safra.piores[0].produtividadeScHa, 55);
});

test('a comparação entre a nossa semente e a do concorrente vem com a ressalva', async () => {
  const { resultado: safra } = (await painel(tGestor)).corpo;
  const o = safra.porOrigem;
  assert.equal(o.nossa.mediaPonderadaScHa, 88, 'FS560 é do catálogo desta revenda');
  assert.equal(o.demais.mediaPonderadaScHa, 55);
  assert.equal(o.diferencaScHa, 33);
  assert.match(o.base, /não é ensaio comparativo/,
    'a diferença mistura semente, solo, data e manejo — e quem lê num painel '
    + 'atribui tudo à semente');
});

test('a leitura comercial da safra é só da empresa', async () => {
  const r = await req(`/caderno/resultado-por-origem?safra=${SAFRA}`, { token: tProdutorPainel });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);

  // O fechamento em si ele lê: é a terra dele.
  const dele = await req(`/caderno/resultado?safra=${SAFRA}`, { token: tProdutorPainel });
  assert.equal(dele.status, 200);
  assert.equal(dele.corpo.porOrigem, undefined,
    'a separação nossa/concorrente não vaza pelo endpoint que o portal lê');
});

test('safra sem colheita nenhuma não inventa fechamento', async () => {
  const r = await painel(tOutra);
  assert.equal(r.corpo.resultado, null, 'sem plantio registrado, não há safra a fechar');
});

/* ------------------------------------------------ o painel do franqueado */

let tFranqueado;

test('o franqueado enxerga a safra que desceu do território dele', async () => {
  const fq = await criarTenant('FS Sementes', '44444444000144', 'franqueado');
  await criarUsuario(fq, 'Chefe', 'chefe@fs.com', 'gestor');
  tFranqueado = await entrar(req, 'chefe@fs.com');

  // Sorriso é dele — é daí que sai o carimbo do pedido.
  await dono.query(
    'insert into territorio (municipio, uf, franqueado_id) values ($1,$2,$3)',
    ['Sorriso', 'MT', fq]);

  const ped = await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: {
      numero: 'PED-FQ-1', safra: SAFRA, produtorId, propriedadeId, canal: 'distribuidor',
      itens: [{ cultivar: 'FS560', quantidade: 400, precoUnit: 300 }],
    },
  });
  assert.equal(ped.status, 201, JSON.stringify(ped.corpo));

  const p = (await painel(tFranqueado)).corpo;
  assert.equal(p.venda.quantidadeSc, 400, 'só o que carimbou o território dele');
  assert.ok(p.resultado, 'e a safra dos talhões que ele alcança pelo pedido');
  assert.ok(p.resultado.mediaPonderadaScHa > 0);
});

test('o painel do franqueado não mostra o que ele não tem', async () => {
  const p = (await painel(tFranqueado)).corpo;
  // Ele não opera venda, não tem carteira, não visita e não prospecta. Zeros
  // ali descreveriam um problema; a ausência descreve o negócio dele.
  assert.equal(p.carteira, null);
  assert.equal(p.campo, null);
  assert.equal(p.funil, null);
});

test('quanto do território passou por terceiro é o número dele', async () => {
  const p = (await painel(tFranqueado)).corpo;
  assert.equal(p.venda.porCanal.canal.quantidadeSc, 400);
  assert.equal(p.venda.porCanal.direto.quantidadeSc, 0);
  assert.equal(p.venda.porCanal.pelaDistribuidoraPct, 100,
    'ele não operou essa venda — é a única forma de saber que ela existiu');
});

test('o carimbo do canal não se recalcula, como o do território', async () => {
  const { rows } = await dono.query(
    "select canal from pedido where numero = 'PED-FQ-1'");
  assert.equal(rows[0].canal, 'distribuidor');
  const antigos = await dono.query(
    "select count(*)::int as n from pedido where numero like 'PED-00%' and canal <> 'direto'");
  assert.equal(antigos.rows[0].n, 0, 'pedido anterior à migração fica direto, sem inventar');
});

test('um franqueado não enxerga o território do outro', async () => {
  const outroFq = await criarTenant('Outra Marca', '55555555000155', 'franqueado');
  await criarUsuario(outroFq, 'Chefe 2', 'chefe2@outra.com', 'gestor');
  const t2 = await entrar(req, 'chefe2@outra.com');
  const p = (await painel(t2)).corpo;
  assert.equal(p.venda.quantidadeSc, 0);
  assert.equal(p.resultado, null, 'sem território, não desce nada');
});

test('o melhor e o pior talhão vêm com o nome da fazenda', async () => {
  // "Gleba 1" é o nome de talhão mais comum do país: sem o produtor, os dois
  // extremos de um painel com várias fazendas saem como a mesma linha.
  const p = (await painel(tFranqueado)).corpo;
  assert.ok(p.resultado.melhores[0].produtor,
    'ele alcança de quem é a terra pelos pedidos que carimbam o território dele');

  const outroFq = (await dono.query(
    "select id from tenant where documento = '55555555000155'")).rows[0].id;
  const vistos = await comContexto({ tenant: outroFq }, (cx) =>
    cx.query('select count(*)::int as n from produtor_propriedade')
      .then((r) => r.rows[0].n));
  assert.equal(vistos, 0, 'franqueado sem pedido naquela terra não alcança o vínculo');
});

/* ---------------------------------------------- o painel da franqueadora */

let tFranqueadora, fqA, fqB;

test('a franqueadora enxerga a cadeia inteira que desce da rede dela', async () => {
  const fa = await criarTenant('Indústria FS', '91666666000191', 'franqueadora');
  await criarUsuario(fa, 'Diretor', 'diretor@fs.com', 'gestor');
  tFranqueadora = await entrar(req, 'diretor@fs.com');

  fqA = (await dono.query("select id from tenant where documento = '44444444000144'")).rows[0].id;
  fqB = await criarTenant('FS Norte', '92777777000192', 'franqueado');
  await dono.query(
    'insert into rede (franqueado_id, franqueadora_id) values ($1,$3),($2,$3)', [fqA, fqB, fa]);

  const p = (await painel(tFranqueadora)).corpo;
  assert.ok(p.venda.quantidadeSc > 0, 'ela vê o que a rede dela vendeu');
  assert.ok(p.resultado, 'e a safra dos talhões que descem dos pedidos da rede');
});

test('uma franqueadora não sabe das transações da outra', async () => {
  // É a regra que o desenho fixa, e o alcance pendura no carimbo do pedido:
  // "pedido cujo franqueado é meu", nunca "tudo que aconteceu no município".
  const rival = await criarTenant('Indústria Rival', '88888888000188', 'franqueadora');
  await criarUsuario(rival, 'Diretor Rival', 'rival@ind.com', 'gestor');
  const tRival = await entrar(req, 'rival@ind.com');

  const p = (await painel(tRival)).corpo;
  assert.equal(p.venda.quantidadeSc, 0);
  assert.equal(p.resultado, null);
  assert.equal(p.rede, null, 'rede vazia não vira cartão');

  const vistos = await comContexto({ tenant: rival }, (cx) =>
    cx.query('select count(*)::int as n from pedido').then((r) => r.rows[0].n));
  assert.equal(vistos, 0, 'nem um pedido da concorrente');
});

test('a rede vem aberta por franqueado, com o nome de cada um', async () => {
  // Um segundo franqueado, com território e venda própria, para haver comparação.
  await dono.query(
    'insert into territorio (municipio, uf, franqueado_id) values ($1,$2,$3)',
    ['Sinop', 'MT', fqB]);
  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'Produtor do Norte' },
  });
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Fazenda Norte', produtorId: outro.corpo.id, municipio: 'Sinop', uf: 'MT' },
  });
  const t = await req(`/cadastro/propriedades/${f.corpo.id}/talhoes`, {
    metodo: 'POST', token: tGestor, corpo: { nome: 'Chapada', areaHa: 500 },
  });
  await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: {
      numero: 'PED-FQB-1', safra: SAFRA, produtorId: outro.corpo.id,
      propriedadeId: f.corpo.id, itens: [{ cultivar: 'FS560', quantidade: 200, precoUnit: 300 }],
    },
  });
  const pl = await req('/caderno/plantios', {
    metodo: 'POST', token: tGestor,
    corpo: {
      talhaoId: t.corpo.id, safra: SAFRA, cultivar: 'FS560',
      marca: 'FS Sementes', areaHa: 500,
    },
  });
  await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
    metodo: 'POST', token: tGestor,
    corpo: { colhidoEm: '2027-03-10', produtividadeScHa: 90 },
  });

  const p = (await painel(tFranqueadora)).corpo;
  assert.ok(p.rede, 'com dois franqueados, a rede vira cartão');
  assert.equal(p.rede.length, 2);
  assert.deepEqual(p.rede.map((f2) => f2.franqueado).sort(), ['FS Norte', 'FS Sementes'],
    'ela alcança o NOME do franqueado dela, senão o painel seria uma lista de uuid');
  assert.equal(p.rede[0].mediaPonderadaScHa, 90, 'ordenada pela produtividade');
});

test('o franqueado continua vendo só o território dele, não a rede', async () => {
  const p = (await painel(tFranqueado)).corpo;
  assert.equal(p.rede, null, 'um franqueado só não tem comparação a fazer');

  const safra = (await req(`/caderno/resultado?safra=${SAFRA}`, { token: tFranqueado })).corpo;
  assert.ok(!safra.porTalhao.some((t) => t.talhao === 'Chapada'),
    'e a lavoura do outro franqueado não entra na safra dele');
});

/* ---------------------------------------------- o painel da distribuidora */

test('a distribuidora não ganha cartão de rede — ela não tem rede', async () => {
  // Ela compra de vários franqueados, então enxerga vários `franqueado_id` nos
  // pedidos dela. Sem a junção com `rede`, isso virava um cartão comparando
  // fornecedores anônimos: o nome do tenant não abre para ela, e a pergunta
  // "quem é o melhor franqueado" é de quem tem rede.
  const p = (await painel(tGestor)).corpo;
  assert.equal(p.rede, null);
  const direto = await req(`/caderno/resultado-por-franqueado?safra=${SAFRA}`, { token: tGestor });
  assert.equal(direto.status, 200);
  assert.deepEqual(direto.corpo, []);
});

test('o recorte dela é por município, e não nomeia franqueado nenhum', async () => {
  const r = await req(`/caderno/resultado-por-municipio?safra=${SAFRA}`, { token: tGestor });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.length >= 1);
  assert.ok(r.corpo.every((m) => m.municipio && m.uf));
  assert.ok(r.corpo.every((m) => !('franqueado' in m) && !('franqueadoId' in m)),
    'o município está na propriedade que ela cadastrou; o franqueado não é dela');
});

test('a franqueadora continua com o cartão de rede, e com os nomes', async () => {
  const p = (await painel(tFranqueadora)).corpo;
  assert.ok(p.rede, 'quem tem rede compara franqueado');
  assert.ok(p.rede.every((f) => f.franqueado && f.franqueado !== 'sem nome'));
});

test('um município só não vira cartão de comparação', async () => {
  const p = (await painel(tFranqueado)).corpo;
  // O franqueado deste arquivo tem território num município só.
  if (p.territorios) assert.ok(p.territorios.length > 1);
});

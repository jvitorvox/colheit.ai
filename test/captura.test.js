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

/* ------------------------------------------- a safra respondida no WhatsApp */

let talhaoDaSafra;

test('perguntar pela colheita traz o fechamento da safra', async () => {
  const t = await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba 1', areaHa: 800 },
  });
  talhaoDaSafra = t.corpo.id;
  const t2 = await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba 2', areaHa: 200 },
  });

  const plantar = async (talhaoId, safra, areaHa, scHa) => {
    const pl = await req('/caderno/plantios', {
      metodo: 'POST', token: tRevenda,
      corpo: { talhaoId, safra, cultivar: 'FS560', marca: 'FS Sementes', areaHa },
    });
    assert.equal(pl.status, 201, JSON.stringify(pl.corpo));
    if (scHa) {
      await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
        metodo: 'POST', token: tRevenda,
        corpo: { colhidoEm: '2027-03-08', produtividadeScHa: scHa },
      });
    }
  };
  await plantar(talhaoDaSafra, '25/26', 800, 55);
  await plantar(talhaoDaSafra, '26/27', 800, 60);
  await plantar(t2.corpo.id, '26/27', 200, 80);

  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu minha colheita?',
  });
  assert.equal(r.corpo.desfecho, 'respondido');
  assert.equal(r.corpo.sobre, 'safra');

  const saidas = await doGateway('/captura/saidas', null, 'GET');
  const texto = saidas.corpo.at(-1).texto;
  assert.match(texto, /Safra 26\/27/);
  assert.match(texto, /64 sc\/ha/, '(800×60 + 200×80) / 1000 — a média simples daria 70');
  assert.match(texto, /1\.000 ha colhidos/);
  assert.match(texto, /Melhor: Gleba 2, 80 sc\/ha/);
  assert.match(texto, /ponderada pela área/,
    'a mensagem é encaminhada e vira captura de tela sem contexto em volta');
});

test('a variação com a safra passada entra na mesma mensagem', async () => {
  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'como foi a safra?',
  });
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  assert.match(saidas.corpo.at(-1).texto, /\+16,4% em relação à safra 25\/26/);
});

test('pergunta de pedido continua indo para o pedido', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'cadê minha carga?',
  });
  assert.equal(r.corpo.sobre, 'pedido');
});

test('"quanto rendeu o pedido" é sobre safra — quem quer o pedido escreve cadê', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu o pedido?',
  });
  assert.equal(r.corpo.sobre, 'safra');
});

test('o que não é pergunta continua virando relato de campo', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'tem lagarta na bordadura sul',
  });
  assert.equal(r.corpo.sobre, undefined);
  assert.match(r.corpo.desfecho, /relato/);
});

test('a resposta da safra nunca dispara — ela responde', async () => {
  // Sem entrada recente não nasce saída: é o banco que recusa, não a disciplina
  // de quem escreve o gateway.
  const antes = (await doGateway('/captura/saidas', null, 'GET')).corpo.length;
  await dono.query(
    `update mensagem_whatsapp set criado_em = now() - interval '48 hours'
      where direcao = 'entrada'`);
  const depois = (await doGateway('/captura/saidas', null, 'GET')).corpo.length;
  assert.equal(depois, antes, 'nada novo apareceu na fila sozinho');
});

test('produtor sem plantio nenhum recebe resposta honesta, não um zero', async () => {
  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Wilson Kuhn' },
  });
  const tel = '5566999887766';
  await req('/auth/convites', {
    metodo: 'POST', token: tRevenda, corpo: { produtorId: outro.corpo.id, telefone: tel },
  });
  await doGateway('/captura/mensagens', {
    de: tel, para: NUMERO, tipo: 'texto', texto: 'qual foi minha produtividade?',
  });
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  assert.match(saidas.corpo.at(-1).texto, /ainda não tenho plantio registrado/i);
});

/* ------------------------------------ o consultor pergunta pelo produtor */

let telConsultor;

test('o consultor pergunta pela safra de um produtor pelo nome', async () => {
  // Ele atende muitos: o agregado da carteira diz menos que o nome que ele
  // vai visitar daqui a dez minutos.
  telConsultor = '5566999112233';
  await dono.query('update usuario set telefone = $1 where email = $2',
    [telConsultor, 'gestora@3t.com']);

  const r = await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto',
    texto: 'como foi a safra do Sabo?',
  });
  assert.equal(r.corpo.sobre, 'safra');

  const saidas = await doGateway('/captura/saidas', null, 'GET');
  const texto = saidas.corpo.at(-1).texto;
  assert.match(texto, /^José Cesar Sabo — safra 26\/27/,
    'a resposta abre com o nome de quem ele perguntou');
  assert.match(texto, /64 sc\/ha/);
  assert.match(texto, /ponderada pela área/);
});

test('nome que casa com mais de um não vira chute', async () => {
  // Responder com o número do vizinho é pior do que perguntar de novo.
  await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'José Antônio Sabo Filho' },
  });
  await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu a lavoura do Sabo?',
  });
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  const texto = saidas.corpo.at(-1).texto;
  assert.match(texto, /Achei mais de um/);
  assert.match(texto, /José Cesar Sabo/);
  assert.match(texto, /José Antônio Sabo Filho/);
});

test('sem nome no texto, ele recebe a carteira inteira', async () => {
  await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'como foi a safra?',
  });
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  assert.match(saidas.corpo.at(-1).texto, /^Safra 26\/27/,
    'sem nome não há a quem atribuir — vale o que ele enxerga inteiro');
});

test('palavra de pergunta não é nome de produtor', async () => {
  // Sem a lista de ruído, "safra" e "colheita" procurariam produtor e
  // achariam qualquer um cujo nome contivesse a palavra.
  const r = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Fazenda Boa Colheita' },
  });
  assert.equal(r.status, 201);
  await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'como foi a colheita?',
  });
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  assert.match(saidas.corpo.at(-1).texto, /^Safra 26\/27/,
    'a pergunta genérica continua genérica');
});

test('o produtor não procura nome nenhum — ele fala de uma lavoura só', async () => {
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'como foi a safra do Sabo?',
  });
  assert.equal(r.corpo.sobre, 'safra');
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  assert.match(saidas.corpo.at(-1).texto, /^Safra 26\/27/,
    'procurar nome no texto dele só criaria chance de errar');
});

test('o consultor não alcança produtor fora do que a política deixa', async () => {
  const outra = await criarTenant('Agro Sul', '33333333000133', 'distribuidor');
  await criarUsuario(outra, 'Gestor Sul', 'gestor@sul.com', 'gestor');
  const tOutra = await entrar(req, 'gestor@sul.com');
  await req('/cadastro/produtores', {
    metodo: 'POST', token: tOutra, corpo: { nome: 'Sabo da Concorrente' },
  });

  await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'safra do Sabo da Concorrente',
  });
  const saidas = await doGateway('/captura/saidas', null, 'GET');
  assert.doesNotMatch(saidas.corpo.at(-1).texto, /Concorrente/,
    'a busca não sabe de carteira — quem limita é a política, e ela limita');
});

/* --------------------------------- o produtor pergunta pelo talhão dele */

test('o produtor pergunta pela gleba, e recebe a gleba', async () => {
  // Ele tem uma lavoura só; o que varia dentro dela é o talhão. É o mesmo
  // gesto do consultor nomeando produtor.
  const r = await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'e a Gleba 2, quanto rendeu?',
  });
  assert.equal(r.corpo.sobre, 'safra');
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /^Gleba 2: 80 sc\/ha na safra 26\/27/);
  assert.match(texto, /em relação à média da sua lavoura/);
  assert.match(texto, /ponderada pela área/);
});

test('"Gleba 2" não traz a Gleba 1 junto', async () => {
  // O número tem um caractere e não entra nos termos: sem casar o nome INTEIRO
  // dentro da frase, "gleba" pegaria as duas e a resposta viraria "qual delas?".
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.doesNotMatch(texto, /Qual deles/);
  assert.doesNotMatch(texto, /Gleba 1/);
});

test('um pedaço do nome também acha — "pivô" é "Pivô do fundo"', async () => {
  const t = await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Pivô do fundo', areaHa: 500 },
  });
  const pl = await req('/caderno/plantios', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      talhaoId: t.corpo.id, safra: '26/27', cultivar: 'FS560',
      marca: 'FS Sementes', areaHa: 500,
    },
  });
  await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
    metodo: 'POST', token: tRevenda,
    corpo: { colhidoEm: '2027-03-08', produtividadeScHa: 52.4 },
  });

  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu o pivô?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /^Pivô do fundo: 52,4 sc\/ha/);
  assert.match(texto, /^-/m, 'abaixo da média da lavoura dele');
});

test('a pergunta genérica continua genérica', async () => {
  // Sem termo sobrando depois do ruído, a busca de talhão tem de devolver
  // NADA — e não casar com todos, que era o efeito de procurar por vazio.
  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu minha colheita?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /^Safra 26\/27/);
  assert.doesNotMatch(texto, /Qual deles/);
});

test('talhão plantado e não colhido responde isso, e não um número', async () => {
  const t = await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Quadra Nova', areaHa: 300 },
  });
  await req('/caderno/plantios', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      talhaoId: t.corpo.id, safra: '26/27', cultivar: 'FS2B393',
      marca: 'FS Sementes', areaHa: 300,
    },
  });
  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu a Quadra Nova?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /Quadra Nova: plantado na safra 26\/27 com FS2B393/);
  assert.match(texto, /colheita ainda não registrada/);
});

test('o talhão de outro produtor não é alcançável pelo nome', async () => {
  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Wilson Kuhn' },
  });
  const faz = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: 'Fazenda Kuhn', produtorId: outro.corpo.id, municipio: 'Sinop', uf: 'MT' },
  });
  await req(`/cadastro/propriedades/${faz.corpo.id}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Chapada do Kuhn', areaHa: 700 },
  });

  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu a Chapada do Kuhn?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.doesNotMatch(texto, /Chapada/,
    'a busca não sabe de dono — quem limita é a política, e ela limita');
  assert.match(texto, /^Safra 26\/27/);
});

/* ------------------------- a vizinhança na resposta do consultor */

test('a safra que o consultor pede vem com a região do produtor', async () => {
  // Cinco vizinhos no mesmo município, para o piso fechar.
  for (let i = 1; i <= 5; i++) {
    const p = await req('/cadastro/produtores', {
      metodo: 'POST', token: tRevenda, corpo: { nome: `Vizinho do Sabo ${i}` },
    });
    const f = await req('/cadastro/propriedades', {
      metodo: 'POST', token: tRevenda,
      corpo: {
        nome: `Fazenda Vizinho ${i}`, produtorId: p.corpo.id,
        municipio: 'Sorriso', uf: 'MT', areaHa: 400,
      },
    });
    const t = await req(`/cadastro/propriedades/${f.corpo.id}/talhoes`, {
      metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba única', areaHa: 400 },
    });
    const pl = await req('/caderno/plantios', {
      metodo: 'POST', token: tRevenda,
      corpo: {
        talhaoId: t.corpo.id, safra: '26/27', cultivar: 'FS560',
        marca: 'FS Sementes', areaHa: 400,
      },
    });
    await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
      metodo: 'POST', token: tRevenda,
      corpo: { colhidoEm: '2027-03-08', produtividadeScHa: 50 + i },
    });
  }

  await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'como foi a safra do Cesar?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /^José Cesar Sabo — safra/);
  assert.match(texto, /outros produtores de Sorriso que estão aqui/,
    'é o que ele vai dizer na porteira daqui a dez minutos');
  assert.match(texto, /ponderada pela área/);
});

test('produtor nomeado sem plantio não derruba a resposta', async () => {
  // `linhaDoBenchmark` recebe nulo neste caminho; sem guarda, a mensagem
  // inteira morria por causa de quem não tem lavoura registrada.
  await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Genoveva Semlavoura' },
  });
  const r = await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'safra da Genoveva?',
  });
  assert.equal(r.corpo.sobre, 'safra');
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /Genoveva Semlavoura — não tenho plantio registrado na safra/,
    "zero talhão é ausência de registro, não safra fracassada");
});

test('a carteira sem nome não ganha comparação — ela atravessa municípios', async () => {
  await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'como foi a safra?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /^Safra 26\/27/);
  assert.doesNotMatch(texto, /outros produtores/,
    'a régua regional é por município; numa carteira viraria lista');
});

/* --------------------- a vizinhança na resposta do PRODUTOR */
//
// O caminho do produtor é o que carrega a regra de privacidade, e era o que
// estava sem teste no nível da mensagem: a linha existia e funcionava, mas
// nada impedia que sumisse — ou, pior, que aparecesse abaixo do piso.

test('o produtor NÃO recebe a região enquanto não houver vizinhos bastante', async () => {
  // Um produtor sozinho num município novo. O teste não pode depender de
  // quantos vizinhos os testes anteriores criaram — e Água Boa está vazia.
  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Isolado do Cerrado' },
  });
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      nome: 'Fazenda Isolada', produtorId: p.corpo.id,
      municipio: 'Água Boa', uf: 'MT', areaHa: 700,
    },
  });
  const t = await req(`/cadastro/propriedades/${f.corpo.id}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba só', areaHa: 700 },
  });
  const pl = await req('/caderno/plantios', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      talhaoId: t.corpo.id, safra: '26/27', cultivar: 'FS560',
      marca: 'FS Sementes', areaHa: 700,
    },
  });
  await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
    metodo: 'POST', token: tRevenda,
    corpo: { colhidoEm: '2027-03-08', produtividadeScHa: 59 },
  });

  const tel = '5566999001122';
  await req('/auth/convites', {
    metodo: 'POST', token: tRevenda, corpo: { produtorId: p.corpo.id, telefone: tel },
  });
  await doGateway('/captura/mensagens', {
    de: tel, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu minha colheita?',
  });

  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /^Safra 26\/27/);
  // Água Boa não tem cinco; o estado tem, e é para lá que a régua sobe — então
  // o que se verifica é que ela NUNCA fala do município abaixo do piso.
  assert.doesNotMatch(texto, /produtores de Água Boa/,
    'município abaixo do piso nunca vira média — sobe para o estado ou some');
});

test('com cinco vizinhos, a região entra na mensagem dele', async () => {
  const municipio = (await req('/cadastro/propriedades', { token: tRevenda }))
    .corpo.find((p) => p.id === propriedadeId).municipio;

  for (let i = 1; i <= 5; i++) {
    const p = await req('/cadastro/produtores', {
      metodo: 'POST', token: tRevenda, corpo: { nome: `Vizinho de porteira ${i}` },
    });
    const f = await req('/cadastro/propriedades', {
      metodo: 'POST', token: tRevenda,
      corpo: {
        nome: `Fazenda Porteira ${i}`, produtorId: p.corpo.id,
        municipio, uf: 'MT', areaHa: 400,
      },
    });
    const t = await req(`/cadastro/propriedades/${f.corpo.id}/talhoes`, {
      metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba única', areaHa: 400 },
    });
    const pl = await req('/caderno/plantios', {
      metodo: 'POST', token: tRevenda,
      corpo: {
        talhaoId: t.corpo.id, safra: '26/27', cultivar: 'FS560',
        marca: 'FS Sementes', areaHa: 400,
      },
    });
    await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
      metodo: 'POST', token: tRevenda,
      corpo: { colhidoEm: '2027-03-08', produtividadeScHa: 50 + i },
    });
  }

  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'quanto rendeu minha colheita?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  const linhas = texto.split('\n');

  assert.match(texto, /outros produtores de .+ que estão aqui/);
  assert.match(texto, /\(\d+(,\d+)? sc\/ha\)/, 'a média da região vem no número');
  // "que estão aqui" não é enfeite: não é a média do município, é a de quem
  // está no sistema. Sem isso o produtor lê um número de outra ordem.
  assert.match(texto, /que estão aqui/);

  // As duas comparações ficam juntas, e a base fecha a mensagem.
  assert.match(linhas[1], /em relação à safra/);
  assert.match(linhas[2], /outros produtores/);
  assert.match(linhas.at(-1), /^Média ponderada pela área colhida\.$/);
});

test('a régua dele exclui ele mesmo — nunca se compara consigo', async () => {
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  const daRegiao = Number(texto.match(/\((\d+(?:,\d+)?) sc\/ha\)/)[1].replace(',', '.'));
  const dele = Number(texto.match(/^Safra [\d/]+: (\d+(?:,\d+)?) sc\/ha/)[1].replace(',', '.'));
  assert.notEqual(daRegiao, dele, 'se ele entrasse na própria média, os dois convergiriam');

  const pelaRota = await req('/caderno/benchmark', { token: tProdutor });
  assert.equal(pelaRota.corpo.mediaPonderadaScHa, daRegiao,
    'a mensagem e o portal contam a mesma coisa');
});

test('a resposta de talhão não traz a região — são duas comparações diferentes', async () => {
  // Talhão contra a lavoura dele numa mensagem; lavoura contra a vizinhança em
  // outra. Juntar as duas na mesma mensagem confundiria as réguas.
  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'e a Gleba 2, quanto rendeu?',
  });
  const texto = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;
  assert.match(texto, /^Gleba 2:/);
  assert.match(texto, /média da sua lavoura/);
  assert.doesNotMatch(texto, /outros produtores/);
});

test('a região que ele vê é a mesma que o consultor leva à porteira', async () => {
  // O produtor e o consultor perguntam pela mesma lavoura por caminhos
  // diferentes; a régua tem de ser a mesma, senão um dos dois está errado na
  // frente do outro.
  await doGateway('/captura/mensagens', {
    de: TEL, para: NUMERO, tipo: 'texto', texto: 'como foi a safra?',
  });
  const dele = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;

  await doGateway('/captura/mensagens', {
    de: telConsultor, para: NUMERO, tipo: 'texto', texto: 'como foi a safra do Cesar?',
  });
  const doConsultor = (await doGateway('/captura/saidas', null, 'GET')).corpo.at(-1).texto;

  const regiao = (t) => t.match(/\((\d+(?:,\d+)?) sc\/ha\)/)[1];
  assert.equal(regiao(doConsultor), regiao(dele));
});

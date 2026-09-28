// O portal: a casca que o navegador baixa, e o que a sessão do produtor lê.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { comContexto } from '../api/src/contexto.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const TEL = '5566999660044';
let req, base, fechar, tRevenda, tProdutor, produtorId, propriedadeId;

const buscar = (caminho) => fetch(base + caminho);

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ({ req, base, fechar } = await subirApi());
  tRevenda = await entrar(req, 'gestora@3t.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 840 },
  });
  propriedadeId = f.corpo.id;
  await req(`/cadastro/propriedades/${propriedadeId}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Gleba 1', areaHa: 420 },
  });

  await req('/auth/convites', { metodo: 'POST', token: tRevenda, corpo: { produtorId, telefone: TEL } });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: cod.corpo.codigo },
  });
  tProdutor = ent.corpo.token;
});

after(async () => { await fechar(); await encerrar(); });

/* -------------------------------------------------------------- a casca */

test('a casca do PWA é servida pela própria API — mesma origem', async () => {
  const r = await buscar('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<link rel="manifest" href="\/manifest.json">/);
  assert.match(html, /src="\/app.js"/);
});

test('o manifest aponta para ícones que existem de verdade', async () => {
  const m = await (await buscar('/manifest.json')).json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  for (const icone of m.icons) {
    const r = await buscar(icone.src);
    assert.equal(r.status, 200, `${icone.src} não existe`);
    assert.match(r.headers.get('content-type'), /image\/png/);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'sem maskable o ícone sai cortado');
});

test('o service worker é servido na raiz — é o que dá escopo a tudo', async () => {
  const r = await buscar('/sw.js');
  assert.equal(r.status, 200);
  const js = await r.text();
  assert.match(js, /addEventListener\('push'/, 'sem isso o aviso não aparece');
  assert.match(js, /notificationclick/, 'tocar no aviso tem que abrir o pedido');
});

/* ------------------------------------------------------ o que o portal lê */

test('o produtor lê a própria lavoura, com os talhões dentro', async () => {
  const r = await req('/cadastro/minha-lavoura', { token: tProdutor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.length, 1);
  assert.equal(r.corpo[0].nome, 'Fazenda Sabo');
  assert.equal(r.corpo[0].meu_papel, 'proprietario');
  assert.deepEqual(r.corpo[0].talhoes.map((t) => t.nome), ['Gleba 1']);
});

test('a lavoura não é porta dos fundos para o resto do cadastro', async () => {
  const r = await req('/cadastro/produtores', { token: tProdutor });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('a empresa não entra pela rota do portal', async () => {
  const r = await req('/cadastro/minha-lavoura', { token: tRevenda });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /portal do produtor/);
});

test('a jornada inteira do portal, numa sessão só', async () => {
  const eu = await req('/auth/eu', { token: tProdutor });
  assert.equal(eu.corpo.tipo, 'produtor');
  assert.equal(eu.corpo.vinculos.length, 1);

  const ped = await req('/pedidos', {
    metodo: 'POST', token: tRevenda,
    corpo: { numero: 'PD-0900', safra: '26/27', produtorId, propriedadeId,
      itens: [{ cultivar: 'FS695', quantidade: 1200 }] },
  });
  await req(`/pedidos/${ped.corpo.id}/avancar`, { metodo: 'POST', token: tRevenda, corpo: {} });

  const lista = await req('/pedidos', { token: tProdutor });
  assert.equal(lista.corpo.length, 1);

  const detalhe = await req(`/pedidos/${ped.corpo.id}`, { token: tProdutor });
  assert.equal(detalhe.corpo.etapa, 2);
  assert.ok(Array.isArray(detalhe.corpo.historico), 'a tela de detalhe desenha o histórico');

  const chave = await buscar('/push/chave-publica');
  assert.equal(chave.status, 200, 'o app pede a chave antes de assinar');

  const lavoura = await req('/cadastro/minha-lavoura', { token: tProdutor });
  assert.equal(lavoura.corpo.length, 1);
});

/* ------------------------------------------------------ a tela de visitas */

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

let visitaComFoto;

test('a visita do consultor aparece para o produtor, com a foto do talhão', async () => {
  const foto = await fetch(`${base}/midia`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', authorization: `Bearer ${tRevenda}` },
    body: JPEG,
  }).then((r) => r.json());

  const v = await req('/visitas', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      produtorId, canal: 'app', duracaoSeg: 38, estagio: 'V6', estande: 58,
      observacao: 'Estande bom, lagarta na bordadura.', midiaIds: [foto.id],
    },
  });
  assert.equal(v.status, 201);
  visitaComFoto = v.corpo.id;

  const minhas = await req('/visitas', { token: tProdutor });
  assert.equal(minhas.status, 200);
  const lida = minhas.corpo.find((x) => x.id === visitaComFoto);
  assert.ok(lida, 'ele vê quem esteve na lavoura dele');

  // O que a tela mostra tem de vir na resposta — senão a tela inventa.
  assert.equal(lida.consultor, 'Gestora', 'quem entrou na porteira tem nome');
  assert.equal(lida.estagio, 'V6');
  assert.match(lida.observacao, /lagarta/);
  assert.deepEqual(lida.fotos, [foto.id]);
});

test('e ele abre a foto — a lavoura é dele, a foto dela também', async () => {
  const lida = (await req('/visitas', { token: tProdutor })).corpo
    .find((x) => x.id === visitaComFoto);
  const r = await fetch(`${base}/midia/${lida.fotos[0]}`, {
    headers: { authorization: `Bearer ${tProdutor}` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.match(r.headers.get('cache-control'), /private/);
});

test('visita de outro produtor não entra na lista dele', async () => {
  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Wilson Kuhn' },
  });
  const alheia = await req('/visitas', {
    metodo: 'POST', token: tRevenda,
    corpo: { produtorId: outro.corpo.id, canal: 'app', duracaoSeg: 20 },
  });
  assert.equal(alheia.status, 201);

  const minhas = await req('/visitas', { token: tProdutor });
  assert.ok(!minhas.corpo.some((x) => x.id === alheia.corpo.id));
  assert.ok(minhas.corpo.every((x) => x.produtor === 'José Cesar Sabo'));
});

test('ele lê a visita e não escreve nenhuma', async () => {
  const r = await req('/visitas', {
    metodo: 'POST', token: tProdutor, corpo: { produtorId, canal: 'app' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('a tela de visitas existe no portal, e o menu leva até ela', async () => {
  const js = await (await buscar('/app.js')).text();
  assert.match(js, /telaVisitas/);
  assert.match(js, /'#\/visitas'/, 'sem entrada no menu a tela é inalcançável');
  // A duração é a medição da H1 — é do nosso processo, não do produtor.
  assert.doesNotMatch(js.slice(js.indexOf('async function telaVisitas'),
    js.indexOf('/* ------------------------------------------------------------------ apoio */')),
  /duracao_seg/, 'o portal não mostra quanto o consultor levou para registrar');
});

test('o que a tela consulta, o service worker guarda', async () => {
  const js = await (await buscar('/sw.js')).text();
  for (const rota of ['/visitas', '/caderno']) {
    assert.match(js, new RegExp(`'${rota}'`), `sem ${rota} a tela fica em branco sem sinal`);
  }
});

test('a casca guarda tudo que o portal carrega', async () => {
  // Invariante que dá para verificar, ao contrário da virada de VERSAO: um
  // arquivo novo no HTML e esquecido aqui faz o app abrir quebrado sem sinal.
  const html = await (await buscar('/')).text();
  const js = await (await buscar('/sw.js')).text();
  const arquivos = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(arquivos.length >= 3);
  for (const a of arquivos) {
    if (a.endsWith('.png') || a.endsWith('.svg')) continue;   // ícone é do manifest
    assert.match(js, new RegExp(`'${a}'`), `${a} precisa entrar em ARQUIVOS`);
  }
});

test('a abertura em usuario é só para quem visitou ESTE produtor', async () => {
  // A política abre a linha do consultor que esteve na lavoura dele. Não pode
  // abrir a do resto da empresa — nem a de quem visitou outro produtor.
  const { rows } = await dono.query('select id, nome from usuario');
  assert.ok(rows.length >= 1);

  const vistos = await comContexto({ produtor: produtorId }, (cx) =>
    cx.query('select nome from usuario').then((r) => r.rows.map((x) => x.nome)));
  assert.deepEqual(vistos, ['Gestora'], 'só quem registrou visita para ele');

  const semVisita = await criarUsuario(
    (await dono.query('select tenant_id from usuario limit 1')).rows[0].tenant_id,
    'Nunca Foi', 'nuncafoi@3t.com', 'consultor');
  assert.ok(semVisita);
  const depois = await comContexto({ produtor: produtorId }, (cx) =>
    cx.query('select nome from usuario').then((r) => r.rows.map((x) => x.nome)));
  assert.deepEqual(depois, ['Gestora'], 'quem não foi ao campo continua invisível');
});

/* ------------------------------------------------- o caderno de campo dele */

let talhaoId;

test('o produtor lê o caderno de campo da terra dele', async () => {
  const t = (await req(`/cadastro/propriedades/${propriedadeId}/talhoes`,
    { token: tRevenda })).corpo;
  talhaoId = t[0].id;

  const pl = await req('/caderno/plantios', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      talhaoId, safra: '26/27', cultivar: 'FS560', marca: 'FS Sementes',
      areaHa: 420, lote: '24-0904', populacao: 320,
    },
  });
  assert.equal(pl.status, 201);
  await req(`/caderno/plantios/${pl.corpo.id}/colheita`, {
    metodo: 'POST', token: tRevenda,
    corpo: { colhidoEm: '2027-03-12', produtividadeScHa: 68.4 },
  });

  const meu = await req('/caderno/plantios', { token: tProdutor });
  assert.equal(meu.status, 200);
  const linha = meu.corpo.find((p) => p.id === pl.corpo.id);
  assert.ok(linha, 'a lavoura é dele — a camada técnica é compartilhada');
  assert.equal(linha.cultivar, 'FS560');
  assert.equal(linha.marca, 'FS Sementes');
  assert.equal(linha.lote, '24-0904', 'o lote é a garantia do que ele plantou');
  assert.equal(Number(linha.produtividade_sc_ha), 68.4);
});

test('o caderno de outro produtor não entra no dele', async () => {
  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Marli Trevisan' },
  });
  const faz = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: 'Sítio Trevisan', produtorId: outro.corpo.id, municipio: 'Sinop', uf: 'MT' },
  });
  const t = await req(`/cadastro/propriedades/${faz.corpo.id}/talhoes`, {
    metodo: 'POST', token: tRevenda, corpo: { nome: 'Quadra A', areaHa: 90 },
  });
  const alheio = await req('/caderno/plantios', {
    metodo: 'POST', token: tRevenda,
    corpo: { talhaoId: t.corpo.id, safra: '26/27', cultivar: 'NS7709', marca: 'Nidera' },
  });
  assert.equal(alheio.status, 201);

  const meu = await req('/caderno/plantios', { token: tProdutor });
  assert.ok(!meu.corpo.some((p) => p.id === alheio.corpo.id));
  assert.ok(meu.corpo.every((p) => p.produtor === 'José Cesar Sabo'));
});

test('ele lê o caderno e não escreve nele — quem fecha o registro é o consultor', async () => {
  const r = await req('/caderno/plantios', {
    metodo: 'POST', token: tProdutor,
    corpo: { talhaoId, safra: '26/27', cultivar: 'FS560', marca: 'FS Sementes' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('o desempenho por cultivar é o da terra dele, não o da revenda', async () => {
  const dele = await req('/caderno/desempenho', { token: tProdutor });
  assert.equal(dele.status, 200);
  assert.deepEqual(dele.corpo.map((d) => d.cultivar), ['FS560'],
    'a colheita do vizinho não entra na média dele');
  assert.equal(Number(dele.corpo[0].media_sc_ha), 68.4);
});

test('o share por marca continua fechado para o portal', async () => {
  // Desempenho é da lavoura dele; share é leitura comercial da revenda.
  const r = await req('/caderno/share?safra=26/27', { token: tProdutor });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('a tela do caderno existe, e não mostra se a semente é nossa', async () => {
  const js = await (await buscar('/app.js')).text();
  assert.match(js, /telaCaderno/);
  assert.match(js, /'#\/caderno'/, 'sem entrada no menu a tela é inalcançável');

  const tela = js.slice(js.indexOf('async function telaCaderno'),
    js.indexOf('/* ------------------------------------------------------------------ apoio */'));
  assert.doesNotMatch(tela, /\.nossa/,
    'marcar a semente como nossa é leitura comercial; não diz nada a quem plantou');
});

test('data sem hora chega como dia, não como instante em UTC', async () => {
  // `2026-10-12T00:00:00.000Z` desenhava 11/10 em qualquer fuso a oeste de
  // Greenwich — um dia antes, em toda data do sistema, e silenciosamente.
  await req('/caderno/plantios', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      talhaoId, safra: '27/28', cultivar: 'FS560', marca: 'FS Sementes',
      plantadoEm: '2027-10-12',
    },
  });

  const meu = await req('/caderno/plantios', { token: tProdutor });
  const com = meu.corpo.find((p) => p.safra === '27/28');
  assert.equal(com.plantado_em, '2027-10-12',
    'dia de plantio é casa no calendário, não instante — não leva fuso junto');

  const comColheita = meu.corpo.find((p) => p.colhido_em);
  assert.match(comColheita.colhido_em, /^\d{4}-\d{2}-\d{2}$/);

  // O que é instante de verdade continua sendo instante.
  const visitas = await req('/visitas', { token: tProdutor });
  if (visitas.corpo.length) assert.match(visitas.corpo[0].em, /T\d{2}:\d{2}/);
});

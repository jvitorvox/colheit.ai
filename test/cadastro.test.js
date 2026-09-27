// Módulo cadastro pela porta HTTP — incluindo o que ele precisa RECUSAR.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { criarApp } from '../api/src/server.js';

// CPFs com dígito verificador correto — os inválidos são testados adiante.
const CPF_A = '12345678909';
const CPF_B = '98765432100';
const CNPJ = '11222333000181';

let servidor, base, alfa, beta, gestor, ana;

const req = (caminho, { metodo = 'GET', corpo, ctx } = {}) =>
  fetch(base + caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(ctx?.tenant ? { 'x-tenant-id': ctx.tenant } : {}),
      ...(ctx?.usuario ? { 'x-usuario-id': ctx.usuario } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }));

before(async () => {
  await migrar({ silencioso: true });
  await dono.query('truncate tenant, produtor, propriedade cascade');

  const criaTenant = async (nome, doc) => (await dono.query(
    `insert into tenant (nome, documento, tipo) values ($1,$2,'revenda') returning id`,
    [nome, doc])).rows[0].id;
  alfa = await criaTenant('Revenda Alfa', '11111111000111');
  beta = await criaTenant('Revenda Beta', '22222222000122');

  const criaUsuario = async (nome, email, papel, tenant) => (await dono.query(
    `insert into usuario (tenant_id, nome, email, papel) values ($1,$2,$3,$4) returning id`,
    [tenant, nome, email, papel])).rows[0].id;
  gestor = await criaUsuario('Gestora', 'gestora@alfa.com', 'gestor', alfa);
  ana = await criaUsuario('Ana', 'ana@alfa.com', 'consultor', alfa);

  servidor = criarApp().listen(0);
  await new Promise((ok) => servidor.once('listening', ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((ok) => servidor.close(ok));
  await encerrar();
});

test('sem tenant no cabeçalho, a porta nem abre', async () => {
  const r = await req('/cadastro/produtores');
  assert.equal(r.status, 401);
});

test('cadastra produtor sem documento — é o caso do campo', async () => {
  const r = await req('/cadastro/produtores', {
    metodo: 'POST', ctx: { tenant: alfa, usuario: ana },
    corpo: { nome: 'Produtor Sem Documento' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.nome, 'Produtor Sem Documento');
  assert.deepEqual(r.corpo.documentos, []);
});

test('recusa CPF com dígito verificador errado', async () => {
  const r = await req('/cadastro/produtores', {
    metodo: 'POST', ctx: { tenant: alfa },
    corpo: { nome: 'Fulano', documentos: [{ tipo: 'cpf', valor: '11122233344' }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /CPF inválido/);
  assert.equal(r.corpo.campo, 'documentos[0].valor');
});

test('aceita CPF formatado e guarda só os dígitos', async () => {
  const r = await req('/cadastro/produtores', {
    metodo: 'POST', ctx: { tenant: alfa },
    corpo: { nome: 'José Cesar Sabo', documentos: [{ tipo: 'cpf', valor: '123.456.789-09' }] },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.corpo.documentos, [{ tipo: 'cpf', valor: CPF_A }]);
});

test('porta única: o mesmo CPF por outra revenda devolve o mesmo produtor', async () => {
  const naBeta = await req('/cadastro/produtores', {
    metodo: 'POST', ctx: { tenant: beta },
    corpo: { nome: 'J. C. Sabo', documentos: [{ tipo: 'cpf', valor: CPF_A }] },
  });
  assert.equal(naBeta.status, 201);

  const naAlfa = await req('/cadastro/produtores', { ctx: { tenant: alfa } });
  const oMesmo = naAlfa.corpo.find((p) => p.nome === 'José Cesar Sabo');
  assert.equal(naBeta.corpo.id, oMesmo.id, 'é a mesma pessoa, com dois vínculos');

  const { rows } = await dono.query('select count(*)::int as n from produtor');
  assert.equal(rows[0].n, 2, 'um com documento, um sem — não três');
});

test('cada revenda enxerga só a carteira dela', async () => {
  const naBeta = await req('/cadastro/produtores', { ctx: { tenant: beta } });
  assert.equal(naBeta.corpo.length, 1, 'a Beta não vê o produtor sem documento da Alfa');
});

test('o consultor enxerga só quem ele cadastrou', async () => {
  const daAna = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: ana } });
  assert.deepEqual(daAna.corpo.map((p) => p.nome), ['Produtor Sem Documento']);

  const daGestora = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: gestor } });
  assert.equal(daGestora.corpo.length, 2, 'o gestor vê a empresa inteira');
});

test('autorizar amplia a carteira do consultor', async () => {
  const todos = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: gestor } });
  const outro = todos.corpo.find((p) => p.nome === 'José Cesar Sabo');

  const r = await req('/cadastro/carteira', {
    metodo: 'POST', ctx: { tenant: alfa, usuario: gestor },
    corpo: { usuarioId: ana, produtorId: outro.id },
  });
  assert.equal(r.status, 201);

  const daAna = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: ana } });
  assert.equal(daAna.corpo.length, 2);
});

test('fusão escolhe quem tem documento e guarda o ponteiro', async () => {
  const todos = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: gestor } });
  const semDoc = todos.corpo.find((p) => p.documentos.length === 0);
  const comDoc = todos.corpo.find((p) => p.documentos.length > 0);

  const r = await req('/cadastro/produtores/fundir', {
    metodo: 'POST', ctx: { tenant: alfa, usuario: gestor },
    corpo: { produtorA: semDoc.id, produtorB: comDoc.id },
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.vencedor, comDoc.id, 'vence quem tem documento');

  const { rows } = await dono.query('select fundido_em from produtor where id = $1', [semDoc.id]);
  assert.equal(rows[0].fundido_em, comDoc.id, 'ninguém é apagado');

  const depois = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: gestor } });
  assert.equal(depois.corpo.length, 1, 'o fundido some da lista');
});

test('propriedade nasce junto com quem a opera', async () => {
  const todos = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: gestor } });
  const dono_ = todos.corpo[0];

  const r = await req('/cadastro/propriedades', {
    metodo: 'POST', ctx: { tenant: alfa, usuario: gestor },
    corpo: {
      nome: 'Fazenda Boa Vista', produtorId: dono_.id, papel: 'proprietario',
      municipio: 'Sorriso', uf: 'MT', car: 'MT-5107925-ABC', areaHa: 840.5,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  assert.equal(r.corpo.operadores.length, 1);
  assert.equal(r.corpo.operadores[0].papel, 'proprietario');
});

test('arrendatário entra como segundo operador da mesma terra', async () => {
  const props = await req('/cadastro/propriedades', { ctx: { tenant: alfa, usuario: gestor } });
  const fazenda = props.corpo[0];

  const arrend = await req('/cadastro/produtores', {
    metodo: 'POST', ctx: { tenant: alfa, usuario: gestor },
    corpo: { nome: 'Quem Planta', documentos: [{ tipo: 'cnpj', valor: CNPJ }] },
  });

  const r = await req(`/cadastro/propriedades/${fazenda.id}/operadores`, {
    metodo: 'POST', ctx: { tenant: alfa, usuario: gestor },
    corpo: { produtorId: arrend.corpo.id, papel: 'arrendatario' },
  });
  assert.equal(r.status, 201);

  const depois = await req('/cadastro/propriedades', { ctx: { tenant: alfa, usuario: gestor } });
  assert.equal(depois.corpo[0].operadores.length, 2, 'dono e arrendatário, na mesma fazenda');
});

test('talhão entra pela propriedade', async () => {
  const props = await req('/cadastro/propriedades', { ctx: { tenant: alfa, usuario: gestor } });
  const fazenda = props.corpo[0];

  const r = await req(`/cadastro/propriedades/${fazenda.id}/talhoes`, {
    metodo: 'POST', ctx: { tenant: alfa, usuario: gestor },
    corpo: { nome: 'T-01', areaHa: 120 },
  });
  assert.equal(r.status, 201);

  const lista = await req(`/cadastro/propriedades/${fazenda.id}/talhoes`, { ctx: { tenant: alfa, usuario: gestor } });
  assert.deepEqual(lista.corpo.map((t) => t.nome), ['T-01']);
});

test('quem não tem vínculo com ninguém da terra não enxerga a terra', async () => {
  const gama = (await dono.query(
    `insert into tenant (nome, documento, tipo)
     values ('Sem Relação','33333333000133','revenda') returning id`)).rows[0].id;

  const props = await req('/cadastro/propriedades', { ctx: { tenant: gama } });
  assert.deepEqual(props.corpo, []);
});

test('a revenda que compartilha o produtor enxerga a lavoura dele — e isso é proposital', async () => {
  // A Beta tem vínculo com José Cesar Sabo (porta única), e ele é o proprietário
  // da fazenda que a Alfa cadastrou. Ela passa a enxergar a terra dele.
  //
  // Não é vazamento: a lavoura é do PRODUTOR, não da revenda, e é a camada
  // técnica que o desenho diz ser compartilhada. O que a Beta não pode ver é a
  // camada comercial da Alfa — pedido, funil, share estimado —, e essa mora em
  // produtor_vinculo, onde o corte por tenant continua valendo.
  const props = await req('/cadastro/propriedades', { ctx: { tenant: beta } });
  assert.equal(props.corpo.length, 1);
  assert.equal(props.corpo[0].nome, 'Fazenda Boa Vista');

  const meus = await req('/cadastro/produtores', { ctx: { tenant: beta } });
  assert.equal(meus.corpo.length, 1, 'mas a carteira dela continua sendo só a dela');
});

test('não dá para pendurar terra em produtor de outro tenant', async () => {
  const daAlfa = await req('/cadastro/produtores', { ctx: { tenant: alfa, usuario: gestor } });
  const alheio = daAlfa.corpo.find((p) => p.nome === 'Quem Planta');

  const r = await req('/cadastro/propriedades', {
    metodo: 'POST', ctx: { tenant: beta },
    corpo: { nome: 'Fazenda Invasora', produtorId: alheio.id },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /vínculo/);
});

test('recusa entrada malformada antes de chegar ao banco', async () => {
  const semNome = await req('/cadastro/produtores', {
    metodo: 'POST', ctx: { tenant: alfa }, corpo: {},
  });
  assert.equal(semNome.status, 400);
  assert.equal(semNome.corpo.campo, 'nome');

  const papelErrado = await req('/cadastro/propriedades', {
    metodo: 'POST', ctx: { tenant: alfa },
    corpo: { nome: 'X', produtorId: '00000000-0000-0000-0000-000000000000', papel: 'invasor' },
  });
  assert.equal(papelErrado.status, 400);
  assert.equal(papelErrado.corpo.campo, 'papel');

  const idTorto = await req('/cadastro/produtores/nao-e-uuid', { ctx: { tenant: alfa } });
  assert.equal(idTorto.status, 400);
});

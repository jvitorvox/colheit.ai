// Módulo cadastro pela porta HTTP — incluindo o que ele precisa RECUSAR.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from "../api/src/db.js";
import { migrar } from "../api/src/migrar.js";
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from "./ajuda.js";

// CPFs com dígito verificador correto — os inválidos são testados adiante.
const CPF_A = '12345678909';
const CPF_B = '98765432100';
const CNPJ = '11222333000181';

let req, fechar, alfa, beta, ana, tGestor, tAna, tBeta;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  alfa = await criarTenant("Revenda Alfa", "11111111000111");
  beta = await criarTenant("Revenda Beta", "22222222000122");
  await criarUsuario(alfa, "Gestora", "gestora@alfa.com", "gestor");
  const anaId = await criarUsuario(alfa, "Ana", "ana@alfa.com", "consultor");
  await criarUsuario(beta, "Bruno", "bruno@beta.com", "gestor");
  ana = anaId;

  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, "gestora@alfa.com");
  tAna = await entrar(req, "ana@alfa.com");
  tBeta = await entrar(req, "bruno@beta.com");
});

after(async () => { await fechar(); await encerrar(); });

test('sem token, a porta nem abre', async () => {
  const r = await req('/cadastro/produtores');
  assert.equal(r.status, 401);
});

test('cadastra produtor sem documento — é o caso do campo', async () => {
  const r = await req('/cadastro/produtores', {
    metodo: 'POST', token: tAna,
    corpo: { nome: 'Produtor Sem Documento' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.nome, 'Produtor Sem Documento');
  assert.deepEqual(r.corpo.documentos, []);
});

test('recusa CPF com dígito verificador errado', async () => {
  const r = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Fulano', documentos: [{ tipo: 'cpf', valor: '11122233344' }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /CPF inválido/);
  assert.equal(r.corpo.campo, 'documentos[0].valor');
});

test('aceita CPF formatado e guarda só os dígitos', async () => {
  const r = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'José Cesar Sabo', documentos: [{ tipo: 'cpf', valor: '123.456.789-09' }] },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.corpo.documentos, [{ tipo: 'cpf', valor: CPF_A }]);
});

test('porta única: o mesmo CPF por outra revenda devolve o mesmo produtor', async () => {
  const naBeta = await req('/cadastro/produtores', {
    metodo: 'POST', token: tBeta,
    corpo: { nome: 'J. C. Sabo', documentos: [{ tipo: 'cpf', valor: CPF_A }] },
  });
  assert.equal(naBeta.status, 201);

  const naAlfa = await req('/cadastro/produtores', { token: tGestor });
  const oMesmo = naAlfa.corpo.find((p) => p.nome === 'José Cesar Sabo');
  assert.equal(naBeta.corpo.id, oMesmo.id, 'é a mesma pessoa, com dois vínculos');

  const { rows } = await dono.query('select count(*)::int as n from produtor');
  assert.equal(rows[0].n, 2, 'um com documento, um sem — não três');
});

test('cada revenda enxerga só a carteira dela', async () => {
  const naBeta = await req('/cadastro/produtores', { token: tBeta });
  assert.equal(naBeta.corpo.length, 1, 'a Beta não vê o produtor sem documento da Alfa');
});

test('o consultor enxerga só quem ele cadastrou', async () => {
  const daAna = await req('/cadastro/produtores', { token: tAna });
  assert.deepEqual(daAna.corpo.map((p) => p.nome), ['Produtor Sem Documento']);

  const daGestora = await req('/cadastro/produtores', { token: tGestor });
  assert.equal(daGestora.corpo.length, 2, 'o gestor vê a empresa inteira');
});

test('autorizar amplia a carteira do consultor', async () => {
  const todos = await req('/cadastro/produtores', { token: tGestor });
  const outro = todos.corpo.find((p) => p.nome === 'José Cesar Sabo');

  const r = await req('/cadastro/carteira', {
    metodo: 'POST', token: tGestor,
    corpo: { usuarioId: ana, produtorId: outro.id },
  });
  assert.equal(r.status, 201);

  const daAna = await req('/cadastro/produtores', { token: tAna });
  assert.equal(daAna.corpo.length, 2);
});

test('fusão escolhe quem tem documento e guarda o ponteiro', async () => {
  const todos = await req('/cadastro/produtores', { token: tGestor });
  const semDoc = todos.corpo.find((p) => p.documentos.length === 0);
  const comDoc = todos.corpo.find((p) => p.documentos.length > 0);

  const r = await req('/cadastro/produtores/fundir', {
    metodo: 'POST', token: tGestor,
    corpo: { produtorA: semDoc.id, produtorB: comDoc.id },
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.vencedor, comDoc.id, 'vence quem tem documento');

  const { rows } = await dono.query('select fundido_em from produtor where id = $1', [semDoc.id]);
  assert.equal(rows[0].fundido_em, comDoc.id, 'ninguém é apagado');

  const depois = await req('/cadastro/produtores', { token: tGestor });
  assert.equal(depois.corpo.length, 1, 'o fundido some da lista');
});

test('propriedade nasce junto com quem a opera', async () => {
  const todos = await req('/cadastro/produtores', { token: tGestor });
  const dono_ = todos.corpo[0];

  const r = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tGestor,
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
  const props = await req('/cadastro/propriedades', { token: tGestor });
  const fazenda = props.corpo[0];

  const arrend = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Quem Planta', documentos: [{ tipo: 'cnpj', valor: CNPJ }] },
  });

  const r = await req(`/cadastro/propriedades/${fazenda.id}/operadores`, {
    metodo: 'POST', token: tGestor,
    corpo: { produtorId: arrend.corpo.id, papel: 'arrendatario' },
  });
  assert.equal(r.status, 201);

  const depois = await req('/cadastro/propriedades', { token: tGestor });
  assert.equal(depois.corpo[0].operadores.length, 2, 'dono e arrendatário, na mesma fazenda');
});

test('talhão entra pela propriedade', async () => {
  const props = await req('/cadastro/propriedades', { token: tGestor });
  const fazenda = props.corpo[0];

  const r = await req(`/cadastro/propriedades/${fazenda.id}/talhoes`, {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'T-01', areaHa: 120 },
  });
  assert.equal(r.status, 201);

  const lista = await req(`/cadastro/propriedades/${fazenda.id}/talhoes`, { token: tGestor });
  assert.deepEqual(lista.corpo.map((t) => t.nome), ['T-01']);
});

test('quem não tem vínculo com ninguém da terra não enxerga a terra', async () => {
  const gama = await criarTenant('Sem Relação', '33333333000133');
  await criarUsuario(gama, 'Gil', 'gil@gama.com', 'gestor');
  const tGama = await entrar(req, 'gil@gama.com');

  const props = await req('/cadastro/propriedades', { token: tGama });
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
  const props = await req('/cadastro/propriedades', { token: tBeta });
  assert.equal(props.corpo.length, 1);
  assert.equal(props.corpo[0].nome, 'Fazenda Boa Vista');

  const meus = await req('/cadastro/produtores', { token: tBeta });
  assert.equal(meus.corpo.length, 1, 'mas a carteira dela continua sendo só a dela');
});

test('não dá para pendurar terra em produtor de outro tenant', async () => {
  const daAlfa = await req('/cadastro/produtores', { token: tGestor });
  const alheio = daAlfa.corpo.find((p) => p.nome === 'Quem Planta');

  const r = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tBeta,
    corpo: { nome: 'Fazenda Invasora', produtorId: alheio.id },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /vínculo/);
});

test('recusa entrada malformada antes de chegar ao banco', async () => {
  const semNome = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: {},
  });
  assert.equal(semNome.status, 400);
  assert.equal(semNome.corpo.campo, 'nome');

  const papelErrado = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'X', produtorId: '00000000-0000-0000-0000-000000000000', papel: 'invasor' },
  });
  assert.equal(papelErrado.status, 400);
  assert.equal(papelErrado.corpo.campo, 'papel');

  const idTorto = await req('/cadastro/produtores/nao-e-uuid', { token: tGestor });
  assert.equal(idTorto.status, 400);
});

// As dez etapas — e as regras que fazem delas uma promessa, não um contador.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const CPF = '12345678909';
const TEL = '5566999770022';

let req, fechar, revenda, franqueado, outra;
let tRevenda, tFranqueado, tOutra, tProdutor;
let produtorId, propriedadeId, pedidoId;

/** Cria um pedido novo, já na etapa 1, para os testes que precisam de um limpo. */
async function novoPedido(numero) {
  const r = await req('/pedidos', {
    metodo: 'POST', token: tRevenda,
    corpo: {
      numero, safra: '26/27', produtorId, propriedadeId,
      itens: [{ cultivar: 'FS695', quantidade: 1200, precoUnit: 179 }],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  return r.corpo.id;
}

const avancar = (id, token = tRevenda) =>
  req(`/pedidos/${id}/avancar`, { metodo: 'POST', token, corpo: {} });

const lancarNota = (id, numero = '88412') =>
  req(`/pedidos/${id}/nota`, {
    metodo: 'POST', token: tRevenda,
    corpo: { numero, valor: 214800, emitidaEm: '2026-09-20', vencimento: '2026-10-15' },
  });

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  franqueado = await criarTenant('FS Sementes', '22222222000122', 'franqueado');
  outra = await criarTenant('Revenda Rival', '33333333000133', 'revenda');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  await criarUsuario(franqueado, 'Chefe', 'chefe@fs.com', 'gestor');
  await criarUsuario(outra, 'Rival', 'rival@rv.com', 'gestor');

  // Sorriso é território do franqueado — é daí que sai o carimbo.
  await dono.query(
    'insert into territorio (municipio, uf, franqueado_id) values ($1,$2,$3)',
    ['Sorriso', 'MT', franqueado]);

  ({ req, fechar } = await subirApi());
  tRevenda = await entrar(req, 'gestora@3t.com');
  tFranqueado = await entrar(req, 'chefe@fs.com');
  tOutra = await entrar(req, 'rival@rv.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: 'José Cesar Sabo', documentos: [{ tipo: 'cpf', valor: CPF }] },
  });
  produtorId = p.corpo.id;

  const f = await req('/cadastro/propriedades', {
    metodo: 'POST', token: tRevenda,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 840 },
  });
  propriedadeId = f.corpo.id;

  await req('/auth/convites', {
    metodo: 'POST', token: tRevenda, corpo: { produtorId, telefone: TEL },
  });
  const pedido = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const entrada = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: pedido.corpo.codigo },
  });
  tProdutor = entrada.corpo.token;
});

after(async () => { await fechar(); await encerrar(); });

/* ------------------------------------------------------------------ criar */

test('as dez etapas estão lá, com quem faz e quem avisa', async () => {
  const r = await req('/pedidos/etapas', { token: tRevenda });
  assert.equal(r.corpo.length, 10);
  assert.deepEqual(r.corpo.map((e) => e.numero), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(r.corpo.find((e) => e.numero === 6).nome, 'Transporte');
  assert.equal(r.corpo.find((e) => e.numero === 5).notifica, false, 'expedição é interna');
});

test('o pedido nasce na etapa 1, com o franqueado carimbado pelo município', async () => {
  pedidoId = await novoPedido('PD-0412');
  const r = await req(`/pedidos/${pedidoId}`, { token: tRevenda });
  assert.equal(r.corpo.etapa, 1);
  assert.equal(r.corpo.etapa_nome, 'Negociação');
  assert.equal(r.corpo.franqueado_id, franqueado, 'Sorriso é território dele');
  assert.equal(r.corpo.municipio, 'Sorriso');
  assert.equal(r.corpo.itens.length, 1);
});

test('pedido sem item é recusado', async () => {
  const r = await req('/pedidos', {
    metodo: 'POST', token: tRevenda,
    corpo: { numero: 'PD-VAZIO', safra: '26/27', produtorId, itens: [] },
  });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'itens');
});

test('não dá para abrir pedido para produtor de outra empresa', async () => {
  const r = await req('/pedidos', {
    metodo: 'POST', token: tOutra,
    corpo: {
      numero: 'PD-INVASOR', safra: '26/27', produtorId,
      itens: [{ cultivar: 'X', quantidade: 1 }],
    },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /vínculo/);
});

/* ----------------------------------------------------------------- etapas */

test('avança uma de cada vez, e o histórico guarda cada passo', async () => {
  await avancar(pedidoId);
  const r = await avancar(pedidoId);
  assert.equal(r.corpo.etapa, 3, 'nunca pula');

  const det = await req(`/pedidos/${pedidoId}`, { token: tRevenda });
  assert.deepEqual(det.corpo.historico.map((h) => h.etapa), [1, 2, 3]);
});

test('a etapa 4 exige a nota — a nota É o sell-out', async () => {
  const bloqueado = await avancar(pedidoId);
  assert.equal(bloqueado.status, 400);
  assert.match(bloqueado.corpo.erro, /lance a nota/);

  const comNota = await lancarNota(pedidoId);
  assert.equal(comNota.status, 201);
  assert.equal(comNota.corpo.nota.numero, '88412');

  const agora = await avancar(pedidoId);
  assert.equal(agora.corpo.etapa, 4);
});

test('a mesma nota não entra duas vezes', async () => {
  const r = await lancarNota(pedidoId, '99999');
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /já tem nota/);
});

test('crédito recusado trava o pedido antes da expedição', async () => {
  const outroId = await novoPedido('PD-0500');
  await avancar(outroId); await avancar(outroId);        // 3 · crédito
  await req(`/pedidos/${outroId}/credito`, {
    metodo: 'PATCH', token: tRevenda, corpo: { credito: 'recusado' },
  });
  await lancarNota(outroId, '77001');
  await avancar(outroId);                                 // 4 · faturamento
  const r = await avancar(outroId);                       // 5 · expedição
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /crédito recusado/);
});

test('retroceder exige motivo e fica marcado no histórico', async () => {
  const semMotivo = await req(`/pedidos/${pedidoId}/retroceder`, {
    metodo: 'POST', token: tRevenda, corpo: {},
  });
  assert.equal(semMotivo.status, 400);

  const r = await req(`/pedidos/${pedidoId}/retroceder`, {
    metodo: 'POST', token: tRevenda, corpo: { motivo: 'nota emitida com erro de CFOP' },
  });
  assert.equal(r.corpo.etapa, 3);

  const det = await req(`/pedidos/${pedidoId}`, { token: tRevenda });
  const ultimo = det.corpo.historico.at(-1);
  assert.equal(ultimo.retrocesso, true, 'o passo em falso não se apaga');
  assert.match(ultimo.observacao, /CFOP/);
});

test('pedido cancelado não anda mais', async () => {
  const id = await novoPedido('PD-0600');
  await req(`/pedidos/${id}/cancelar`, {
    metodo: 'POST', token: tRevenda, corpo: { motivo: 'produtor desistiu' },
  });
  const r = await avancar(id);
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /cancelado/);
});

test('chegar na décima conclui o pedido', async () => {
  const id = await novoPedido('PD-0700');
  await avancar(id); await avancar(id);
  await lancarNota(id, '77002');
  for (let i = 0; i < 7; i++) await avancar(id);
  const r = await req(`/pedidos/${id}`, { token: tRevenda });
  assert.equal(r.corpo.etapa, 10);
  assert.equal(r.corpo.situacao, 'concluido');
});

/* ------------------------------------------------------------- notificação */

test('só as etapas que avisam enfileiram aviso', async () => {
  const avisos = await req('/pedidos/avisos', { token: tRevenda });
  const doPedido = avisos.corpo.filter((a) => a.pedido_id === pedidoId);
  const etapas = doPedido.map((a) => a.etapa).sort();
  assert.ok(etapas.includes(2), 'pedido avisa');
  assert.ok(etapas.includes(3), 'crédito avisa');
  assert.ok(!etapas.includes(1), 'negociação é interna, não avisa');
  assert.ok(doPedido.every((a) => a.enviada_em === null), 'quem entrega é outro módulo');
});

/* ------------------------------------------- os dois eixos, e o franqueado */

test('o produtor vê o pedido dele, sem precisar saber de qual revenda', async () => {
  const r = await req('/pedidos', { token: tProdutor });
  assert.ok(r.corpo.length >= 1);
  assert.ok(r.corpo.every((p) => p.produtor === 'José Cesar Sabo'));
});

test('o produtor não cria nem move pedido', async () => {
  const criar = await req('/pedidos', {
    metodo: 'POST', token: tProdutor,
    corpo: { numero: 'X', safra: '26/27', produtorId, itens: [{ cultivar: 'Y', quantidade: 1 }] },
  });
  assert.equal(criar.status, 400);
  assert.match(criar.corpo.erro, /área da empresa/);

  const mover = await avancar(pedidoId, tProdutor);
  assert.equal(mover.status, 400);
});

test('o franqueado enxerga a venda que desceu dele — e não a altera', async () => {
  const lista = await req('/pedidos', { token: tFranqueado });
  assert.ok(lista.corpo.some((p) => p.id === pedidoId),
    'vendeu pelo canal, mas o município é território dele');

  const r = await avancar(pedidoId, tFranqueado);
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /outra empresa/, 'visibilidade descendente é só leitura');
});

test('a revenda rival não enxerga nada disso', async () => {
  const r = await req('/pedidos', { token: tOutra });
  assert.deepEqual(r.corpo, []);
});

test('o pagamento fica registrado na nota', async () => {
  const r = await req(`/pedidos/${pedidoId}/nota/pago`, {
    metodo: 'POST', token: tRevenda, corpo: { pagoEm: '2026-10-10' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.nota.pago_em);
});

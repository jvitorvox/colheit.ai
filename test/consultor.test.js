// O que o aplicativo de campo exige do servidor.
//
// O app trabalha sem sinal e guarda a visita numa fila local que ele reenvia.
// Reenvio é o normal desse desenho, não a exceção — o rádio cai no meio do
// POST e o app não tem como saber se gravou. Se cada tentativa virasse uma
// visita, a mediana da H1 passaria a contar três registros de dez segundos: o
// número que decide o produto, envenenado pela peça que existe para alimentá-lo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

let req, fechar, tConsultor, tOutraRevenda, produtorId;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('Agro Norte', '99999999000199', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@norte.com', 'gestor');
  const consultorId = await criarUsuario(revenda, 'Ana', 'ana@norte.com', 'consultor');
  const outra = await criarTenant('Agro Sul', '10101010000110', 'distribuidor');
  await criarUsuario(outra, 'Gestor Sul', 'gestor@sul.com', 'gestor');

  ({ req, fechar } = await subirApi());
  const tGestor = await entrar(req, 'gestora@norte.com');
  tConsultor = await entrar(req, 'ana@norte.com');
  tOutraRevenda = await entrar(req, 'gestor@sul.com');

  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;
  await req('/cadastro/propriedades', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Fazenda Sabo', produtorId, municipio: 'Sorriso', uf: 'MT', areaHa: 1200 },
  });
  await dono.query(
    `insert into consultor_carteira (vinculo_id, usuario_id)
     select v.id, $2 from produtor_vinculo v where v.produtor_id = $1`,
    [produtorId, consultorId]);
});

after(async () => { await fechar(); await encerrar(); });

/** O corpo que o app monta: o clienteId nasce no celular, antes de tentar. */
const visitaDoApp = (clienteId, extra = {}) => ({
  produtorId, canal: 'app', clienteId,
  em: new Date().toISOString(), duracaoSeg: 41,
  estagio: 'V6', estande: 58, observacao: 'Estande bom, lagarta na bordadura.',
  ...extra,
});

const registrar = (corpo, token = tConsultor) =>
  req('/visitas', { metodo: 'POST', token, corpo });

/* ------------------------------------------------------ a fila é a carteira */

test('a fila do dia do consultor é a carteira dele, sem ele pedir', async () => {
  const r = await req('/visitas/fila', { token: tConsultor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.length, 1);
  assert.equal(r.corpo[0].produtor, 'José Cesar Sabo');
  assert.equal(r.corpo[0].nunca, true, 'nunca visitado vem primeiro');
  assert.equal(r.corpo[0].atrasado, true);
});

/* --------------------------------------------------------- o reenvio é seguro */

test('a visita entra com o que o app mediu', async () => {
  const r = await registrar(visitaDoApp(randomUUID()));
  assert.equal(r.status, 201);
  assert.equal(r.corpo.repetida, false);
  assert.equal(r.corpo.duracao_seg, 41);
  assert.equal(r.corpo.canal, 'app');
  assert.equal(r.corpo.estagio, 'V6');
  assert.equal(r.corpo.consultor, 'Ana', 'a visita é de quem registrou');
});

test('reenviar a MESMA visita devolve a que já existe, sem criar outra', async () => {
  const chave = randomUUID();
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;

  const um = await registrar(visitaDoApp(chave));
  const dois = await registrar(visitaDoApp(chave));
  const tres = await registrar(visitaDoApp(chave, { duracaoSeg: 9, estagio: 'R1' }));

  assert.equal(um.corpo.repetida, false);
  assert.equal(dois.corpo.repetida, true);
  assert.equal(tres.corpo.repetida, true);
  assert.equal(dois.corpo.id, um.corpo.id);
  assert.equal(tres.corpo.id, um.corpo.id);

  // O reenvio não reescreve: vale o que foi medido na primeira gravação.
  assert.equal(tres.corpo.duracao_seg, 41);
  assert.equal(tres.corpo.estagio, 'V6');

  const depois = (await req('/visitas', { token: tConsultor })).corpo.length;
  assert.equal(depois, antes + 1, 'três tentativas, uma visita');
});

test('dois reenvios ao mesmo tempo também dão uma visita só', async () => {
  // A corrida que o desenho prevê: o app volta ao sinal e o consultor toca em
  // "tentar agora" no mesmo instante.
  const chave = randomUUID();
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;

  const respostas = await Promise.all(
    Array.from({ length: 4 }, () => registrar(visitaDoApp(chave))));

  assert.ok(respostas.every((r) => r.status === 201), JSON.stringify(respostas.map((r) => r.corpo)));
  const ids = new Set(respostas.map((r) => r.corpo.id));
  assert.equal(ids.size, 1, 'todas devolvem a mesma visita');
  assert.equal(respostas.filter((r) => r.corpo.repetida === false).length, 1,
    'exatamente uma gravou');

  const depois = (await req('/visitas', { token: tConsultor })).corpo.length;
  assert.equal(depois, antes + 1);
});

test('visitas diferentes no mesmo produtor continuam sendo duas', async () => {
  // O freio é o reenvio, não o produtor: passar duas vezes no mesmo dia é
  // trabalho de verdade, e travar isso seria pior do que o problema.
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;
  await registrar(visitaDoApp(randomUUID()));
  await registrar(visitaDoApp(randomUUID()));
  const depois = (await req('/visitas', { token: tConsultor })).corpo.length;
  assert.equal(depois, antes + 2);
});

test('sem clienteId nada muda — é o caminho do console e do WhatsApp', async () => {
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;
  const um = await registrar({ produtorId, canal: 'app', duracaoSeg: 30 });
  const dois = await registrar({ produtorId, canal: 'app', duracaoSeg: 30 });
  assert.equal(um.status, 201);
  assert.equal(dois.status, 201);
  assert.notEqual(um.corpo.id, dois.corpo.id);
  assert.equal((await req('/visitas', { token: tConsultor })).corpo.length, antes + 2);
});

test('clienteId que não é uuid é recusado, e o app vê o motivo', async () => {
  const r = await registrar(visitaDoApp('não-é-uuid'));
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'clienteId');
});

/* ------------------------------------------------------------ o isolamento */

test('a chave do app é por empresa — colisão não revela nada de outra', async () => {
  // Chave que o cliente gera não pode servir de sonda: a mesma chave em outra
  // revenda grava normalmente, em vez de devolver a visita alheia.
  const chave = randomUUID();
  const minha = await registrar(visitaDoApp(chave));
  assert.equal(minha.corpo.repetida, false);

  const outro = await req('/cadastro/produtores', {
    metodo: 'POST', token: tOutraRevenda, corpo: { nome: 'Wilson Kuhn' },
  });
  const dela = await req('/visitas', {
    metodo: 'POST', token: tOutraRevenda,
    corpo: { produtorId: outro.corpo.id, canal: 'app', clienteId: chave, duracaoSeg: 20 },
  });
  assert.equal(dela.status, 201);
  assert.equal(dela.corpo.repetida, false, 'gravou, não reaproveitou');
  assert.notEqual(dela.corpo.id, minha.corpo.id);
});

test('o produtor não registra visita — quem registra é quem foi ao campo', async () => {
  await req('/auth/convites', {
    metodo: 'POST', token: tConsultor, corpo: { produtorId, telefone: '5566999550011' },
  });
  const cod = await req('/auth/produtor/codigo', {
    metodo: 'POST', corpo: { telefone: '5566999550011' },
  });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: '5566999550011', codigo: cod.corpo.codigo },
  });
  const r = await registrar(visitaDoApp(randomUUID()), ent.corpo.token);
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

/* -------------------------------------------------------------- a medição */

test('a duração medida no celular chega à H1 pelo canal app', async () => {
  const h1 = await req('/visitas/h1', { token: tConsultor });
  const app = h1.corpo.porCanal.find((c) => c.canal === 'app');
  assert.ok(app, 'o canal do aplicativo é medido');
  assert.ok(app.mediana_seg > 0);
  assert.equal(h1.corpo.confirmaAbaixoDe, 60);
  assert.equal(h1.corpo.mataAcimaDe, 90);
});

// A porta única: o mesmo produtor, entrando por revendas diferentes, tem que
// ser reconhecido como o mesmo — sem que uma revenda enxergue a outra.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { comContexto } from '../api/src/contexto.js';
import { migrar } from '../api/src/migrar.js';

let alfa, beta;
const CPF = '12345678901';

before(async () => {
  await migrar({ silencioso: true });
  await dono.query('truncate tenant, produtor cascade');
  const cria = async (nome, doc) => (await dono.query(
    `insert into tenant (nome, documento, tipo) values ($1,$2,'revenda') returning id`,
    [nome, doc])).rows[0].id;
  alfa = await cria('Revenda Alfa', '11111111000111');
  beta = await cria('Revenda Beta', '22222222000122');
});

after(encerrar);

test('mesmo CPF por duas revendas devolve o MESMO produtor', async () => {
  const docs = JSON.stringify([{ tipo: 'cpf', valor: CPF }]);

  const naAlfa = await comContexto({ tenant: alfa }, async (cx) =>
    (await cx.query('select app.vincular_produtor($1,$2::jsonb) as id',
      ['João da Silva', docs])).rows[0].id);

  const naBeta = await comContexto({ tenant: beta }, async (cx) =>
    (await cx.query('select app.vincular_produtor($1,$2::jsonb) as id',
      ['J. da Silva', docs])).rows[0].id);

  assert.equal(naAlfa, naBeta, 'a porta única depende disto');

  const { rows } = await dono.query('select count(*)::int as n from produtor');
  assert.equal(rows[0].n, 1, 'um produtor, não dois');
});

test('cada revenda tem o próprio vínculo, e só enxerga o seu', async () => {
  const { rows } = await dono.query('select count(*)::int as n from produtor_vinculo');
  assert.equal(rows[0].n, 2);

  for (const t of [alfa, beta]) {
    const n = await comContexto({ tenant: t }, async (cx) =>
      (await cx.query('select count(*)::int as n from produtor_vinculo')).rows[0].n);
    assert.equal(n, 1, 'cada uma enxerga só o vínculo dela');
  }
});

test('a Beta não descobre nada da Alfa — só que tem um produtor', async () => {
  const visivel = await comContexto({ tenant: beta }, async (cx) =>
    (await cx.query('select count(*)::int as n from produtor')).rows[0].n);
  assert.equal(visivel, 1);

  // enxerga a própria empresa, nunca as outras
  const empresas = await comContexto({ tenant: beta }, async (cx) =>
    (await cx.query('select nome from tenant')).rows.map((r) => r.nome));
  assert.deepEqual(empresas, ['Revenda Beta'], 'não pode listar os clientes da plataforma');
});

test('cadastro sem documento é aceito — é o caso do campo', async () => {
  const id = await comContexto({ tenant: alfa }, async (cx) =>
    (await cx.query(`select app.vincular_produtor($1,'[]'::jsonb) as id`,
      ['Produtor Sem Documento'])).rows[0].id);
  assert.ok(id);
});

test('fusão: perdedor aponta para o vencedor e os vínculos migram', async () => {
  const semDoc = (await dono.query(
    `select id from produtor where nome = 'Produtor Sem Documento'`)).rows[0].id;
  const comDoc = (await dono.query(
    `select id from produtor where nome = 'João da Silva'`)).rows[0].id;

  await dono.query('select app.fundir_produtor($1,$2)', [semDoc, comDoc]);

  const p = (await dono.query('select fundido_em from produtor where id = $1',
    [semDoc])).rows[0];
  assert.equal(p.fundido_em, comDoc, 'ninguém é apagado — o ponteiro fica');

  const orfaos = (await dono.query(
    'select count(*)::int as n from produtor_vinculo where produtor_id = $1',
    [semDoc])).rows[0].n;
  assert.equal(orfaos, 0, 'vínculo do perdedor não fica solto');
});

test('depois da fusão, o documento resolve para o vencedor', async () => {
  const comDoc = (await dono.query(
    `select id from produtor where nome = 'João da Silva'`)).rows[0].id;
  const achado = await comContexto({ tenant: beta }, async (cx) =>
    (await cx.query(`select app.vincular_produtor($1,$2::jsonb) as id`,
      ['qualquer', JSON.stringify([{ tipo: 'cpf', valor: CPF }])])).rows[0].id);
  assert.equal(achado, comDoc);
});

// A segunda dimensão: dentro da mesma empresa, o consultor só atua sobre os
// produtores que o CRM autorizou. O gestor enxerga a empresa inteira.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { comContexto } from '../api/src/contexto.js';
import { migrar } from '../api/src/migrar.js';

let tenant, gestor, ana, bruno, vincA, vincB;

before(async () => {
  await migrar({ silencioso: true });
  await dono.query('truncate tenant, produtor cascade');

  tenant = (await dono.query(
    `insert into tenant (nome, documento, tipo)
     values ('Revenda Única','33333333000133','revenda') returning id`)).rows[0].id;

  const criaUsuario = async (nome, email, papel) => (await dono.query(
    `insert into usuario (tenant_id, nome, email, papel)
     values ($1,$2,$3,$4) returning id`, [tenant, nome, email, papel])).rows[0].id;

  gestor = await criaUsuario('Gestora', 'gestora@revenda.com', 'gestor');
  ana    = await criaUsuario('Ana',     'ana@revenda.com',     'consultor');
  bruno  = await criaUsuario('Bruno',   'bruno@revenda.com',   'consultor');

  // Ana cadastra em campo — tem que sair autorizada no mesmo ato.
  await comContexto({ tenant, usuario: ana }, (cx) =>
    cx.query(`select app.vincular_produtor('Produtor da Ana','[]'::jsonb)`));
  await comContexto({ tenant, usuario: bruno }, (cx) =>
    cx.query(`select app.vincular_produtor('Produtor do Bruno','[]'::jsonb)`));

  const vinc = async (nome) => (await dono.query(
    `select v.id from produtor_vinculo v join produtor p on p.id = v.produtor_id
      where p.nome = $1`, [nome])).rows[0].id;
  vincA = await vinc('Produtor da Ana');
  vincB = await vinc('Produtor do Bruno');
});

after(encerrar);

test('quem cadastra em campo já enxerga o que criou', async () => {
  const n = await comContexto({ tenant, usuario: ana }, async (cx) =>
    (await cx.query('select count(*)::int as n from produtor_vinculo')).rows[0].n);
  assert.equal(n, 1, 'sem autorização no ato, o consultor perderia o próprio cadastro');
});

test('o consultor NÃO enxerga o produtor do colega', async () => {
  const nomes = await comContexto({ tenant, usuario: ana }, async (cx) =>
    (await cx.query('select nome from produtor')).rows.map((r) => r.nome));
  assert.deepEqual(nomes, ['Produtor da Ana']);
});

test('o gestor enxerga a empresa inteira', async () => {
  const n = await comContexto({ tenant, usuario: gestor }, async (cx) =>
    (await cx.query('select count(*)::int as n from produtor_vinculo')).rows[0].n);
  assert.equal(n, 2);
});

test('job sem usuário roda no tenant inteiro', async () => {
  const n = await comContexto({ tenant }, async (cx) =>
    (await cx.query('select count(*)::int as n from produtor_vinculo')).rows[0].n);
  assert.equal(n, 2, 'integração e job não têm pessoa por trás');
});

test('autorizar amplia a carteira', async () => {
  await comContexto({ tenant, usuario: gestor }, (cx) =>
    cx.query('select app.autorizar_consultor($1,$2)', [ana, vincB]));

  const n = await comContexto({ tenant, usuario: ana }, async (cx) =>
    (await cx.query('select count(*)::int as n from produtor_vinculo')).rows[0].n);
  assert.equal(n, 2);
});

test('não dá para autorizar consultor de outra empresa', async () => {
  const outra = (await dono.query(
    `insert into tenant (nome, documento, tipo)
     values ('Outra','44444444000144','revenda') returning id`)).rows[0].id;
  const intruso = (await dono.query(
    `insert into usuario (tenant_id, nome, email, papel)
     values ($1,'Intruso','intruso@outra.com','consultor') returning id`,
    [outra])).rows[0].id;

  await assert.rejects(
    comContexto({ tenant, usuario: gestor }, (cx) =>
      cx.query('select app.autorizar_consultor($1,$2)', [intruso, vincA])),
    /mesma empresa/,
  );
});

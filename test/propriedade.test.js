// "Ele tb é cliente": dono e arrendatário são produtores, ligados à mesma
// propriedade com papéis diferentes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { comContexto } from '../api/src/contexto.js';
import { migrar } from '../api/src/migrar.js';

let tenant, fazenda, proprietario, arrendatario;

before(async () => {
  await migrar({ silencioso: true });
  await dono.query('truncate tenant, produtor, propriedade cascade');

  tenant = (await dono.query(
    `insert into tenant (nome, documento, tipo)
     values ('Revenda','55555555000155','revenda') returning id`)).rows[0].id;

  const cria = async (nome, cpf) => comContexto({ tenant }, async (cx) =>
    (await cx.query('select app.vincular_produtor($1,$2::jsonb) as id',
      [nome, JSON.stringify([{ tipo: 'cpf', valor: cpf }])])).rows[0].id);

  proprietario = await cria('Dona da Terra', '10000000001');
  arrendatario = await cria('Quem Planta', '20000000002');

  fazenda = (await dono.query(
    `insert into propriedade (nome, municipio, uf, car, area_ha)
     values ('Fazenda Boa Vista','Sorriso','MT','MT-5107925-ABC',840.5)
     returning id`)).rows[0].id;

  await dono.query(
    `insert into produtor_propriedade (produtor_id, propriedade_id, papel)
     values ($1,$3,'proprietario'), ($2,$3,'arrendatario')`,
    [proprietario, arrendatario, fazenda]);

  await dono.query(
    `insert into talhao (propriedade_id, nome, area_ha) values ($1,'T-01',120.0)`,
    [fazenda]);
});

after(encerrar);

test('a mesma fazenda tem dono e arrendatário, ambos produtores', async () => {
  const papeis = await comContexto({ tenant }, async (cx) =>
    (await cx.query(
      `select pp.papel from produtor_propriedade pp
        where pp.propriedade_id = $1 order by pp.papel`, [fazenda])).rows);
  assert.deepEqual(papeis.map((r) => r.papel), ['arrendatario', 'proprietario']);
});

test('só um proprietário vigente por propriedade', async () => {
  const terceiro = await comContexto({ tenant }, async (cx) =>
    (await cx.query(
      `select app.vincular_produtor('Outro Dono','[]'::jsonb) as id`)).rows[0].id);
  await assert.rejects(
    dono.query(
      `insert into produtor_propriedade (produtor_id, propriedade_id, papel)
       values ($1,$2,'proprietario')`, [terceiro, fazenda]),
    /duplicate key|unique/i,
  );
});

test('arrendamento encerrado fecha o período, mas fica no histórico', async () => {
  await dono.query(
    `update produtor_propriedade set fim = current_date + 1
      where propriedade_id = $1 and papel = 'arrendatario'`, [fazenda]);
  const { rows } = await dono.query(
    `select count(*)::int as n from produtor_propriedade
      where propriedade_id = $1 and papel = 'arrendatario'`, [fazenda]);
  assert.equal(rows[0].n, 1, 'o período fecha, a linha permanece');
});

test('propriedade e talhão só aparecem para quem tem vínculo com quem a opera', async () => {
  const outra = (await dono.query(
    `insert into tenant (nome, documento, tipo)
     values ('Sem Relação','66666666000166','revenda') returning id`)).rows[0].id;

  const vistos = await comContexto({ tenant: outra }, async (cx) => ({
    prop: (await cx.query('select count(*)::int as n from propriedade')).rows[0].n,
    talhao: (await cx.query('select count(*)::int as n from talhao')).rows[0].n,
  }));
  assert.deepEqual(vistos, { prop: 0, talhao: 0 });

  const meus = await comContexto({ tenant }, async (cx) => ({
    prop: (await cx.query('select count(*)::int as n from propriedade')).rows[0].n,
    talhao: (await cx.query('select count(*)::int as n from talhao')).rows[0].n,
  }));
  assert.deepEqual(meus, { prop: 1, talhao: 1 });
});

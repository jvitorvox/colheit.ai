// O teste que a seção 13 exige: isolamento verificado no CI, não conferido à mão.
//
// Ele existe antes da primeira tabela de domínio de propósito. Se o isolamento
// quebrar, tem que quebrar aqui — não na safra seguinte, no dado de um cliente.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, comTenant, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';

let alfa, beta;

before(async () => {
  await migrar({ silencioso: true });
  await dono.query('delete from tenant');

  const cria = async (nome, doc, tipo) =>
    (await dono.query(
      'insert into tenant (nome, documento, tipo) values ($1,$2,$3) returning id',
      [nome, doc, tipo],
    )).rows[0].id;

  alfa = await cria('Revenda Alfa', '11111111000111', 'revenda');
  beta = await cria('Revenda Beta', '22222222000122', 'revenda');

  await dono.query(
    'insert into nota_teste (tenant_id, texto) values ($1,$2), ($1,$3), ($4,$5)',
    [alfa, 'alfa-um', 'alfa-dois', beta, 'beta-um'],
  );
});

after(encerrar);

test('o dono enxerga tudo — é ele quem roda migração e job', async () => {
  const { rows } = await dono.query('select texto from nota_teste');
  assert.equal(rows.length, 3);
});

test('a aplicação enxerga só o tenant do contexto', async () => {
  const textos = await comTenant(alfa, async (cx) =>
    (await cx.query('select texto from nota_teste order by texto')).rows.map((r) => r.texto));
  assert.deepEqual(textos, ['alfa-dois', 'alfa-um']);
});

test('um WHERE esquecido não vaza: sem filtro, ainda assim só vem o próprio', async () => {
  const n = await comTenant(beta, async (cx) =>
    (await cx.query('select count(*)::int as n from nota_teste')).rows[0].n);
  assert.equal(n, 1);
});

test('não dá para gravar linha carimbada para outro tenant', async () => {
  await assert.rejects(
    comTenant(alfa, (cx) =>
      cx.query('insert into nota_teste (tenant_id, texto) values ($1,$2)', [beta, 'invasor'])),
    /row-level security/i,
  );
});

test('não dá para sequestrar linha alheia mudando o tenant_id', async () => {
  await comTenant(alfa, async (cx) => {
    const { rowCount } = await cx.query(
      'update nota_teste set tenant_id = $1 where texto = $2', [alfa, 'beta-um']);
    assert.equal(rowCount, 0, 'a linha da Beta nem deveria estar visível para a Alfa');
  });
});

test('sem tenant no contexto, a aplicação não enxerga nada', async () => {
  const n = await comTenant(null, async (cx) =>
    (await cx.query('select count(*)::int as n from nota_teste')).rows[0].n);
  assert.equal(n, 0, 'o padrão tem que ser não ver nada, nunca ver tudo');
});

test('a aplicação não é dona — não pode desligar a política', async () => {
  await assert.rejects(
    comTenant(alfa, (cx) => cx.query('alter table nota_teste disable row level security')),
    /must be owner|permission denied/i,
  );
});

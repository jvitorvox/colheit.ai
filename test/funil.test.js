// Funil de prospecção — e o laço que devolve o dado do campo a ele.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const TEL = '5566999220066';
let req, fechar, tGestor, tProdutor, grande, pequeno, oportunidade;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');

  const cria = async (nome, areaHa) => {
    const p = await req('/cadastro/produtores', {
      metodo: 'POST', token: tGestor, corpo: { nome },
    });
    await req('/cadastro/propriedades', {
      metodo: 'POST', token: tGestor,
      corpo: { nome: `Fazenda ${nome}`, produtorId: p.corpo.id,
        municipio: 'Sorriso', uf: 'MT', areaHa },
    });
    return p.corpo.id;
  };
  grande = await cria('Produtor Grande', 18000);
  pequeno = await cria('Produtor Pequeno', 400);

  await req('/auth/convites', { metodo: 'POST', token: tGestor, corpo: { produtorId: grande, telefone: TEL } });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: cod.corpo.codigo },
  });
  tProdutor = ent.corpo.token;
});

after(async () => { await fechar(); await encerrar(); });

/* ------------------------------------------------------------ o funil anda */

test('a oportunidade nasce em prospecção, uma por produtor por safra', async () => {
  const r = await req('/funil', {
    metodo: 'POST', token: tGestor, corpo: { produtorId: grande, safra: '26/27' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.estagio, 'prospeccao');
  assert.equal(r.corpo.origem_potencial, 'estimado');
  oportunidade = r.corpo.id;

  const repetida = await req('/funil', {
    metodo: 'POST', token: tGestor, corpo: { produtorId: grande, safra: '26/27' },
  });
  assert.equal(repetida.status, 400);
  assert.match(repetida.corpo.erro, /já tem oportunidade/);
});

test('potencial informado manda sobre o estimado', async () => {
  const r = await req(`/funil/${oportunidade}/potencial`, {
    metodo: 'PATCH', token: tGestor, corpo: { potencialSc: 20000 },
  });
  assert.equal(Number(r.corpo.potencial_sc), 20000);
  assert.equal(r.corpo.origem_potencial, 'informado');
});

test('anda pelos estágios, e o histórico guarda a conversa', async () => {
  for (const estagio of ['qualificacao', 'proposta', 'negociacao']) {
    const r = await req(`/funil/${oportunidade}/mover`, {
      metodo: 'POST', token: tGestor, corpo: { estagio },
    });
    assert.equal(r.corpo.estagio, estagio);
  }
  const det = await req(`/funil/${oportunidade}`, { token: tGestor });
  assert.deepEqual(det.corpo.historico.map((h) => h.estagio),
    ['prospeccao', 'qualificacao', 'proposta', 'negociacao']);
});

test('perder exige motivo — funil sem motivo vira relatório de desculpa', async () => {
  const o = await req('/funil', {
    metodo: 'POST', token: tGestor, corpo: { produtorId: pequeno, safra: '26/27' },
  });

  const semMotivo = await req(`/funil/${o.corpo.id}/mover`, {
    metodo: 'POST', token: tGestor, corpo: { estagio: 'perdida' },
  });
  assert.equal(semMotivo.status, 400);
  assert.equal(semMotivo.corpo.campo, 'motivoPerda');

  const r = await req(`/funil/${o.corpo.id}/mover`, {
    metodo: 'POST', token: tGestor,
    corpo: { estagio: 'perdida', motivoPerda: 'preço acima do concorrente',
      concorrente: 'Marca B' },
  });
  assert.equal(r.corpo.estagio, 'perdida');
  assert.match(r.corpo.motivo_perda, /preço/);
  assert.equal(r.corpo.concorrente, 'Marca B');
  assert.ok(r.corpo.fechada_em);
});

test('oportunidade fechada não vai para o outro fechamento', async () => {
  const lista = await req('/funil?estagio=perdida', { token: tGestor });
  const perdida = lista.corpo[0];
  const r = await req(`/funil/${perdida.id}/mover`, {
    metodo: 'POST', token: tGestor, corpo: { estagio: 'ganha' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /já perdida/);
});

test('o resumo devolve os seis estágios, na ordem da conversa', async () => {
  const r = await req('/funil/resumo?safra=26/27', { token: tGestor });
  assert.deepEqual(r.corpo.map((e) => e.estagio),
    ['prospeccao', 'qualificacao', 'proposta', 'negociacao', 'ganha', 'perdida']);
  const neg = r.corpo.find((e) => e.estagio === 'negociacao');
  assert.equal(neg.quantas, 1);
  assert.equal(neg.potencialSc, 20000);
  assert.equal(neg.aberto, true);
});

/* ------------------------------------- o laço: campo → potencial → venda */

test('sem venda, a penetração é zero e a lacuna é o potencial inteiro', async () => {
  const r = await req('/funil/penetracao?safra=26/27', { token: tGestor });
  const g = r.corpo.linhas.find((l) => l.produtorId === grande);
  assert.equal(g.areaHa, 18000);
  assert.equal(g.potencialSc, 20000, 'o informado manda');
  assert.equal(g.compradoSc, 0);
  assert.equal(g.lacunaSc, 20000);
  assert.equal(g.penetracao, 0);
});

test('o potencial estimado sai da área cadastrada — é o laço', async () => {
  const r = await req('/funil/penetracao?safra=26/27&scPorHa=1.2', { token: tGestor });
  const p = r.corpo.linhas.find((l) => l.produtorId === pequeno);
  assert.equal(p.areaHa, 400);
  assert.equal(p.potencialSc, 480, '400 ha × 1,2 sc/ha — sem ninguém digitar');
  assert.equal(r.corpo.scPorHa, 1.2);
  assert.match(r.corpo.origemDaTaxa, /informada/);
});

test('a taxa padrão se declara como padrão, em vez de fingir precisão', async () => {
  const r = await req('/funil/penetracao?safra=26/27', { token: tGestor });
  assert.match(r.corpo.origemDaTaxa, /confirmar com a agronomia/);
});

test('vender move a penetração e encolhe a lacuna', async () => {
  await req('/pedidos', {
    metodo: 'POST', token: tGestor,
    corpo: { numero: 'PD-3001', safra: '26/27', produtorId: grande,
      itens: [{ cultivar: 'FS695', quantidade: 5000 }] },
  });

  const r = await req('/funil/penetracao?safra=26/27', { token: tGestor });
  const g = r.corpo.linhas.find((l) => l.produtorId === grande);
  assert.equal(g.compradoSc, 5000);
  assert.equal(g.lacunaSc, 15000);
  assert.equal(g.penetracao, 25);
});

test('a fila ordena pela lacuna em sacos, não pelo percentual', async () => {
  const r = await req('/funil/penetracao?safra=26/27', { token: tGestor });
  assert.equal(r.corpo.linhas[0].produtorId, grande,
    'o de 18.000 ha com 25% vale mais atenção que o de 400 ha com 0%');
});

test('pedido cancelado sai da conta', async () => {
  const lista = await req('/pedidos', { token: tGestor });
  const p = lista.corpo.find((x) => x.numero === 'PD-3001');
  await req(`/pedidos/${p.id}/cancelar`, {
    metodo: 'POST', token: tGestor, corpo: { motivo: 'produtor desistiu' },
  });
  const r = await req('/funil/penetracao?safra=26/27', { token: tGestor });
  const g = r.corpo.linhas.find((l) => l.produtorId === grande);
  assert.equal(g.compradoSc, 0);
});

/* ------------------------------------- a camada comercial não atravessa */

test('o produtor não enxerga o funil — nem a tabela tem política para ele', async () => {
  const lista = await req('/funil', { token: tProdutor });
  assert.equal(lista.status, 400);
  assert.match(lista.corpo.erro, /área da empresa/);

  const pen = await req('/funil/penetracao?safra=26/27', { token: tProdutor });
  assert.equal(pen.status, 400);
});

test('motivo de perda e concorrente ficam do lado de dentro', async () => {
  // Mesmo com sessão de empresa de outra revenda, nada aparece.
  const outra = await criarTenant('Rival', '22222222000122');
  await criarUsuario(outra, 'Rival', 'rival@rv.com', 'gestor');
  const tRival = await entrar(req, 'rival@rv.com');

  const r = await req('/funil?safra=26/27', { token: tRival });
  assert.deepEqual(r.corpo, []);
});

test('não se abre oportunidade para produtor de outra carteira', async () => {
  const tRival = await entrar(req, 'rival@rv.com');
  const r = await req('/funil', {
    metodo: 'POST', token: tRival, corpo: { produtorId: grande, safra: '26/27' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /carteira/);
});

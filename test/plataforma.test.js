// Moderação de cadastro — e o alcance da conta que modera.
//
// Metade deste arquivo é sobre o que a conta de plataforma FAZ. A outra metade
// é sobre o que ela não alcança, e essa metade é a que importa: um superadmin
// que na prática lê o dado de todo mundo seria pior do que não ter superadmin.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { usarCorreio } from '../api/src/modulos/auth/correio.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase, SENHA } from './ajuda.js';

let req, fechar, tModerador, tGestor;
const caixa = [];

const SENHA_MOD = 'senha-do-moderador-1';
const linkDo = (msg) => new URL(msg.texto.match(/https?:\/\/\S+/)[0]);

function cnpj(base) {
  const d = String(base).padStart(12, '0').split('').map(Number);
  const dv = (pesos) => {
    const r = pesos.reduce((s, p, i) => s + d[i] * p, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  d.push(dv([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  d.push(dv([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  return d.join('');
}

let seq = 500;
const pedido = (extra = {}) => ({
  nome: 'Agro Sorriso',
  documento: cnpj(seq += 1),
  tipo: 'revenda',
  gestor: 'Marina Alves',
  email: `marina${seq}@agrosorriso.com`,
  ...extra,
});

/** Um cadastro que foi até o fim: empresa viva, nascida pela tela. */
async function nascerPelaTela(p = pedido()) {
  await dono.query('truncate cadastro_tentativa');
  const antes = caixa.length;
  await req('/conta/cadastro', { metodo: 'POST', corpo: p });
  const token = linkDo(caixa.at(-1)).hash.match(/conta=(.+)$/)[1];
  assert.ok(caixa.length > antes);
  const r = await req('/conta/confirmar', { metodo: 'POST', corpo: { token } });
  assert.equal(r.status, 201);
  // A confirmação devolve nome e bilhete de senha, não o id do tenant — quem
  // acabou de confirmar não tem o que fazer com ele. Aqui o teste busca no banco.
  const { rows } = await dono.query(
    'select id from tenant where documento = $1 and liberado_em is null', [p.documento]);
  return { ...p, tenantId: rows[0].id, senhaToken: r.corpo.token };
}

const fila = () => req('/plataforma/moderacao', { token: tModerador });
const acharNaFila = async (tenantNome) =>
  (await fila()).corpo.empresas.find((e) => e.nome === tenantNome);

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  await dono.query('truncate plataforma_usuario cascade');
  process.env.APP_URL = 'https://colheitai.exemplo';

  const revenda = await criarTenant('3 Tentos', '11222333000181', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');

  ({ req, fechar } = await subirApi());
  usarCorreio((msg) => { caixa.push(msg); });
  tGestor = await entrar(req, 'gestora@3t.com');
});

beforeEach(() => { caixa.length = 0; });

after(async () => {
  usarCorreio(null);
  await fechar();
  await encerrar();
});

/* ------------------------------------------------------- a conta existe */

test('a conta de plataforma nasce sem senha, e escolhe a dela pelo bilhete', async () => {
  const { rows: [p] } = await dono.query(
    "insert into plataforma_usuario (nome, email) values ('João', 'joao@colheit.ai') returning id");
  assert.ok(p.id);

  const semSenha = await req('/auth/plataforma/entrar', {
    metodo: 'POST', corpo: { email: 'joao@colheit.ai', senha: 'qualquer-coisa' },
  });
  assert.equal(semSenha.status, 400, 'sem senha definida, não entra');

  // O mesmo bilhete das outras identidades, com o dono do outro lado do check.
  const { gerarToken, hashToken } = await import('../api/src/modulos/auth/senha.js');
  const token = gerarToken();
  await dono.query(`
    insert into recuperacao_senha (plataforma_id, token_hash, origem, expira_em)
    values ($1, $2, 'admin', now() + interval '1 hour')`, [p.id, hashToken(token)]);

  assert.equal((await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token, senha: SENHA_MOD },
  })).status, 200);

  const entrou = await req('/auth/plataforma/entrar', {
    metodo: 'POST', corpo: { email: 'joao@colheit.ai', senha: SENHA_MOD },
  });
  assert.equal(entrou.status, 200);
  tModerador = entrou.corpo.token;
});

test('o bilhete aponta para uma identidade só', async () => {
  const { rows } = await dono.query(`
    select count(*)::int as n from recuperacao_senha
     where (usuario_id is null) = (plataforma_id is null)`);
  assert.equal(rows[0].n, 0, 'o check do banco não deixa um bilhete sem dono ou com dois');
});

/* ------------------------------------------- o que a conta NÃO alcança */

test('a sessão de plataforma não lê dado de negócio de ninguém', async () => {
  // Não porque alguém conferiu o papel em cada rota: ela não tem tenant, e sem
  // tenant nenhuma política casa. As rotas de empresa recusam antes disso.
  for (const caminho of ['/cadastro/produtores', '/pedidos', '/visitas', '/caderno/plantios', '/painel']) {
    const r = await req(caminho, { token: tModerador });
    assert.ok(r.status === 400 || r.status === 401 || (Array.isArray(r.corpo) && r.corpo.length === 0),
      `${caminho} devolveu ${r.status} ${JSON.stringify(r.corpo).slice(0, 80)}`);
  }
});

test('a sessão de empresa não entra na moderação', async () => {
  const r = await req('/plataforma/moderacao', { token: tGestor });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /plataforma/);

  const semToken = await req('/plataforma/moderacao');
  assert.equal(semToken.status, 401);
});

test('a fila mostra cadastro, e não mostra o que a empresa faz', async () => {
  await nascerPelaTela(pedido({ nome: 'Agro Um' }));
  const e = await acharNaFila('Agro Um');

  assert.ok(e.documento && e.gestor && e.gestor_email);
  assert.equal(e.usuarios, 1);
  assert.equal(e.revisado_em, null, 'nasce sem revisão');

  // O que quem modera CNPJ não tem o que fazer com.
  for (const campo of ['receita', 'volume', 'pedidos', 'produtores', 'visitas']) {
    assert.equal(campo in e, false, `${campo} não devia chegar aqui`);
  }
});

test('empresa criada pelo admin não entra na fila', async () => {
  const fora = (await fila()).corpo.empresas.find((e) => e.nome === '3 Tentos');
  assert.equal(fora, undefined, 'a fila é de quem nasceu pela tela');
});

test('o pendente aparece, e enquanto está lá o CNPJ continua livre', async () => {
  await dono.query('truncate cadastro_tentativa');
  const p = pedido({ nome: 'Agro Pendente' });
  await req('/conta/cadastro', { metodo: 'POST', corpo: p });

  const { pendentes } = (await fila()).corpo;
  const achado = pendentes.find((x) => x.documento === p.documento);
  assert.ok(achado, 'é o aviso de que um CNPJ está prestes a ser reivindicado');
  assert.equal(achado.gestor_email, p.email);

  const { rows } = await dono.query(
    'select count(*)::int as n from tenant where documento = $1', [p.documento]);
  assert.equal(rows[0].n, 0, 'nada existe até alguém abrir o link');
});

/* ----------------------------------------------------------- moderar */

test('aprovar tira da fila e não mexe em mais nada', async () => {
  const c = await nascerPelaTela(pedido({ nome: 'Agro Aprovada' }));
  const r = await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST', token: tModerador, corpo: { acao: 'aprovar' },
  });
  assert.equal(r.status, 200);

  const e = await acharNaFila('Agro Aprovada');
  assert.ok(e.revisado_em);
  assert.equal(e.revisado_por, 'João', 'fica registrado quem olhou');
  assert.equal(e.ativo, true);
  assert.equal(e.liberado_em, null);
});

test('recusar exige motivo, e quem exige é o banco', async () => {
  const c = await nascerPelaTela(pedido({ nome: 'Agro Sem Motivo' }));
  const r = await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST', token: tModerador, corpo: { acao: 'recusar', nota: '   ' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /motivo/);
});

test('recusar desliga a empresa E devolve o CNPJ — as duas coisas', async () => {
  const c = await nascerPelaTela(pedido({ nome: 'Agro Impostora' }));
  // A pessoa tinha entrado: é o caso real, não o hipotético.
  await req('/auth/redefinir', { metodo: 'POST', corpo: { token: c.senhaToken, senha: SENHA } });
  assert.ok(await entrar(req, c.email, SENHA));

  const r = await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST',
    token: tModerador,
    corpo: { acao: 'recusar', nota: 'CNPJ de terceiro; dono confirmou por telefone' },
  });
  assert.equal(r.status, 200);

  // Desligar sem soltar deixaria o dono de verdade sem conseguir se cadastrar;
  // soltar sem desligar deixaria o impostor usando o sistema.
  const naoEntra = await req('/auth/login', {
    metodo: 'POST', corpo: { email: c.email, senha: SENHA },
  });
  assert.equal(naoEntra.status, 400);

  const dono2 = await nascerPelaTela(pedido({
    nome: 'Agro Sorriso de verdade', documento: c.documento,
  }));
  assert.ok(dono2.tenantId, 'o CNPJ voltou a ficar livre para quem é dono dele');

  // E o registro do que aconteceu continua lá — é a linha que alguém vai ler
  // quando a ligação chegar.
  const recusada = await acharNaFila('Agro Impostora');
  assert.ok(recusada.liberado_em);
  assert.match(recusada.revisao_nota, /telefone/);
});

test('reabrir não passa por cima de quem ficou com o CNPJ', async () => {
  const c = await nascerPelaTela(pedido({ nome: 'Agro Arrependida' }));
  await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST', token: tModerador, corpo: { acao: 'recusar', nota: 'engano meu' },
  });

  // Reabrir sozinho funciona: ninguém pegou o CNPJ no intervalo.
  assert.equal((await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST', token: tModerador, corpo: { acao: 'reabrir' },
  })).status, 200);

  // Agora recusa de novo e deixa outra empresa levar o CNPJ.
  await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST', token: tModerador, corpo: { acao: 'recusar', nota: 'era mesmo de terceiro' },
  });
  await nascerPelaTela(pedido({ nome: 'Agro Legítima', documento: c.documento }));

  const tarde = await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST', token: tModerador, corpo: { acao: 'reabrir' },
  });
  assert.equal(tarde.status, 400);
  assert.match(tarde.corpo.erro, /já foi para outra empresa/);
});

test('ação desconhecida não passa', async () => {
  const c = await nascerPelaTela(pedido({ nome: 'Agro Inventada' }));
  const r = await req(`/plataforma/moderacao/${c.tenantId}`, {
    metodo: 'POST', token: tModerador, corpo: { acao: 'apagar' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'acao');
});

test('a regra de "só plataforma" mora no banco, não na rota', async () => {
  // Sem contexto de plataforma nenhum, a própria função recusa.
  const { comContexto } = await import('../api/src/contexto.js');
  await assert.rejects(
    () => comContexto({}, (cx) => cx.query('select * from app.moderacao_empresas()')),
    /esta área é da plataforma/);
});

test('moderador desativado deixa de moderar na hora', async () => {
  await dono.query("update plataforma_usuario set ativo = false where email = 'joao@colheit.ai'");
  const r = await req('/plataforma/moderacao', { token: tModerador });
  assert.equal(r.status, 400, 'o token continua válido; a conta é que não está');
  await dono.query("update plataforma_usuario set ativo = true where email = 'joao@colheit.ai'");
});

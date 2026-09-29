// Autenticação: as duas identidades, e o que cada uma NÃO pode fazer.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase, SENHA } from './ajuda.js';

let req, fechar, alfa, beta, gestor, ana, deOutra, produtorId;
const TEL = '5566999880011';

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();

  alfa = await criarTenant('Revenda Alfa', '11111111000111');
  beta = await criarTenant('Revenda Beta', '22222222000122');
  gestor = await criarUsuario(alfa, 'Gestora', 'gestora@alfa.com', 'gestor');
  ana = await criarUsuario(alfa, 'Ana', 'ana@alfa.com', 'consultor');
  deOutra = await criarUsuario(beta, 'Bruno', 'bruno@beta.com', 'gestor');

  ({ req, fechar } = await subirApi());
});

after(async () => { await fechar(); await encerrar(); });

/* ----------------------------------------------------------------- usuário */

test('entra com e-mail e senha e recebe token', async () => {
  const r = await req('/auth/login', { metodo: 'POST', corpo: { email: 'gestora@alfa.com', senha: SENHA } });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.token);
  assert.equal(r.corpo.usuario.papel, 'gestor');
  assert.equal(r.corpo.usuario.senha_hash, undefined, 'o hash nunca sai na resposta');
});

test('senha errada e e-mail inexistente respondem igual', async () => {
  const errada = await req('/auth/login', { metodo: 'POST', corpo: { email: 'gestora@alfa.com', senha: 'errada-mesmo' } });
  const naoExiste = await req('/auth/login', { metodo: 'POST', corpo: { email: 'ninguem@alfa.com', senha: SENHA } });
  assert.equal(errada.status, 400);
  assert.equal(naoExiste.status, 400);
  assert.equal(errada.corpo.erro, naoExiste.corpo.erro,
    'distinguir entregaria quais e-mails existem na plataforma');
});

test('usuário sem senha definida não entra', async () => {
  await criarTenant('Terceira', '44444444000144');
  const { rows } = await dono.query(
    `insert into usuario (tenant_id, nome, email, papel)
     values ($1,'Sem Senha','semsenha@alfa.com','consultor') returning id`, [alfa]);
  assert.ok(rows[0].id);
  const r = await req('/auth/login', { metodo: 'POST', corpo: { email: 'semsenha@alfa.com', senha: SENHA } });
  assert.equal(r.status, 400);
});

test('o token carrega o tenant e /auth/eu confirma quem é', async () => {
  const token = await entrar(req, 'gestora@alfa.com');
  const r = await req('/auth/eu', { token });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.tipo, 'usuario');
  assert.equal(r.corpo.tenant, 'Revenda Alfa');
  assert.equal(r.corpo.papel, 'gestor');
});

test('token falsificado não abre a porta', async () => {
  const token = await entrar(req, 'gestora@alfa.com');
  const adulterado = token.slice(0, -3) + 'aaa';
  assert.equal((await req('/auth/eu', { token: adulterado })).status, 401);
  assert.equal((await req('/auth/eu', { token: 'nem-parece-token' })).status, 401);
  assert.equal((await req('/auth/eu')).status, 401);
});

test('força bruta trava depois de cinco tentativas', async () => {
  for (let i = 0; i < 5; i++) {
    await req('/auth/login', { metodo: 'POST', corpo: { email: 'bruno@beta.com', senha: 'chute' + i } });
  }
  const agora = await req('/auth/login', { metodo: 'POST', corpo: { email: 'bruno@beta.com', senha: SENHA } });
  assert.equal(agora.status, 400);
  assert.match(agora.corpo.erro, /tentativas demais/, 'trava mesmo com a senha certa');
  assert.ok(deOutra);
});

/* ---------------------------------------------------------------- produtor */

test('o convite sai de quem tem vínculo com o produtor', async () => {
  const token = await entrar(req, 'gestora@alfa.com');
  const p = await req('/cadastro/produtores', {
    metodo: 'POST', token, corpo: { nome: 'José Cesar Sabo' },
  });
  produtorId = p.corpo.id;

  const r = await req('/auth/convites', { metodo: 'POST', token, corpo: { produtorId, telefone: TEL } });
  assert.equal(r.status, 201);
});

test('revenda sem vínculo não convida o produtor alheio', async () => {
  const token = await entrar(req, 'bruno@beta.com', SENHA).catch(() => null);
  // bruno está bloqueado pelo teste de força bruta; usa outro gestor da Beta
  const outro = await criarUsuario(beta, 'Bia', 'bia@beta.com', 'gestor');
  assert.ok(outro);
  const t2 = await entrar(req, 'bia@beta.com');
  const r = await req('/auth/convites', {
    metodo: 'POST', token: t2, corpo: { produtorId, telefone: '5566999880022' },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /vínculo/);
  assert.equal(token, null);
});

test('produtor entra por telefone e código', async () => {
  const pedido = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  assert.equal(pedido.status, 202);
  assert.ok(pedido.corpo.codigo, 'exposto só porque AUTH_EXPOR_CODIGO=1');

  const r = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: pedido.corpo.codigo },
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.produtorId, produtorId);
});

test('telefone desconhecido responde igual a telefone conhecido', async () => {
  const conhecido = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const nao = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: '5511988887777' } });
  assert.equal(conhecido.status, nao.status);
  assert.equal(conhecido.corpo.enviado, nao.corpo.enviado);
});

test('o código só serve uma vez', async () => {
  const pedido = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const cod = pedido.corpo.codigo;
  assert.equal((await req('/auth/produtor/entrar', { metodo: 'POST', corpo: { telefone: TEL, codigo: cod } })).status, 200);
  const dnv = await req('/auth/produtor/entrar', { metodo: 'POST', corpo: { telefone: TEL, codigo: cod } });
  assert.equal(dnv.status, 400);
});

test('pedir código novo invalida o anterior', async () => {
  const primeiro = (await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } })).corpo.codigo;
  await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const r = await req('/auth/produtor/entrar', { metodo: 'POST', corpo: { telefone: TEL, codigo: primeiro } });
  assert.equal(r.status, 400);
});

/* -------------------------------------------------- os dois eixos separados */

test('a porta única: o produtor vê os vínculos dele, de todas as revendas', async () => {
  const tGestora = await entrar(req, 'gestora@alfa.com');
  const doc = [{ tipo: 'cpf', valor: '12345678909' }];
  await req('/cadastro/produtores/' + produtorId + '/documentos', {
    metodo: 'POST', token: tGestora, corpo: doc[0],
  });
  const tBia = await entrar(req, 'bia@beta.com');
  await req('/cadastro/produtores', { metodo: 'POST', token: tBia, corpo: { nome: 'J. Sabo', documentos: doc } });

  const pedido = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const { corpo } = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: pedido.corpo.codigo },
  });

  const eu = await req('/auth/eu', { token: corpo.token });
  assert.equal(eu.corpo.tipo, 'produtor');
  assert.equal(eu.corpo.vinculos.length, 2, 'um acesso, duas revendas — é a porta única');
});

test('a sessão do portal não entra na área da empresa', async () => {
  const pedido = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const { corpo } = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: pedido.corpo.codigo },
  });
  const r = await req('/cadastro/produtores', { token: corpo.token });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /área da empresa/);
});

test('só gestor abre acesso, e só de gente da própria empresa', async () => {
  // O gestor não escolhe mais a senha de ninguém: ele abre um bilhete de uma
  // viagem só e entrega. Quem escolhe a senha é o dono dela.
  const tAna = await entrar(req, 'ana@alfa.com');
  const negado = await req(`/auth/usuarios/${ana}/acesso`, { metodo: 'POST', token: tAna });
  assert.equal(negado.status, 400);
  assert.match(negado.corpo.erro, /só gestor/);

  const tGestora = await entrar(req, 'gestora@alfa.com');
  const alheio = await req(`/auth/usuarios/${deOutra}/acesso`, { metodo: 'POST', token: tGestora });
  assert.equal(alheio.status, 404, 'de outra empresa: não existe, do ponto de vista dela');

  const ok = await req(`/auth/usuarios/${ana}/acesso`, { metodo: 'POST', token: tGestora });
  assert.equal(ok.status, 201);

  const escolheu = await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: ok.corpo.token, senha: 'outra-senha-boa-123' },
  });
  assert.equal(escolheu.status, 200);
  assert.ok(await entrar(req, 'ana@alfa.com', 'outra-senha-boa-123'));
});

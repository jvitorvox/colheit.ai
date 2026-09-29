// As telas de administração: criar usuário, mudar papel, montar carteira.
//
// Até aqui tudo isso se fazia com `insert` direto no banco — todo seed e todo
// teste desta base fez assim, e passou despercebido porque o caminho do dado
// sempre existiu. O que faltava era alguém conseguir usar o sistema sem um DBA.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { comContexto } from '../api/src/contexto.js';
import { migrar } from '../api/src/migrar.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase, SENHA } from './ajuda.js';

let req, fechar, tGestor, tConsultor, consultorId, produtorId, outroProdutorId;

const usuarios = (token) => req('/cadastro/usuarios', { token });
const achar = async (email) => (await usuarios(tGestor)).corpo.find((u) => u.email === email);

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  consultorId = await criarUsuario(revenda, 'Ana Paula', 'ana@3t.com', 'consultor');
  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');
  tConsultor = await entrar(req, 'ana@3t.com');

  produtorId = (await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'José Cesar Sabo' },
  })).corpo.id;
  outroProdutorId = (await req('/cadastro/produtores', {
    metodo: 'POST', token: tGestor, corpo: { nome: 'Marli Trevisan' },
  })).corpo.id;
});

after(async () => { await fechar(); await encerrar(); });

/* --------------------------------------------------------------- usuários */

test('o gestor cria usuário, e ele nasce SEM senha', async () => {
  const r = await req('/cadastro/usuarios', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Bruno Campo', email: 'Bruno@3T.com ', papel: 'consultor' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.email, 'bruno@3t.com', 'e-mail normalizado');
  assert.equal(r.corpo.ativo, true);

  const bruno = await achar('bruno@3t.com');
  assert.equal(bruno.tem_senha, false,
    'gerar senha na criação e mostrá-la seria pôr credencial em tela que alguém fotografa');

  const semSenha = await req('/auth/login', {
    metodo: 'POST', corpo: { email: 'bruno@3t.com', senha: 'qualquer-coisa' },
  });
  assert.equal(semSenha.status, 400, 'sem senha definida, não entra');
});

test('o gestor abre acesso, e quem escolhe a senha é o dono dela', async () => {
  const bruno = await achar('bruno@3t.com');
  const r = await req(`/auth/usuarios/${bruno.id}/acesso`, {
    metodo: 'POST', token: tGestor,
  });
  assert.equal(r.status, 201);
  assert.ok(r.corpo.token, 'o link volta uma vez, para o gestor entregar');

  const escolheu = await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: r.corpo.token, senha: SENHA },
  });
  assert.equal(escolheu.status, 200);

  const entrou = await req('/auth/login', {
    metodo: 'POST', corpo: { email: 'bruno@3t.com', senha: SENHA },
  });
  assert.equal(entrou.status, 200);
});

test('o consultor lê a equipe e não escreve nela', async () => {
  // Ler ele precisa: é como sabe a quem endereçar.
  const lendo = await usuarios(tConsultor);
  assert.equal(lendo.status, 200);
  assert.ok(lendo.corpo.length >= 3);

  const criando = await req('/cadastro/usuarios', {
    metodo: 'POST', token: tConsultor,
    corpo: { nome: 'Intruso', email: 'intruso@3t.com' },
  });
  assert.equal(criando.status, 400);
  assert.match(criando.corpo.erro, /só gestor/);
});

test('a regra do gestor mora no BANCO, não só na rota', async () => {
  // Uma rota nova que esquecesse de checar o papel não abriria buraco: o
  // `with check` da política recusa a escrita vinda de um consultor.
  const tenantId = (await dono.query(
    "select tenant_id from usuario where email = 'ana@3t.com'")).rows[0].tenant_id;
  await assert.rejects(
    () => comContexto({ tenant: tenantId, usuario: consultorId }, (cx) =>
      cx.query(`insert into usuario (tenant_id, nome, email, papel)
                values (app.tenant_atual(), 'Pela Beirada', 'beirada@3t.com', 'gestor')`)),
    /row-level security|policy/i);
});

test('o papel muda, e o e-mail não — ele é a identidade de quem entra', async () => {
  const bruno = await achar('bruno@3t.com');
  const r = await req(`/cadastro/usuarios/${bruno.id}`, {
    metodo: 'PATCH', token: tGestor, corpo: { papel: 'gestor', email: 'outro@3t.com' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.papel, 'gestor');
  assert.equal(r.corpo.email, 'bruno@3t.com', 'trocar e-mail seria trocar a chave de acesso');
});

test('papel de posse da terra não serve como papel de usuário', async () => {
  // As duas listas se chamavam PAPEIS no mesmo arquivo; separá-las é o que
  // impede "arrendatario" de virar um papel de acesso.
  const r = await req('/cadastro/usuarios', {
    metodo: 'POST', token: tGestor,
    corpo: { nome: 'Confuso', email: 'confuso@3t.com', papel: 'arrendatario' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'papel');
});

test('quem sai é desativado, não apagado', async () => {
  const bruno = await achar('bruno@3t.com');
  const r = await req(`/cadastro/usuarios/${bruno.id}`, {
    metodo: 'PATCH', token: tGestor, corpo: { ativo: false },
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.ativo, false);

  const naoEntra = await req('/auth/login', {
    metodo: 'POST', corpo: { email: 'bruno@3t.com', senha: SENHA },
  });
  assert.equal(naoEntra.status, 400, 'inativo não entra');

  const aindaExiste = (await dono.query(
    "select count(*)::int as n from usuario where email = 'bruno@3t.com'")).rows[0].n;
  assert.equal(aindaExiste, 1,
    'visita, pedido e relato apontam para ele — apagar reescreveria a história');
});

test('a empresa não fica sem gestor', async () => {
  // Sem este freio, a saída seria o psql de novo — exatamente o que estas
  // telas vieram resolver.
  const ativos = (await usuarios(tGestor)).corpo
    .filter((u) => u.papel === 'gestor' && u.ativo);
  assert.equal(ativos.length, 1, 'só a Gestora, já que o Bruno foi desativado');

  const desativando = await req(`/cadastro/usuarios/${ativos[0].id}`, {
    metodo: 'PATCH', token: tGestor, corpo: { ativo: false },
  });
  assert.equal(desativando.status, 400);
  assert.match(desativando.corpo.erro, /sem gestor/);

  const rebaixando = await req(`/cadastro/usuarios/${ativos[0].id}`, {
    metodo: 'PATCH', token: tGestor, corpo: { papel: 'consultor' },
  });
  assert.equal(rebaixando.status, 400);
});

/* --------------------------------------------------------------- carteira */

test('a carteira vem com todos os produtores, marcando quem ele atende', async () => {
  const r = await req(`/cadastro/usuarios/${consultorId}/carteira`, { token: tGestor });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.length, 2);
  assert.ok(r.corpo.every((p) => p.atende === false), 'ainda não atende ninguém');
});

test('autorizar e desautorizar são do gestor, e o banco é quem recusa', async () => {
  const ok = await req('/cadastro/carteira', {
    metodo: 'POST', token: tGestor, corpo: { usuarioId: consultorId, produtorId },
  });
  assert.equal(ok.status, 201);

  const dele = await req('/visitas/fila', { token: tConsultor });
  assert.equal(dele.corpo.length, 1, 'a fila do consultor é a carteira dele');
  assert.equal(dele.corpo[0].produtor, 'José Cesar Sabo');

  // Um produtor que ele NÃO enxerga para com 404 antes de chegar à regra — a
  // política já o barra. O caso que testa a regra é um que ele enxerga: o que
  // acabou de entrar na carteira dele.
  const invisivel = await req('/cadastro/carteira', {
    metodo: 'POST', token: tConsultor,
    corpo: { usuarioId: consultorId, produtorId: outroProdutorId },
  });
  assert.equal(invisivel.status, 404, 'do ponto de vista dele, aquele produtor não existe');

  const pelaBeirada = await req('/cadastro/carteira', {
    metodo: 'POST', token: tConsultor,
    corpo: { usuarioId: consultorId, produtorId },
  });
  assert.equal(pelaBeirada.status, 400,
    'a função é security definer e checa gestor dentro dela');
  assert.match(pelaBeirada.corpo.erro, /só gestor/);

  const fora = await req('/cadastro/carteira', {
    metodo: 'DELETE', token: tGestor, corpo: { usuarioId: consultorId, produtorId },
  });
  assert.equal(fora.status, 200);
  assert.equal((await req('/visitas/fila', { token: tConsultor })).corpo.length, 0);
});

test('tirar da carteira não apaga o que ele fez', async () => {
  await req('/cadastro/carteira', {
    metodo: 'POST', token: tGestor, corpo: { usuarioId: consultorId, produtorId },
  });
  const v = await req('/visitas', {
    metodo: 'POST', token: tConsultor, corpo: { produtorId, canal: 'app', duracaoSeg: 40 },
  });
  assert.equal(v.status, 201);

  await req('/cadastro/carteira', {
    metodo: 'DELETE', token: tGestor, corpo: { usuarioId: consultorId, produtorId },
  });
  const doGestor = await req('/visitas', { token: tGestor });
  assert.ok(doGestor.corpo.some((x) => x.id === v.corpo.id),
    'o histórico de quem esteve na lavoura continua onde está');
});

test('a carteira de outra empresa não é alcançável', async () => {
  const outra = await criarTenant('Agro Sul', '22222222000122', 'distribuidor');
  await criarUsuario(outra, 'Gestor Sul', 'gestor@sul.com', 'gestor');
  const tOutra = await entrar(req, 'gestor@sul.com');

  const r = await req(`/cadastro/usuarios/${consultorId}/carteira`, { token: tOutra });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.length, 0, 'ela não vê produtor nem usuário da outra');

  const tentando = await req('/cadastro/carteira', {
    metodo: 'POST', token: tOutra, corpo: { usuarioId: consultorId, produtorId },
  });
  assert.equal(tentando.status, 404);
});

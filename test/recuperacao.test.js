// Recuperação de senha: uma peça, três portas.
//
// O produtor não aparece aqui de propósito — ele nunca teve senha, e telefone
// mais código pelo WhatsApp já é o caminho de volta dele desde o 010.
//
// O que se testa é o bilhete: que ele vale uma vez, que morre no prazo, que
// nunca fica legível no banco, e que a porta do gestor recusa quem não é
// gestor por dentro da função, não pela rota.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { usarCorreio } from '../api/src/modulos/auth/correio.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase, SENHA } from './ajuda.js';

let req, fechar, tGestor, brunoId, anaId;
const caixa = [];

const NOVA = 'senha-nova-do-bruno-1';
const idDe = async (email) =>
  (await dono.query('select id from usuario where email = $1', [email])).rows[0].id;

/** O token como quem recebe o e-mail o vê: dentro do link, depois do `#`. */
const tokenDoEmail = (msg) => new URL(msg.texto.match(/https?:\/\/\S+/)[0]).hash.match(/senha=(.+)$/)[1];

// `mensagem` é o que ESTE pedido pôs na caixa, não o que já estava lá: o teste
// que pede dois links seguidos precisa do segundo, e o que pede para um e-mail
// inventado precisa de nada.
async function pedirPorEmail(email) {
  const antes = caixa.length;
  const r = await req('/auth/esqueci', { metodo: 'POST', corpo: { email } });
  assert.equal(r.status, 202);
  return { resposta: r.corpo, mensagem: caixa.length > antes ? caixa.at(-1) : null };
}

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  // APP_URL é lido a cada envio, e sem ele o link sairia sem servidor nenhum.
  process.env.APP_URL = 'https://colheitai.exemplo/';

  const revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  await criarUsuario(revenda, 'Bruno Campo', 'bruno@3t.com', 'consultor');
  await criarUsuario(revenda, 'Ana Paula', 'ana@3t.com', 'consultor');
  brunoId = await idDe('bruno@3t.com');
  anaId = await idDe('ana@3t.com');

  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');
});

// O freio de um minuto é por pessoa e mede tempo de verdade: sem limpar a
// tabela, o segundo teste a pedir um link para o mesmo usuário não receberia
// nada e pareceria um bug do fluxo.
beforeEach(() => {
  caixa.length = 0;
  return dono.query('truncate recuperacao_senha');
});

after(async () => {
  usarCorreio(null);
  await fechar();
  await encerrar();
});

/* ------------------------------------------------- porta 1: esqueci */

test('sem correio, a tela manda procurar o gestor em vez de esperar e-mail', async () => {
  usarCorreio(null);
  const r = await req('/auth/esqueci', { metodo: 'POST', corpo: { email: 'bruno@3t.com' } });
  assert.equal(r.status, 202);
  assert.equal(r.corpo.autoatendimento, false);
  assert.match(r.corpo.enviado, /gestor/);

  // E nada foi aberto: bilhete que ninguém pode receber só encostaria no freio
  // de um minuto e atrapalharia um pedido legítimo logo depois.
  const { rows } = await dono.query('select count(*)::int as n from recuperacao_senha');
  assert.equal(rows[0].n, 0);

  usarCorreio((msg) => { caixa.push(msg); });
});

test('o e-mail traz um link que abre a escolha de senha', async () => {
  const { resposta, mensagem } = await pedirPorEmail('bruno@3t.com');
  assert.equal(resposta.autoatendimento, true);
  assert.equal(mensagem.para, 'bruno@3t.com');
  assert.match(mensagem.texto, /https:\/\/colheitai\.exemplo\/empresa#senha=/);
  assert.match(mensagem.texto, /uma vez só/);

  const r = await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: tokenDoEmail(mensagem), senha: NOVA },
  });
  assert.equal(r.status, 200);
  assert.equal((await req('/auth/login', {
    metodo: 'POST', corpo: { email: 'bruno@3t.com', senha: NOVA },
  })).status, 200);
});

test('e-mail que não existe responde exatamente igual, e não manda nada', async () => {
  const conhecido = await pedirPorEmail('bruno@3t.com');
  const inventado = await pedirPorEmail('ninguem@3t.com');

  // Só `enviado` e `autoatendimento` saem em produção. O `token` que aparece
  // ao lado deles aqui é o AUTH_EXPOR_CODIGO do ambiente de teste, e é
  // justamente o que a rota não devolve quando não está ligado.
  assert.equal(inventado.resposta.enviado, conhecido.resposta.enviado,
    'formulário público de recuperação é o jeito mais fácil de virar lista de quem tem conta');
  assert.equal(inventado.resposta.autoatendimento, conhecido.resposta.autoatendimento);
  assert.equal(inventado.mensagem, null);
});

test('pedir duas vezes seguidas não vira duas mensagens na caixa', async () => {
  await pedirPorEmail('bruno@3t.com');
  const segundo = await req('/auth/esqueci', { metodo: 'POST', corpo: { email: 'bruno@3t.com' } });
  assert.equal(segundo.status, 202);
  assert.equal(caixa.length, 1, 'o freio é por pessoa, e não conta como falha de login');
});

test('o link destranca quem se trancou tentando lembrar a senha', async () => {
  for (let i = 0; i < 6; i += 1) {
    await req('/auth/login', { metodo: 'POST', corpo: { email: 'ana@3t.com', senha: 'chute' } });
  }
  const travado = await req('/auth/login', {
    metodo: 'POST', corpo: { email: 'ana@3t.com', senha: SENHA },
  });
  assert.match(travado.corpo.erro, /tentativas demais/);

  const { mensagem } = await pedirPorEmail('ana@3t.com');
  await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: tokenDoEmail(mensagem), senha: 'senha-nova-da-ana-1' },
  });

  const entrou = await req('/auth/login', {
    metodo: 'POST', corpo: { email: 'ana@3t.com', senha: 'senha-nova-da-ana-1' },
  });
  assert.equal(entrou.status, 200,
    'sem isto ele acabaria de escolher uma senha para continuar bloqueado 15 minutos');
});

/* ------------------------------------------------- o bilhete em si */

test('serve uma vez', async () => {
  const { mensagem } = await pedirPorEmail('bruno@3t.com');
  const token = tokenDoEmail(mensagem);

  assert.equal((await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token, senha: NOVA },
  })).status, 200);

  const denovo = await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token, senha: 'outra-senha-qualquer-1' },
  });
  assert.equal(denovo.status, 400);
  assert.match(denovo.corpo.erro, /não vale mais/);
});

test('abrir outro mata o anterior', async () => {
  const primeiro = tokenDoEmail((await pedirPorEmail('bruno@3t.com')).mensagem);
  await dono.query('truncate recuperacao_senha');   // pula o freio de um minuto
  const segundo = tokenDoEmail((await pedirPorEmail('bruno@3t.com')).mensagem);

  assert.equal((await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: segundo, senha: NOVA },
  })).status, 200);

  // O primeiro morreu no instante em que a senha mudou, não só quando foi usado.
  assert.equal((await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: primeiro, senha: 'mais-uma-senha-1' },
  })).status, 400);
});

test('vencido não vale', async () => {
  const { mensagem } = await pedirPorEmail('bruno@3t.com');
  await dono.query(
    "update recuperacao_senha set expira_em = now() - interval '1 second' where usuario_id = $1",
    [brunoId]);

  const r = await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: tokenDoEmail(mensagem), senha: NOVA },
  });
  assert.equal(r.status, 400);
});

test('o banco nunca vê o token em claro', async () => {
  const { mensagem } = await pedirPorEmail('bruno@3t.com');
  const token = tokenDoEmail(mensagem);
  const { rows } = await dono.query('select token_hash from recuperacao_senha');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token,
    'ele vale uma senha enquanto vive, e viaja por canal que não controlamos');
});

test('senha curta é recusada com 400, e o bilhete continua valendo', async () => {
  const { mensagem } = await pedirPorEmail('bruno@3t.com');
  const token = tokenDoEmail(mensagem);

  const curta = await req('/auth/redefinir', { metodo: 'POST', corpo: { token, senha: 'curta' } });
  assert.equal(curta.status, 400, 'senha de cinco letras não é erro de programa');
  assert.equal(curta.corpo.campo, 'senha');

  assert.equal((await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token, senha: NOVA },
  })).status, 200, 'gastar o bilhete num erro de digitação seria obrigar a pedir outro');
});

test('conta desativada no meio do caminho derruba o link', async () => {
  const { mensagem } = await pedirPorEmail('bruno@3t.com');
  await dono.query('update usuario set ativo = false where id = $1', [brunoId]);

  const r = await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: tokenDoEmail(mensagem), senha: NOVA },
  });
  assert.equal(r.status, 400);
  await dono.query('update usuario set ativo = true where id = $1', [brunoId]);
});

/* ------------------------------------------------- porta 2: o gestor */

test('o gestor abre acesso sem nunca saber a senha', async () => {
  const r = await req(`/auth/usuarios/${anaId}/acesso`, { metodo: 'POST', token: tGestor });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.horas, 24, 'é entregue fora do sistema, para quem talvez esteja sem sinal');
  assert.equal(caixa.length, 0, 'esta porta não passa por e-mail nenhum');

  assert.equal((await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: r.corpo.token, senha: 'senha-que-so-a-ana-sabe-1' },
  })).status, 200);
});

test('o consultor não abre acesso, e quem recusa é a função', async () => {
  // Ele enxerga o colega — a tela Equipe depende disso —, então a política
  // deixa passar e a recusa vem de dentro de app.abrir_recuperacao_pelo_gestor.
  const tConsultor = await entrar(req, 'ana@3t.com', 'senha-que-so-a-ana-sabe-1');
  const r = await req(`/auth/usuarios/${brunoId}/acesso`, { metodo: 'POST', token: tConsultor });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /só gestor/);
});

test('gestor de outra empresa não alcança', async () => {
  const outra = await criarTenant('Agro Sul', '22222222000122', 'distribuidor');
  await criarUsuario(outra, 'Gestor Sul', 'gestor@sul.com', 'gestor');
  const tOutra = await entrar(req, 'gestor@sul.com');

  const r = await req(`/auth/usuarios/${brunoId}/acesso`, { metodo: 'POST', token: tOutra });
  assert.equal(r.status, 404, 'do ponto de vista dele, aquela pessoa não existe');
});

test('o gestor não define mais senha de ninguém — a rota saiu', async () => {
  const r = await req(`/auth/usuarios/${brunoId}/senha`, {
    metodo: 'POST', token: tGestor, corpo: { senha: 'senha-do-gestor-1' },
  });
  assert.equal(r.status, 404,
    'senha que duas pessoas conhecem não é senha, e ela ainda passaria por uma mensagem');
});

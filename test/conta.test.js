// Autoatendimento de cadastro: a empresa abrindo a própria conta.
//
// Duas coisas são o miolo daqui, e as duas vêm de `documento` e `email` serem
// únicos no banco: nada nasce no envio do formulário, e a tela responde igual
// nos três desfechos. O que se testa é exatamente isso — e que o CNPJ de uma
// empresa de verdade continua livre enquanto ninguém abre o e-mail.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { usarCorreio } from '../api/src/modulos/auth/correio.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

let req, fechar;
const caixa = [];

const CNPJ_TOMADO = '11222333000181';
const SENHA_NOVA = 'senha-da-empresa-1';

/**
 * Um CNPJ com dígito verificador válido a partir de uma base de 12 dígitos.
 *
 * Cada teste precisa do seu: `tenant.documento` é único, e o teste anterior
 * deixou o dele em uso — um CNPJ fixo faria os seguintes caírem em
 * "empresa_existe" e o arquivo mentiria sobre o que está provando.
 */
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

const linkDo = (msg) => new URL(msg.texto.match(/https?:\/\/\S+/)[0]);
const tokenDe = (msg, chave) => linkDo(msg).hash.match(new RegExp(`${chave}=(.+)$`))[1];

async function pedir(corpo) {
  const antes = caixa.length;
  const r = await req('/conta/cadastro', { metodo: 'POST', corpo });
  return { status: r.status, corpo: r.corpo, mensagem: caixa.length > antes ? caixa.at(-1) : null };
}

let seq = 100;
const pedidoValido = (extra = {}) => ({
  nome: 'Agro Sorriso',
  documento: cnpj(seq += 1),
  tipo: 'revenda',
  gestor: 'Marina Alves',
  email: `marina${seq}@agrosorriso.com`,
  ...extra,
});

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  process.env.APP_URL = 'https://colheitai.exemplo';

  const existente = await criarTenant('3 Tentos', CNPJ_TOMADO, 'distribuidor');
  await criarUsuario(existente, 'Gestora', 'gestora@3t.com', 'gestor');

  ({ req, fechar } = await subirApi());
  usarCorreio((msg) => { caixa.push(msg); });
});

// O freio é de um minuto por endereço e mede tempo de verdade.
beforeEach(() => {
  caixa.length = 0;
  return dono.query('truncate cadastro_pendente, cadastro_tentativa');
});

after(async () => {
  usarCorreio(null);
  await fechar();
  await encerrar();
});

/* ------------------------------------------------- o que o formulário faz */

test('o envio não cria empresa nenhuma — só um pedido à espera do e-mail', async () => {
  const r = await pedir(pedidoValido());
  assert.equal(r.status, 202);
  assert.equal(r.corpo.autoatendimento, true);

  const empresas = await dono.query('select count(*)::int as n from tenant');
  assert.equal(empresas.rows[0].n, 1, 'só a que já existia');

  // É o ponto todo: criar no envio deixaria qualquer um plantar o CNPJ de uma
  // empresa de verdade e trancar a porta dela, sem receber e-mail nenhum.
  const pendentes = await dono.query('select count(*)::int as n from cadastro_pendente');
  assert.equal(pendentes.rows[0].n, 1);
});

test('o link confirma, e aí a empresa existe — com o gestor sem senha', async () => {
  const p = pedidoValido();
  const { mensagem } = await pedir(p);
  assert.match(mensagem.assunto, /Confirme/);

  const r = await req('/conta/confirmar', {
    metodo: 'POST', corpo: { token: tokenDe(mensagem, 'conta') },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.empresa, 'Agro Sorriso');
  assert.ok(r.corpo.token, 'emenda direto na escolha da senha');

  const { rows } = await dono.query(`
    select t.origem, t.tipo, u.papel, u.senha_hash
      from tenant t join usuario u on u.tenant_id = t.id
     where t.documento = $1`, [p.documento]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origem, 'autoatendimento');
  assert.equal(rows[0].papel, 'gestor', 'empresa sem gestor é empresa que ninguém abre');
  assert.equal(rows[0].senha_hash, null, 'nem este código chega a saber a senha dela');
});

test('a senha sai do mesmo bilhete, e o gestor entra', async () => {
  const p = pedidoValido();
  const { mensagem } = await pedir(p);
  const confirmou = await req('/conta/confirmar', {
    metodo: 'POST', corpo: { token: tokenDe(mensagem, 'conta') },
  });

  assert.equal((await req('/auth/redefinir', {
    metodo: 'POST', corpo: { token: confirmou.corpo.token, senha: SENHA_NOVA },
  })).status, 200);

  const eu = await req('/auth/eu', { token: await entrar(req, p.email, SENHA_NOVA) });
  assert.equal(eu.corpo.papel, 'gestor');
  assert.equal(eu.corpo.tenant, 'Agro Sorriso');
});

/* ------------------------------------------- uma resposta, três desfechos */

test('CNPJ que já é cliente responde igual na tela, e diferente no e-mail', async () => {
  const nova = await pedir(pedidoValido());
  const tomada = await pedir(pedidoValido({ documento: CNPJ_TOMADO }));

  assert.equal(tomada.corpo.enviado, nova.corpo.enviado,
    'dizer na tela entregaria, a quem for tentando um CNPJ de cada vez, a lista de clientes');
  assert.match(tomada.mensagem.texto, /já tem conta/);
  assert.doesNotMatch(tomada.mensagem.texto, /https?:\/\//, 'aviso não leva link');
  assert.doesNotMatch(tomada.mensagem.texto, /Gestora/, 'nem nomeia quem administra');

  const { rows } = await dono.query(
    'select count(*)::int as n from cadastro_pendente where documento = $1', [CNPJ_TOMADO]);
  assert.equal(rows[0].n, 0, 'nem pendente fica');
});

test('e-mail que já tem conta é mandado para a entrada, não para um cadastro novo', async () => {
  const r = await pedir(pedidoValido({ email: 'gestora@3t.com' }));
  assert.equal(r.status, 202);
  assert.match(r.mensagem.texto, /Esqueci minha senha/);
  assert.doesNotMatch(r.mensagem.texto, /https?:\/\//);
});

test('o freio vale para os três desfechos, não só para o que cria pendência', async () => {
  // Quem escolhe o endereço é quem preenche o formulário. Se o freio contasse
  // só pendências, um CNPJ que já é cliente — que não cria pendência nenhuma —
  // viraria uma torneira de e-mail apontada para a caixa de qualquer um.
  const alvo = 'vitima@exemplo.com';
  await pedir(pedidoValido({ documento: CNPJ_TOMADO, email: alvo }));
  assert.equal(caixa.length, 1);

  for (let i = 0; i < 5; i += 1) {
    await pedir(pedidoValido({ documento: CNPJ_TOMADO, email: alvo }));
  }
  assert.equal(caixa.length, 1, 'um por minuto por endereço, dê no que der');
});

test('dois pedidos seguidos do mesmo e-mail não viram duas mensagens', async () => {
  const p = pedidoValido();
  await pedir(p);
  const segundo = await pedir({ ...p, documento: cnpj(seq += 1) });
  assert.equal(segundo.status, 202);
  assert.equal(segundo.mensagem, null, 'o freio é por endereço, e a resposta não muda');
});

/* --------------------------------------------------------- o que recusa */

test('CNPJ que não fecha o dígito não passa', async () => {
  const r = await req('/conta/cadastro', {
    metodo: 'POST', corpo: pedidoValido({ documento: '11111111111111' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'documento');
  assert.equal(caixa.length, 0, 'o filtro mais barato contra robô');
});

test('não dá para se declarar franqueadora pelo formulário', async () => {
  const r = await req('/conta/cadastro', {
    metodo: 'POST', corpo: pedidoValido({ tipo: 'franqueadora' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.campo, 'tipo');
});

test('e mesmo se conseguisse, tipo não manda em visibilidade nenhuma', async () => {
  // O rótulo não abre porta: quem enxerga a rede é a tabela `rede`, e só o
  // papel dono escreve nela. Uma franqueadora sem rede vê a si mesma e nada mais.
  const sozinha = await criarTenant('Rede Fantasma', '19131243000197', 'franqueadora');
  await criarUsuario(sozinha, 'Dono', 'dono@fantasma.com', 'gestor');
  const t = await entrar(req, 'dono@fantasma.com');

  const r = await req('/painel', { token: t });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.rede ?? null, null, 'rótulo de franqueadora sem rede não enxerga rede');
});

test('o link confirma uma vez só', async () => {
  const { mensagem } = await pedir(pedidoValido());
  const token = tokenDe(mensagem, 'conta');

  assert.equal((await req('/conta/confirmar', { metodo: 'POST', corpo: { token } })).status, 201);

  const denovo = await req('/conta/confirmar', { metodo: 'POST', corpo: { token } });
  assert.equal(denovo.status, 400);
  assert.match(denovo.corpo.erro, /não vale mais/);
});

test('quem confirma primeiro fica com o CNPJ, e o segundo não cria nada', async () => {
  const p = pedidoValido();
  const primeiro = await pedir({ ...p, email: 'primeiro@exemplo.com' });
  // Os dois pedidos são do mesmo CNPJ, e nenhum dos dois criou empresa ainda —
  // é justamente o intervalo em que a porta fica aberta para os dois.
  const segundo = await pedir({ ...p, email: 'segundo@exemplo.com' });

  assert.equal((await req('/conta/confirmar', {
    metodo: 'POST', corpo: { token: tokenDe(primeiro.mensagem, 'conta') },
  })).status, 201);

  const perdeu = await req('/conta/confirmar', {
    metodo: 'POST', corpo: { token: tokenDe(segundo.mensagem, 'conta') },
  });
  assert.equal(perdeu.status, 400);
  assert.match(perdeu.corpo.erro, /já tem conta/);

  const { rows } = await dono.query(
    'select count(*)::int as n from tenant where documento = $1', [p.documento]);
  assert.equal(rows[0].n, 1, 'a transação inteira voltou: nem empresa, nem usuário');
});

test('link vencido não confirma', async () => {
  const { mensagem } = await pedir(pedidoValido());
  await dono.query("update cadastro_pendente set expira_em = now() - interval '1 second'");

  const r = await req('/conta/confirmar', {
    metodo: 'POST', corpo: { token: tokenDe(mensagem, 'conta') },
  });
  assert.equal(r.status, 400);
});

test('sem correio, o autoatendimento não existe naquela instalação', async () => {
  usarCorreio(null);
  const r = await req('/conta/cadastro', { metodo: 'POST', corpo: pedidoValido() });
  assert.equal(r.status, 202);
  assert.equal(r.corpo.autoatendimento, false);

  const { rows } = await dono.query('select count(*)::int as n from cadastro_pendente');
  assert.equal(rows[0].n, 0, 'aceitar o formulário sem poder confirmar seria fingir');
  usarCorreio((msg) => { caixa.push(msg); });
});

test('a rota é pública, e é a única que é', async () => {
  // Sem token nenhum. `/cadastro` fica atrás de `identificar`, e é o par mais
  // fácil de confundir na hora de mexer no server.js.
  assert.equal((await req('/conta/cadastro', {
    metodo: 'POST', corpo: pedidoValido(),
  })).status, 202);
  assert.equal((await req('/cadastro/produtores')).status, 401);
});

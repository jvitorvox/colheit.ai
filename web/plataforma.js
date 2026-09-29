// Moderação de cadastro — a área da plataforma.
//
// É a quarta casca, e a menor: uma fila e três botões. Ela existe porque o
// autoatendimento deixou um limite conhecido — quem confirma primeiro fica com
// o CNPJ —, e desfazer isso era ligação para o suporte sem ferramenta nenhuma.
//
// O que esta tela NÃO faz é tão importante quanto o que faz: ela não abre a
// conta de ninguém, não mostra pedido, produtor, visita nem receita. Isso não é
// uma decisão desta camada — a sessão de plataforma não tem tenant, e sem
// tenant nenhuma política de negócio casa no banco. Aqui só chega o que as
// funções de moderação devolvem.

const SESSAO = 'colheitai.plataforma';
const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

const estado = { token: localStorage.getItem(SESSAO), eu: null };

const cnpj = (d) => String(d ?? '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const quando = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

async function api(caminho, { metodo = 'GET', corpo } = {}) {
  const resp = await fetch(caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(estado.token ? { authorization: `Bearer ${estado.token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await resp.json().catch(() => null);
  if (resp.status === 401) { sair(); throw new Error('sessão expirada'); }
  if (!resp.ok) throw new Error(dados?.erro ?? `erro ${resp.status}`);
  return dados;
}

function sair() {
  localStorage.removeItem(SESSAO);
  estado.token = null; estado.eu = null;
  desenhar();
}

/* ------------------------------------------------------------------ entrar */

function telaEntrar() {
  const c = el('div', 'entrada cartao');
  c.append(el('h1', 'marca', 'colheit.ai'), el('p', 'sub', 'Plataforma'));

  const form = el('form');
  const email = el('input');
  Object.assign(email, { type: 'email', required: true, autocomplete: 'username' });
  const senha = el('input');
  Object.assign(senha, { type: 'password', required: true, autocomplete: 'current-password' });
  const botao = el('button', 'botao', 'Entrar'); botao.type = 'submit';
  const erro = el('p', 'erro');

  form.append(el('label', 'rotulo', 'E-mail'), email,
    el('div', 'campo'), el('label', 'rotulo', 'Senha'), senha, botao, erro);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    botao.disabled = true; erro.textContent = '';
    try {
      const r = await api('/auth/plataforma/entrar', {
        metodo: 'POST', corpo: { email: email.value, senha: senha.value },
      });
      localStorage.setItem(SESSAO, r.token);
      estado.token = r.token;
      await desenhar();
    } catch (e) { erro.textContent = e.message; botao.disabled = false; }
  };

  // Sem "esqueci minha senha" de propósito: esta conta não tem gestor acima
  // dela nem outro moderador a quem pedir. Quem esquece depende da máquina —
  // `npm run admin -- senha-plataforma` —, e é assim que tem de ser para uma
  // conta que desliga o sistema de uma empresa inteira.
  c.append(form);
  $('#raiz').replaceChildren(c);
  email.focus();
}

/* ------------------------------------------------------- escolher a senha */

function telaNovaSenha(token) {
  const c = el('div', 'entrada cartao');
  c.append(el('h1', 'marca', 'colheit.ai'), el('p', 'sub', 'Escolha uma senha'));

  const form = el('form');
  const senha = el('input');
  Object.assign(senha, { type: 'password', required: true, minLength: 8, autocomplete: 'new-password' });
  const repete = el('input');
  Object.assign(repete, { type: 'password', required: true, minLength: 8, autocomplete: 'new-password' });
  const botao = el('button', 'botao', 'Salvar senha'); botao.type = 'submit';
  const erro = el('p', 'erro');

  form.append(el('label', 'rotulo', 'Nova senha (mínimo 8 caracteres)'), senha,
    el('div', 'campo'), el('label', 'rotulo', 'Repita a senha'), repete, botao, erro);

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    erro.textContent = '';
    // Conferido aqui porque é erro de digitação, não de regra: mandar para a
    // API gastaria o bilhete, que serve uma vez só.
    if (senha.value !== repete.value) { erro.textContent = 'as duas senhas não são iguais'; return; }
    botao.disabled = true;
    try {
      await api('/auth/redefinir', { metodo: 'POST', corpo: { token, senha: senha.value } });
      sair();
      alerta('Senha salva. Agora é só entrar.', 'Pronto');
    } catch (e) { erro.textContent = e.message; botao.disabled = false; }
  };

  c.append(form);
  $('#raiz').replaceChildren(c);
  senha.focus();
}

/* -------------------------------------------------------------- a fila */

async function telaFila() {
  const raiz = $('#raiz');
  raiz.replaceChildren();

  const topo = el('div', 'topo');
  topo.append(el('h2', null, 'Moderação de cadastro'));
  const quem = el('div', 'quem');
  const sairBotao = el('button', 'botao vazado pequeno', 'Sair');
  sairBotao.onclick = sair;
  quem.append(el('span', null, `${estado.eu.nome} · `), sairBotao);
  topo.append(quem);
  raiz.append(topo);

  const alcance = el('p', 'alcance');
  alcance.append(
    el('b', null, 'O que esta conta vê: '),
    el('span', null, 'nome da empresa, CNPJ, quem pediu, quando e quantos usuários. '),
    el('b', null, 'O que ela não vê: '),
    el('span', null, 'pedido, produtor, visita, caderno ou receita de nenhum cliente.'));
  raiz.append(alcance);

  const { empresas, pendentes } = await api('/plataforma/moderacao');

  raiz.append(grupoPendentes(pendentes));
  raiz.append(grupoEmpresas(empresas));
}

function grupoPendentes(lista) {
  const g = el('div', 'grupo');
  g.append(el('h3', null, `A caminho (${lista.length})`));
  g.append(el('p', 'sub',
    'Pedidos com o e-mail ainda por confirmar. Nada existe até alguém abrir o '
    + 'link — enquanto estiverem aqui, o CNPJ continua livre.'));

  if (lista.length === 0) {
    g.append(el('p', 'vazio', 'Nenhum pedido a caminho.'));
    return g;
  }

  lista.forEach((p) => {
    const f = el('div', 'ficha pendente');
    const l1 = el('div', 'linha1');
    l1.append(el('span', 'nome', p.nome), el('span', 'cnpj', cnpj(p.documento)),
      el('span', 'etiqueta', p.tipo));
    f.append(l1);
    f.append(el('p', 'quem',
      `${p.gestor_nome} · ${p.gestor_email} · pedido em ${quando(p.criado_em)} · `
      + `vence ${quando(p.expira_em)}`));
    g.append(f);
  });
  return g;
}

function grupoEmpresas(lista) {
  const porOlhar = lista.filter((e) => !e.revisado_em).length;
  const g = el('div', 'grupo');
  g.append(el('h3', null, `Nasceram pela tela (${lista.length})`));
  g.append(el('p', 'sub', porOlhar
    ? `${porOlhar} ainda sem revisão — aparecem primeiro.`
    : 'Todas revisadas.'));

  if (lista.length === 0) {
    g.append(el('p', 'vazio', 'Nenhuma empresa nasceu pela tela ainda.'));
    return g;
  }

  lista.forEach((e) => g.append(fichaEmpresa(e)));
  return g;
}

function fichaEmpresa(e) {
  const f = el('div', 'ficha');
  const l1 = el('div', 'linha1');
  l1.append(el('span', 'nome', e.nome), el('span', 'cnpj', cnpj(e.documento)),
    el('span', 'etiqueta', e.tipo));

  if (e.liberado_em) l1.append(el('span', 'etiqueta', 'recusada · CNPJ solto'));
  else if (!e.ativo) l1.append(el('span', 'etiqueta', 'desligada'));
  else if (e.revisado_em) l1.append(el('span', 'etiqueta boa', 'aprovada'));
  else l1.append(el('span', 'etiqueta atencao', 'sem revisão'));
  f.append(l1);

  f.append(el('p', 'quem',
    `${e.gestor ?? '—'} · ${e.gestor_email ?? '—'} · criada em ${quando(e.criado_em)} · `
    + `${e.usuarios} usuário(s)`));

  if (e.revisado_em) {
    f.append(el('p', 'nota',
      `${e.liberado_em ? 'Recusada' : 'Aprovada'} por ${e.revisado_por ?? '—'} `
      + `em ${quando(e.revisado_em)}${e.revisao_nota ? `: ${e.revisao_nota}` : ''}`));
  }

  const acoes = el('div', 'acoes');
  if (e.liberado_em) {
    // Reabrir pode falhar, e falha por um bom motivo: entre a recusa e o
    // arrependimento o dono de verdade pode ter se cadastrado com o CNPJ.
    acoes.append(botao('Reabrir', 'vazado', () => moderar(e.id, 'reabrir')));
  } else {
    if (!e.revisado_em) acoes.append(botao('Aprovar', '', () => moderar(e.id, 'aprovar')));
    acoes.append(botao('Recusar e soltar o CNPJ', 'vazado', () => janelaRecusa(e)));
  }
  f.append(acoes);
  return f;
}

function botao(texto, extra, aoClicar) {
  const b = el('button', `botao ${extra} pequeno`.trim(), texto);
  b.onclick = aoClicar;
  return b;
}

/**
 * Recusar pede o motivo, e o banco é quem exige.
 *
 * Recusar desliga o sistema de uma empresa inteira e devolve o CNPJ dela. Quem
 * atender a ligação de "por que minha conta parou" precisa ler por quê — e uma
 * regra dessas não pode depender de esta tela lembrar de perguntar.
 */
function janelaRecusa(e) {
  const d = $('#janela');
  d.replaceChildren(el('h3', null, `Recusar ${e.nome}`));
  d.append(el('p', 'sub',
    `A empresa é desligada e o CNPJ ${cnpj(e.documento)} volta a ficar livre para `
    + 'quem for dono dele. O cadastro continua registrado aqui.'));

  const form = el('form');
  const nota = el('textarea');
  nota.required = true;
  nota.placeholder = 'Ex.: CNPJ da Agro Sorriso usado por terceiro; dono confirmou por telefone.';
  const erro = el('p', 'erro');
  const fim = el('div', 'fim');
  const cancelar = el('button', 'botao vazado pequeno', 'Cancelar');
  cancelar.type = 'button';
  cancelar.onclick = () => d.close();
  const ok = el('button', 'botao pequeno', 'Recusar');
  ok.type = 'submit';
  fim.append(cancelar, ok);
  form.append(el('label', 'rotulo', 'Motivo'), nota, erro, fim);

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    ok.disabled = true; erro.textContent = '';
    try {
      await api(`/plataforma/moderacao/${e.id}`, {
        metodo: 'POST', corpo: { acao: 'recusar', nota: nota.value },
      });
      d.close();
      await desenhar();
    } catch (err) { erro.textContent = err.message; ok.disabled = false; }
  };

  d.append(form);
  d.showModal();
  nota.focus();
}

async function moderar(id, acao) {
  try {
    await api(`/plataforma/moderacao/${id}`, { metodo: 'POST', corpo: { acao } });
    await desenhar();
  } catch (e) { alerta(e.message); }
}

function alerta(texto, titulo = 'Não deu') {
  const d = $('#janela');
  d.replaceChildren(el('h3', null, titulo), el('p', 'sub', texto));
  const fim = el('div', 'fim');
  const ok = el('button', 'botao pequeno', 'Entendi');
  ok.onclick = () => d.close();
  fim.append(ok);
  d.append(fim);
  d.showModal();
}

/* ------------------------------------------------------------------ rotas */

async function desenhar() {
  if (!estado.token) { telaEntrar(); return; }
  try {
    if (!estado.eu) estado.eu = await api('/plataforma/eu');
  } catch (e) {
    if (e.message !== 'sessão expirada') sair();
    return;
  }

  try {
    await telaFila();
  } catch (e) {
    $('#raiz').append(el('p', 'vazio', e.message));
  }
}

// O bilhete de senha desta casca aponta para cá, e não para /empresa: mandar
// quem modera para a porta do cliente daria um link que funciona e uma tela de
// entrada onde ele não consegue entrar.
function abrirBilheteDaUrl() {
  const bilhete = new URLSearchParams(location.hash.slice(1)).get('senha');
  if (!bilhete) return false;
  history.replaceState(null, '', location.pathname);
  $('#janela').close();
  telaNovaSenha(bilhete);
  return true;
}

addEventListener('hashchange', abrirBilheteDaUrl);
if (!abrirBilheteDaUrl()) desenhar();

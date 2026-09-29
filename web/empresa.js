// Console da empresa — gestor e consultor.
//
// Mesma abordagem do portal: sem empacotador. O que muda é o público. Aqui é
// mesa, tabela e ação; lá é bolso e leitura.

const SESSAO = 'colheitai.empresa';
const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};
const num = (n) => Number(n ?? 0).toLocaleString('pt-BR');
const brl = (n) => Number(n ?? 0).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
/**
 * Uma data na tela.
 *
 * Coluna `date` chega como `2026-10-12`, sem hora, e é montada pelas partes:
 * `new Date('2026-10-12')` é meia-noite em UTC, e a oeste de Greenwich isso
 * desenha o dia ANTERIOR — vencimento de nota, emissão, vigência de preço,
 * todos um dia antes para qualquer usuário brasileiro, e silenciosamente.
 *
 * O que tem hora é instante de verdade e passa pelo fuso, como deve.
 */
const dia = (d) => {
  if (!d) return '—';
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [a, m, j] = s.split('-');
    return `${j}/${m}/${a}`;
  }
  return new Date(s).toLocaleDateString('pt-BR');
};

const estado = { token: localStorage.getItem(SESSAO), eu: null, aba: 'painel', safra: null };

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

/**
 * Traz o binário e devolve uma URL de blob.
 *
 * `<audio src="/midia/…">` não carregaria o token — o navegador não manda
 * cabeçalho em tag de mídia. Buscar com a sessão e tocar o blob mantém a rota
 * privada como ela é: quem não passa pela política não recebe byte.
 */
async function midiaUrl(id) {
  const resp = await fetch(`/midia/${id}`, {
    headers: estado.token ? { authorization: `Bearer ${estado.token}` } : {},
  });
  if (!resp.ok) throw new Error(`mídia ${resp.status}`);
  const blob = await resp.blob();
  return { url: URL.createObjectURL(blob), tipo: blob.type };
}

function sair() {
  localStorage.removeItem(SESSAO);
  estado.token = null; estado.eu = null;
  desenhar();
}

/* ------------------------------------------------------------------ entrar */

function telaEntrar() {
  document.body.classList.add('entrando');
  const c = el('div', 'entrada cartao');
  c.append(el('h1', 'marca', 'colheit.ai'));
  c.append(el('p', 'sub', 'Área da empresa'));

  const form = el('form');
  const email = el('input'); Object.assign(email, { type: 'email', required: true, autocomplete: 'username' });
  const senha = el('input'); Object.assign(senha, { type: 'password', required: true, autocomplete: 'current-password' });
  const botao = el('button', 'botao', 'Entrar'); botao.type = 'submit';
  const erro = el('p', 'erro');

  const esqueci = el('button', 'elo', 'Esqueci minha senha');
  esqueci.type = 'button';
  esqueci.onclick = () => janelaEsqueci(email.value);

  form.append(el('label', 'rotulo', 'E-mail'), email,
    el('div', 'campo'), el('label', 'rotulo', 'Senha'), senha, botao, erro, esqueci);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    botao.disabled = true; erro.textContent = '';
    try {
      const r = await api('/auth/login', {
        metodo: 'POST', corpo: { email: email.value, senha: senha.value },
      });
      localStorage.setItem(SESSAO, r.token);
      estado.token = r.token;
      await desenhar();
    } catch (e) { erro.textContent = e.message; botao.disabled = false; }
  };

  c.append(form);
  $('#raiz').replaceChildren(c);
  email.focus();
}

/* ------------------------------------------------------ recuperar a senha */

/**
 * Esqueci minha senha.
 *
 * A resposta vem pronta da API e é mostrada como veio, sem a tela inventar
 * nada em cima: é ela que sabe se aquela instalação manda e-mail, e é ela que
 * responde igual para e-mail conhecido e desconhecido. Se esta tela dissesse
 * "enviamos para você", estaria afirmando o que não sabe — e entregando quais
 * e-mails existem a quem for perguntando um a um.
 */
function janelaEsqueci(email) {
  janela('Esqueci minha senha', [
    { nome: 'email', rotulo: 'Seu e-mail', tipo: 'email', valor: email },
  ], async (v) => {
    const r = await api('/auth/esqueci', { metodo: 'POST', corpo: { email: v.email } });
    // `janela` fecha e redesenha depois daqui; o aviso vem no quadro seguinte,
    // senão ele nasceria numa janela que acabou de ser fechada.
    setTimeout(() => alerta(r.enviado, 'Recuperar senha'), 0);
  }, 'Enviar');
}

/**
 * A tela de escolher a senha, aberta por um link.
 *
 * O bilhete viaja no FRAGMENTO da URL, depois do `#`, e não na busca: o que
 * vem depois do `?` chega ao servidor, entra no log de acesso e sai no
 * `Referer` de qualquer imagem que a página carregue. O fragmento fica no
 * navegador. Aqui ele é lido, apagado da barra de endereço e mandado por POST.
 *
 * Funciona com sessão ou sem — quem chegou por este link normalmente não
 * consegue entrar, que é o motivo de ele existir.
 */
function telaNovaSenha(token) {
  document.body.classList.add('entrando');
  const c = el('div', 'entrada cartao');
  c.append(el('h1', 'marca', 'colheit.ai'));
  c.append(el('p', 'sub', 'Escolha uma senha'));

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
      sair();   // sessão antiga, se houver, não serve mais como referência
      alerta('Senha salva. Agora é só entrar.', 'Pronto');
    } catch (e) { erro.textContent = e.message; botao.disabled = false; }
  };

  c.append(form);
  $('#raiz').replaceChildren(c);
  senha.focus();
}

/* ------------------------------------------------------------------ casca */

const ABAS = [
  ['painel', 'Painel'],
  ['pedidos', 'Pedidos'],
  ['carteira', 'Carteira'],
  ['funil', 'Funil'],
  ['catalogo', 'Catálogo'],
  ['visitas', 'Visitas'],
  ['caderno', 'Lavoura'],
  ['campo', 'Do campo'],
  ['equipe', 'Equipe'],
];

function casca() {
  document.body.classList.remove('entrando');
  const lado = el('aside');
  lado.append(el('div', 'marca', 'colheit.ai'));
  ABAS.forEach(([id, nome]) => {
    const b = el('button', estado.aba === id ? 'ativa' : '', nome);
    b.onclick = () => { estado.aba = id; desenhar(); };
    lado.append(b);
  });
  const quem = el('div', 'quem');
  quem.append(el('b', null, estado.eu?.nome ?? ''),
    el('span', null, `${estado.eu?.tenant ?? ''} · ${estado.eu?.papel ?? ''}`));
  const sairBotao = el('button', null, 'Sair');
  sairBotao.onclick = sair;
  quem.append(sairBotao);
  lado.append(quem);

  const principal = el('main');
  $('#raiz').replaceChildren(lado, principal);
  return principal;
}

function cabecalho(titulo, sub, acoes = []) {
  const h = el('header', 'topo');
  const t = el('div');
  t.append(el('h2', null, titulo));
  if (sub) t.append(el('p', 'sub', sub));
  h.append(t);
  if (acoes.length) {
    const caixa = el('div', 'acoes');
    acoes.forEach((a) => caixa.append(a));
    h.append(caixa);
  }
  return h;
}

function tabela(colunas, linhas, aoClicar) {
  const caixa = el('div', 'tabela');
  const t = el('table');
  const thead = el('thead');
  const tr = el('tr');
  colunas.forEach((c) => tr.append(el('th', null, c)));
  thead.append(tr);
  const tbody = el('tbody');
  linhas.forEach((celulas, i) => {
    const l = el('tr', aoClicar ? 'clicavel' : '');
    celulas.forEach((c) => {
      const td = el('td');
      td.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      l.append(td);
    });
    if (aoClicar) l.onclick = () => aoClicar(i);
    tbody.append(l);
  });
  t.append(thead, tbody);
  caixa.append(t);
  return caixa;
}

const numeroCartao = (rotulo, valor, detalhe) => {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', rotulo), el('div', 'valor', valor));
  if (detalhe) c.append(el('p', 'detalhe', detalhe));
  return c;
};

/* ----------------------------------------------------------------- painel */

/**
 * O painel do gestor.
 *
 * Uma chamada só: a API compõe, e as réguas de atenção — o que é parado
 * demais, o que é atrasado — vêm dela. A tela não decide nenhuma delas, porque
 * régua em CSS é régua que ninguém mantém.
 *
 * A ordem das seções é a ordem do dia de quem gerencia: o que está travado
 * primeiro, o que está vendendo depois, o mercado por último.
 */
async function telaPainel(main) {
  const p = await api('/painel');

  // A safra do painel vale para o resto do console — as outras telas deixam de
  // depender da constante do código.
  estado.safra = p.safra;

  main.append(cabecalho('Painel',
    `safra ${p.safra} · ${estado.eu.tenant}`
    + (p.safraVeioDe === 'calendário' ? ' · nenhuma venda registrada ainda' : '')));

  // A API devolve `null` no bloco que não tem dado, e a tela não o desenha. É
  // o que faz o mesmo painel servir ao franqueado, que não tem carteira nem
  // fila de visita: ele vê a cadeia que desceu do território dele, e não uma
  // fileira de zeros descrevendo problemas que não existem.
  const n = el('div', 'numeros');
  n.append(
    numeroCartao('Volume da safra', `${num(p.venda.quantidadeSc)} sc`,
      p.venda.bonificadaPct
        ? `${p.venda.bonificadaPct}% bonificada — não vira receita`
        : 'sem bonificada'),
    numeroCartao('Receita', brl(p.venda.receita),
      p.venda.precoMedioEfetivo ? `${brl(p.venda.precoMedioEfetivo)}/sc efetivo` : null),
  );
  if (p.venda.porCanal?.pelaDistribuidoraPct !== null) {
    n.append(numeroCartao('Pela distribuidora',
      `${num(p.venda.porCanal.pelaDistribuidoraPct)}%`,
      `${num(p.venda.porCanal.canal.quantidadeSc)} sc em `
      + `${p.venda.porCanal.canal.pedidos} pedido(s)`));
  }
  if (p.operacao) {
    n.append(numeroCartao('Pedidos em andamento', num(p.operacao.emAndamento),
      p.operacao.pior ? `${p.operacao.pior.nome} está travando` : 'nada travado'));
  }
  if (p.campo) {
    n.append(numeroCartao('Do campo, a validar', num(p.campo.relatosAValidar),
      p.campo.relatosAValidar ? 'esperando o consultor' : 'nada na fila'));
  }
  main.append(n);

  if (p.operacao) main.append(cartaoGargalo(p.operacao));
  if (p.rede) main.append(cartaoRede(p.rede));
  if (p.territorios) main.append(cartaoTerritorios(p.territorios));
  if (p.resultado) main.append(cartaoResultado(p.resultado));
  if (p.campo) main.append(cartaoCampo(p.campo));
  if (p.carteira) main.append(cartaoCarteira(p.carteira));
  if (p.mercado) main.append(cartaoMercado(p.mercado));
}

/** Onde a operação está parada — por tempo, não por contagem. */
function cartaoGargalo(op) {
  const c = el('div', op.pior ? 'cartao destaque' : 'cartao');
  c.append(el('p', 'rotulo', 'Onde a operação trava'));

  if (op.etapas.length === 0) {
    c.append(el('p', 'vazio', 'Nenhum pedido em andamento.'));
    return c;
  }

  if (op.pior) {
    const f = el('div', 'faixa');
    f.append(el('strong', null, `${op.pior.nome}: `),
      document.createTextNode(
        `mediana de ${op.pior.mediana_dias} dias parado. O mais antigo é o `
        + `${op.pior.pior_pedido}, há ${op.pior.pior_dias} dias.`));
    c.append(f);
  }

  const maior = Math.max(1, ...op.etapas.map((e) => e.pior_dias));
  const lista = el('div', 'funil');
  op.etapas.forEach((e) => {
    const l = el('div', 'faixa-etapa');
    const medidor = el('div', 'medidor');
    const barra = el('i');
    barra.style.width = `${(e.pior_dias / maior) * 100}%`;
    if (e.travando) barra.classList.add('alerta');
    medidor.append(barra);
    l.append(el('span', null, `${e.etapa} · ${e.nome}`), medidor,
      el('span', 'num', `${e.pedidos} ped · ${e.mediana_dias}d`));
    lista.append(l);
  });
  c.append(lista);
  c.append(el('p', 'detalhe',
    `Pedidos e mediana de dias parado. Acima de ${op.corteDias} dias fica marcado.`));
  return c;
}

/**
 * A rede, franqueado a franqueado.
 *
 * Só aparece para quem enxerga mais de um — na prática, a franqueadora. É o
 * recorte que não existe em nenhuma outra tela: qual franqueado está
 * entregando lavoura melhor.
 *
 * A comparação entre eles carrega a mesma ressalva das outras: são territórios
 * diferentes, com solo, clima e manejo diferentes. Quem está no topo pode
 * apenas ter a melhor terra.
 */
function cartaoRede(rede) {
  const c = el('div', 'cartao');
  const comRegiao = rede.some((f) => f.territorio);
  c.append(el('p', 'rotulo',
    comRegiao ? 'A rede, cada um contra o território dele' : 'A rede, por franqueado'));

  const maior = Math.max(1, ...rede.map((f) => Math.max(
    f.mediaPonderadaScHa ?? 0, f.territorio?.mediaPonderadaScHa ?? 0)));

  rede.forEach((f) => {
    const l = el('div', 'faixa-etapa');
    const medidor = el('div', 'medidor');
    if (f.mediaPonderadaScHa !== null) {
      const barra = el('i');
      barra.style.width = `${(f.mediaPonderadaScHa / maior) * 100}%`;
      medidor.append(barra);
    }
    // O traço é o território dele, não a média da rede: é contra a própria
    // região que o desempenho de cada um se lê.
    if (f.territorio) {
      const marca = el('b');
      marca.style.left = `${(f.territorio.mediaPonderadaScHa / maior) * 100}%`;
      marca.title = `território: ${num(f.territorio.mediaPonderadaScHa)} sc/ha`;
      medidor.append(marca);
    }
    l.append(el('span', null, f.franqueado), medidor,
      el('span', 'num', f.territorio
        ? `${f.territorio.variacaoPct > 0 ? '+' : ''}${num(f.territorio.variacaoPct)}%`
        : (f.mediaPonderadaScHa === null ? 'sem colheita' : `${num(f.mediaPonderadaScHa)} sc/ha`)));
    c.append(l);
    c.append(el('p', 'detalhe',
      `${num(f.mediaPonderadaScHa ?? 0)} sc/ha em ${num(f.areaColhidaHa)} ha`
      + (f.territorio
        ? ` · território: ${num(f.territorio.mediaPonderadaScHa)} sc/ha `
          + `em ${f.territorio.municipios} município(s)`
        : '')));
  });

  c.append(el('p', 'detalhe', comRegiao
    // A ressalva muda de conteúdo quando o número muda de sentido: comparados
    // com o próprio território, o terroir sai da conta — o que sobra é manejo,
    // escolha de cultivar e acompanhamento.
    ? 'Cada um comparado com o próprio território, que inclui quem não comprou '
      + 'da rede. Assim o solo e o clima saem da conta, e o que sobra é o que '
      + 'depende de quem trabalha ali.'
    : 'Territórios diferentes, com solo, clima e manejo diferentes — quem está '
      + 'no topo pode apenas ter a melhor terra.'));
  return c;
}

/**
 * A safra por município.
 *
 * É o recorte da distribuidora, que vende em vários territórios e não tem rede
 * a comparar: de qual região vem a melhor lavoura. E não nomeia franqueado
 * nenhum — o município está na propriedade que ela mesma cadastrou.
 *
 * Serve a qualquer um que venda em mais de um lugar, e some quando é um só.
 */
function cartaoTerritorios(lista) {
  const c = el('div', 'cartao');
  const temRegiao = lista.some((m) => m.regiao);
  c.append(el('p', 'rotulo',
    temRegiao ? 'A carteira contra a região' : 'A safra por município'));

  const maior = Math.max(1, ...lista.map((m) => Math.max(
    m.minhaMediaScHa, m.regiao?.mediaPonderadaScHa ?? 0)));

  lista.forEach((m) => {
    const l = el('div', 'faixa-etapa');
    const medidor = el('div', 'medidor');
    const barra = el('i');
    barra.style.width = `${(m.minhaMediaScHa / maior) * 100}%`;
    medidor.append(barra);
    // A régua da região é uma marca no medidor, não uma segunda barra: duas
    // barras por linha em oito municípios viram um gráfico que ninguém lê.
    if (m.regiao) {
      const marca = el('b');
      marca.style.left = `${(m.regiao.mediaPonderadaScHa / maior) * 100}%`;
      marca.title = `região: ${num(m.regiao.mediaPonderadaScHa)} sc/ha`;
      medidor.append(marca);
    }
    // Quando o município não alcançou o piso, a comparação subiu para o estado
    // — e a linha tem de dizer, senão "+2,4%" em Lucas do Rio Verde é lido como
    // se fosse contra Lucas do Rio Verde.
    l.append(el('span', null, `${m.municipio}/${m.uf}`), medidor,
      el('span', 'num', m.regiao
        ? `${m.regiao.variacaoPct > 0 ? '+' : ''}${num(m.regiao.variacaoPct)}%`
          + (m.regiao.nivel === 'estado' ? ` vs ${m.uf}` : '')
        : `${num(m.minhaMediaScHa)} sc/ha`));
    l.title = `sua carteira: ${num(m.minhaMediaScHa)} sc/ha`
      + (m.regiao ? ` · região: ${num(m.regiao.mediaPonderadaScHa)} sc/ha `
        + `(${m.regiao.produtores} produtores)` : '');
    c.append(l);
  });

  if (temRegiao) {
    // A frase é a mesma disciplina do resto: o número mistura solo, clima e
    // manejo, e a região aqui INCLUI a carteira dela — sem dizer isso, a
    // comparação parece ser contra o concorrente, e não contra o conjunto.
    c.append(el('p', 'detalhe',
      'A região inclui a sua carteira, e só aparece com pelo menos cinco '
      + 'produtores. Solo, clima e manejo mudam de um município para o outro — '
      + 'a diferença não é só de quem plantou.'));
  } else {
    c.append(el('p', 'detalhe',
      'Solo, clima e manejo mudam de um município para o outro — a diferença '
      + 'não é só de quem plantou.'));
  }
  return c;
}

/**
 * O fechamento da safra, do lado de quem vendeu.
 *
 * É o fim do laço: a semente que saiu do pedido virou saco por hectare, e o
 * número volta ao funil da safra seguinte. Os dois indicadores aqui são os que
 * mais pedem para ser lidos como não são — a média e a comparação de marcas —,
 * então cada um carrega a frase que diz de que base saiu.
 */
function cartaoResultado(r) {
  const c = el('div', 'cartao');
  const topo = el('div', 'linha');
  topo.append(el('p', 'rotulo', 'Fechamento da safra'),
    el('span', r.fechada ? 'etiqueta boa' : 'etiqueta',
      r.fechada ? 'fechada' : `${r.colhidos} de ${r.talhoes} colhidos`));
  c.append(topo);

  if (r.mediaPonderadaScHa === null) {
    c.append(el('p', 'detalhe', 'Nenhuma colheita registrada nesta safra ainda.'));
    return c;
  }

  const n = el('div', 'numeros');
  n.append(
    numeroCartao('Produtividade', `${num(r.mediaPonderadaScHa)} sc/ha`,
      r.anterior
        ? `${r.anterior.variacaoPct > 0 ? '+' : ''}${num(r.anterior.variacaoPct)}%`
          + ` sobre a safra ${r.anterior.safra}`
        : 'sem safra anterior para comparar'),
    numeroCartao('Colhido', `${num(r.totalSc)} sc`, `${num(r.areaColhidaHa)} ha`),
  );
  c.append(n);
  c.append(el('p', 'detalhe', `${r.base.charAt(0).toUpperCase()}${r.base.slice(1)}.`));

  // A nossa semente contra a do concorrente. O gestor vai ler isto como prova
  // de desempenho da semente — a ressalva existe para dificultar isso, e vem
  // colada, não num rodapé.
  const o = r.porOrigem;
  if (o?.nossa.mediaPonderadaScHa !== null && o?.demais.mediaPonderadaScHa !== null) {
    c.append(el('p', 'rotulo', 'Nossa semente e a dos outros'));
    [['Nossa', o.nossa, true], ['Concorrente', o.demais, false]].forEach(([rot, lado, nossa]) => {
      const l = el('div', 'linha');
      l.append(el('span', null, rot),
        el('span', 'id', `${num(lado.areaColhidaHa)} ha em ${lado.colhidos} talhão(ões)`),
        el('span', nossa ? 'num grande' : 'num', `${num(lado.mediaPonderadaScHa)} sc/ha`));
      c.append(l);
    });
    c.append(el('p', 'detalhe',
      `Diferença de ${num(o.diferencaScHa)} sc/ha. `
      + `${o.base.charAt(0).toUpperCase()}${o.base.slice(1)}.`));
  }

  // Quem fugiu da média, para os dois lados: é onde há decisão a tomar. O nome
  // do produtor vem junto porque "Gleba 1" é o nome mais comum do país — e num
  // painel com várias fazendas os dois extremos sairiam iguais.
  const extremo = (t) => [t.produtor, t.talhao, `${num(t.produtividadeScHa)} sc/ha`, t.cultivar]
    .filter(Boolean).join(' · ');
  // Com um talhão colhido só, melhor e pior são a mesma linha — mostrar as duas
  // seria encher a tela repetindo o mesmo dado.
  const extremos = r.melhores[0] && r.piores[0]
    && r.melhores[0].plantioId !== r.piores[0].plantioId
    ? [['Melhor', r.melhores[0]], ['Pior', r.piores[0]]]
    : [['Colhido', r.melhores[0]]];
  extremos.filter(([, t]) => t).forEach(([rot, t]) => {
    const l = el('div', 'linha');
    l.append(el('span', 'id', rot), el('span', null, extremo(t)));
    c.append(l);
  });
  return c;
}

/** Quem está sem ser visitado. É a fila do consultor vista de cima. */
function cartaoCampo(campo) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Quem está sem atendimento'));

  if (campo.naFila === 0) {
    c.append(el('p', 'vazio', 'Nenhum produtor na carteira ainda.'));
    return c;
  }

  const l = el('div', 'linha');
  l.append(el('span', null, `${campo.atrasados} de ${campo.naFila} produtores atrasados`),
    el('span', 'num', campo.nuncaVisitados ? `${campo.nuncaVisitados} nunca visitados` : ''));
  c.append(l);

  campo.proximos.forEach((x) => {
    const f = el('div', 'linha');
    f.append(el('span', null, x.produtor),
      el('span', 'num', x.nunca ? 'nunca visitado' : `${x.dias} dias`));
    c.append(f);
  });
  if (campo.corteDias) {
    c.append(el('p', 'detalhe', `Atrasado é passar de ${campo.corteDias} dias sem visita.`));
  }
  return c;
}

/** A lacuna: quanto a carteira poderia comprar e não comprou. */
function cartaoCarteira(cart) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'A lacuna da carteira'));

  if (cart.produtores === 0) {
    c.append(el('p', 'vazio', 'Nenhum produtor na carteira ainda.'));
    return c;
  }

  const l = el('div', 'linha');
  l.append(el('span', null,
    `${cart.semCompra} de ${cart.produtores} sem compra nesta safra`),
  el('span', 'num', `${num(cart.lacunaSc)} sc de lacuna`));
  c.append(l);

  cart.maioresLacunas.forEach((x) => {
    const f = el('div', 'linha');
    f.append(el('span', null, x.produtor),
      el('span', 'num', `${num(x.lacunaSc)} sc`
        + (x.penetracao === null ? '' : ` · ${x.penetracao}%`)));
    c.append(f);
  });

  // A taxa de sc/ha é estimativa, e o painel diz isso em vez de deixar o
  // potencial passar por medição.
  c.append(el('p', 'detalhe',
    `Potencial a ${cart.scPorHa} sc/ha (${cart.origemDaTaxa}).`));
  return c;
}

/** O share por marca, com o denominador escrito embaixo. */
function cartaoMercado(m) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Quanto da área é nossa'));

  if (m.marcas === 0) {
    c.append(el('p', 'vazio',
      'Nenhum plantio registrado nesta safra — sem talhão, não há share.'));
    return c;
  }

  const topo = el('div', 'linha');
  topo.append(el('span', 'num grande', m.nossoShare === null ? '—' : `${m.nossoShare}%`),
    el('span', 'id', `de ${num(m.areaObservadaHa)} ha em ${m.marcas} marca(s)`));
  c.append(topo);

  m.topo.forEach((x) => {
    const l = el('div', 'linha');
    l.append(el('span', null, x.marca),
      x.nossa ? el('span', 'etiqueta boa', 'nossa') : el('span', 'etiqueta', 'concorrente'),
      el('span', 'num', x.share === null ? '—' : `${x.share}%`));
    c.append(l);
  });

  // A frase vem da API de propósito: 75% aqui é "da área que registramos", e
  // sem isso o número é lido como share de mercado — outra ordem de grandeza.
  c.append(el('p', 'detalhe', `Base: ${m.base}.`));
  return c;
}

/* ---------------------------------------------------------------- pedidos */

async function telaPedidos(main) {
  const lista = await api('/pedidos');

  const novo = el('button', 'botao', 'Novo pedido');
  novo.onclick = () => janelaNovoPedido();
  main.append(cabecalho('Pedidos', `${lista.length} no total`, [novo]));

  if (lista.length === 0) {
    main.append(el('p', 'vazio', 'Nenhum pedido ainda.'));
    return;
  }

  main.append(tabela(
    ['Número', 'Produtor', 'Safra', 'Etapa', 'Crédito', 'Município'],
    lista.map((p) => [
      p.numero, p.produtor, p.safra,
      el('span', p.situacao === 'concluido' ? 'selo feito' : 'selo', p.etapa_nome),
      el('span', p.credito === 'recusado' ? 'selo ruim' : 'etiqueta', p.credito),
      [p.municipio, p.uf].filter(Boolean).join('/') || '—',
    ]),
    (i) => telaPedido(lista[i].id),
  ));
}

async function telaPedido(id) {
  const main = $('main');
  main.replaceChildren();
  const p = await api(`/pedidos/${id}`);

  const voltar = el('button', 'botao vazado pequeno', '← Pedidos');
  voltar.onclick = () => desenhar();
  main.append(cabecalho(p.numero, `${p.produtor} · safra ${p.safra}`, [voltar]));

  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Onde está'));
  const barra = el('div', 'etapas');
  for (let n = 1; n <= 10; n++) {
    const i = el('i', n < p.etapa ? 'feito' : n === p.etapa ? 'agora' : '');
    i.append(el('b', null, String(n)));
    barra.append(i);
  }
  c.append(barra, el('p', 'sub', `${p.etapa_nome} — ${p.etapa_quem}`));

  if (p.situacao === 'andamento') {
    const acoes = el('div', 'linha');
    const avancar = el('button', 'botao pequeno', 'Avançar etapa');
    avancar.onclick = () => agir(() => api(`/pedidos/${id}/avancar`, { metodo: 'POST', corpo: {} }), id);

    const voltarEtapa = el('button', 'botao vazado pequeno', 'Retroceder');
    voltarEtapa.onclick = () => janelaMotivo('Retroceder etapa', 'motivo',
      (motivo) => api(`/pedidos/${id}/retroceder`, { metodo: 'POST', corpo: { motivo } }), id);

    const credito = el('select');
    ['pendente', 'aprovado', 'recusado'].forEach((v) => {
      const o = el('option', null, v); o.value = v;
      if (v === p.credito) o.selected = true;
      credito.append(o);
    });
    credito.style.maxWidth = '160px';
    credito.onchange = () => agir(
      () => api(`/pedidos/${id}/credito`, { metodo: 'PATCH', corpo: { credito: credito.value } }), id);

    acoes.append(avancar, voltarEtapa, credito);
    c.append(acoes);
  }
  main.append(c);

  const itens = el('div', 'cartao');
  itens.append(el('p', 'rotulo', 'Itens'));
  p.itens.forEach((i) => {
    const l = el('div', 'linha');
    l.append(el('span', null, i.cultivar),
      el('span', 'num', `${num(i.quantidade)} ${i.unidade}`));
    itens.append(l);
  });
  main.append(itens);

  // A nota é o motor: sem ela a etapa 4 não passa, e o sell-out não entra.
  const nota = el('div', 'cartao destaque');
  nota.append(el('p', 'rotulo', 'Nota'));
  if (p.nota) {
    const l = el('div', 'linha');
    l.append(el('span', null, `NF ${p.nota.numero} · ${dia(p.nota.emitida_em)}`),
      el('span', 'num grande', brl(p.nota.valor)));
    nota.append(l);
    if (p.nota.pago_em) nota.append(el('p', 'sub', `Paga em ${dia(p.nota.pago_em)}`));
    else {
      const pago = el('button', 'botao pequeno', 'Marcar paga');
      pago.onclick = () => agir(
        () => api(`/pedidos/${id}/nota/pago`, { metodo: 'POST', corpo: {} }), id);
      nota.append(pago);
    }
  } else {
    nota.append(el('p', 'sub',
      'Sem nota. A etapa de faturamento só passa depois que ela for lançada.'));
    const lancar = el('button', 'botao pequeno', 'Lançar nota');
    lancar.onclick = () => janelaNota(id);
    nota.append(lancar);
  }
  main.append(nota);

  const hist = el('div', 'cartao');
  hist.append(el('p', 'rotulo', 'Histórico'));
  (p.historico ?? []).forEach((h) => {
    const l = el('div', 'linha');
    const texto = el('span', null, `${h.etapa} · ${h.nome}${h.retrocesso ? ' (voltou)' : ''}`);
    if (h.retrocesso) texto.style.color = 'var(--alerta)';
    l.append(texto, el('span', 'num', `${dia(h.em)} · ${h.por ?? 'sistema'}`));
    hist.append(l);
    if (h.observacao) hist.append(el('p', 'obs', h.observacao));
  });
  main.append(hist);
}

async function agir(fn, idParaReabrir) {
  try {
    await fn();
    if (idParaReabrir) await telaPedido(idParaReabrir);
    else await desenhar();
  } catch (e) { alerta(e.message); }
}

/* ----------------------------------------------------------------- equipe */

/**
 * A equipe da empresa.
 *
 * Até esta tela, usuário se criava com `insert` direto no banco — e a carteira
 * do consultor também. O caminho do dado sempre existiu; o que faltava era
 * alguém conseguir usar o sistema sem um DBA ao lado.
 *
 * Só o gestor escreve, e quem recusa é o banco. O consultor abre a tela e vê a
 * equipe: precisa, para saber a quem endereçar.
 */
async function telaEquipe(main) {
  const equipe = await api('/cadastro/usuarios');
  const souGestor = estado.eu?.papel === 'gestor';

  const acoes = [];
  if (souGestor) {
    const novo = el('button', 'botao', 'Novo usuário');
    novo.onclick = () => janelaNovoUsuario();
    acoes.push(novo);
  }
  main.append(cabecalho('Equipe', `${equipe.filter((u) => u.ativo).length} ativos`, acoes));

  if (!souGestor) {
    main.append(el('div', 'faixa',
      'Você vê a equipe. Criar e alterar usuário é do gestor.'));
  }

  main.append(tabela(
    ['Nome', 'E-mail', 'Papel', 'Carteira', 'Situação', ''],
    equipe.map((u) => {
      const botoes = el('div', 'acoes');
      if (souGestor) {
        // Não "Definir senha": o gestor não escolhe a senha de ninguém. O que
        // ele faz é abrir um acesso — um link de uma viagem só, que ele entrega
        // e que a própria pessoa usa para escolher a senha dela.
        const acesso = el('button', 'botao vazado pequeno', u.tem_senha ? 'Novo acesso' : 'Abrir acesso');
        acesso.onclick = (ev) => { ev.stopPropagation(); janelaAcesso(u); };
        botoes.append(acesso);

        if (u.papel === 'consultor') {
          // Não "Carteira": a aba lateral já se chama assim e é outra coisa —
          // lá são os produtores da empresa, aqui é quem este consultor atende.
          const cart = el('button', 'botao vazado pequeno', 'Quem atende');
          cart.onclick = (ev) => { ev.stopPropagation(); janelaCarteira(u); };
          botoes.append(cart);
        }

        const situacao = el('button', 'botao vazado pequeno', u.ativo ? 'Desativar' : 'Reativar');
        situacao.onclick = (ev) => {
          ev.stopPropagation();
          agir(() => api(`/cadastro/usuarios/${u.id}`, {
            metodo: 'PATCH', corpo: { ativo: !u.ativo },
          }));
        };
        botoes.append(situacao);
      }

      return [
        u.nome,
        u.email,
        u.papel,
        // Gestor enxerga a empresa inteira: um número de carteira ao lado dele
        // daria a entender que ele vê só aquilo.
        u.papel === 'gestor' ? 'tudo' : `${u.produtores ?? 0} produtor(es)`,
        u.ativo
          ? (u.tem_senha ? el('span', 'etiqueta boa', 'ativo') : el('span', 'etiqueta atencao', 'sem senha'))
          : el('span', 'etiqueta', 'inativo'),
        botoes,
      ];
    }),
  ));

  main.append(el('p', 'detalhe',
    'Quem sai é desativado, não apagado: visita, pedido e relato continuam '
    + 'apontando para a pessoa, e apagar o autor reescreveria a história de '
    + 'quem esteve na lavoura.'));
}

function janelaNovoUsuario() {
  janela('Novo usuário', [
    { nome: 'nome', rotulo: 'Nome' },
    { nome: 'email', rotulo: 'E-mail', tipo: 'email' },
    { nome: 'papel', rotulo: 'Papel (gestor ou consultor)', valor: 'consultor' },
  ], (v) => api('/cadastro/usuarios', {
    metodo: 'POST', corpo: { nome: v.nome, email: v.email, papel: v.papel },
  }));
  // Ele nasce SEM senha, e a linha dele aparece com a etiqueta âmbar até o
  // gestor definir uma. Encadear a janela da senha aqui não funciona — `janela`
  // fecha e redesenha depois do callback —, e a etiqueta é um lembrete melhor
  // que um passo obrigatório: quem cria dez usuários define as dez senhas
  // quando quiser, e vê de relance quais faltam.
}

/**
 * Abre acesso para alguém da equipe.
 *
 * O gestor não digita senha de outra pessoa. Senha que duas pessoas conhecem
 * não é senha: quem reaproveita a mesma em outro sistema passa a ter esse
 * sistema conhecido também — e no caminho até a pessoa ela ainda passaria por
 * uma mensagem de WhatsApp em texto puro.
 *
 * O link aparece UMA vez. Depois disto o banco só tem o hash, e não há de onde
 * lê-lo de novo — o que a tela oferece então é abrir outro, que mata este.
 */
async function janelaAcesso(u) {
  const d = $('#janela');
  d.replaceChildren(el('h3', null, `Acesso de ${u.nome}`), el('p', 'sub', 'Abrindo…'));
  d.showModal();

  let r;
  try {
    r = await api(`/auth/usuarios/${u.id}/acesso`, { metodo: 'POST' });
  } catch (e) { alerta(e.message); return; }

  const url = `${location.origin}/empresa#senha=${r.token}`;
  d.replaceChildren(el('h3', null, `Acesso de ${u.nome}`));
  d.append(el('p', 'sub',
    `Entregue este link. Ele vale ${r.horas} horas, serve uma vez, e quem escolhe `
    + 'a senha é a própria pessoa — nem você chega a saber qual é.'));

  // Campo de uma linha rolava para o fim e escondia o começo do endereço.
  // Este link é lido em voz alta e conferido caractere a caractere quando a
  // cópia falha, então ele aparece inteiro.
  const caixa = el('textarea');
  Object.assign(caixa, { value: url, readOnly: true, rows: 3, className: 'link-acesso' });
  caixa.onfocus = () => caixa.select();
  d.append(caixa);

  const aviso = el('p', 'detalhe',
    'Ele aparece só agora: o banco guarda o link embaralhado, e não há como '
    + 'mostrá-lo de novo. Se perder, abra outro — o anterior deixa de valer.');

  const fim = el('div', 'fim');
  const copiar = el('button', 'botao vazado pequeno', 'Copiar');
  copiar.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      copiar.textContent = 'Copiado';
    } catch {
      // Sem permissão de área de transferência o campo continua ali, e
      // selecionado: dizer "copiado" sem ter copiado seria pior que não copiar.
      caixa.focus();
      copiar.textContent = 'Copie do campo';
    }
  };
  const fechar = el('button', 'botao pequeno', 'Pronto');
  fechar.onclick = () => { d.close(); desenhar(); };
  fim.append(copiar, fechar);
  d.append(aviso, fim);
  caixa.focus();
}

/**
 * A carteira de um consultor: quem ele atende.
 *
 * Todos os produtores da empresa numa lista, com caixa marcada em quem já é
 * dele. É o gesto que a política espera — `consultor_carteira` é autorização
 * explícita, e não um filtro que se deduz de outra coisa.
 */
async function janelaCarteira(u) {
  const lista = await api(`/cadastro/usuarios/${u.id}/carteira`);
  const d = $('#janela');
  d.replaceChildren();
  d.append(el('h3', null, `Quem ${u.nome} atende`));

  if (lista.length === 0) {
    d.append(el('p', 'vazio', 'Nenhum produtor cadastrado ainda.'));
  }

  const caixa = el('div', 'lista-carteira');
  lista.forEach((p) => {
    const l = el('label', 'preparo-item');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = p.atende;
    c.onchange = async () => {
      c.disabled = true;
      try {
        await api('/cadastro/carteira', {
          metodo: c.checked ? 'POST' : 'DELETE',
          corpo: { usuarioId: u.id, produtorId: p.id },
        });
      } catch (e) {
        c.checked = !c.checked;   // não fingir que gravou
        alerta(e.message);
      }
      c.disabled = false;
    };
    l.append(c, el('span', null, p.nome));
    caixa.append(l);
  });
  d.append(caixa);

  const fim = el('div', 'fim');
  const fechar = el('button', 'botao', 'Fechar');
  fechar.onclick = () => { d.close(); desenhar(); };
  fim.append(fechar);
  d.append(fim);
  d.showModal();
}

/* --------------------------------------------------------------- carteira */

async function telaCarteira(main) {
  const lista = await api('/cadastro/produtores');

  const novo = el('button', 'botao', 'Novo produtor');
  novo.onclick = () => janelaNovoProdutor();
  main.append(cabecalho('Carteira', `${lista.length} produtores`, [novo]));

  if (lista.length === 0) {
    main.append(el('p', 'vazio', 'Nenhum produtor na sua carteira ainda.'));
    return;
  }

  main.append(tabela(
    ['Produtor', 'Documentos', 'Origem', 'Acesso'],
    lista.map((p) => {
      const docs = p.documentos.length
        ? p.documentos.map((d) => `${d.tipo.toUpperCase()} ${d.valor}`).join(' · ')
        : '—';
      const convidar = el('button', 'botao vazado pequeno', 'Convidar');
      convidar.onclick = (ev) => { ev.stopPropagation(); janelaConvite(p); };
      return [p.nome, docs, p.origem, convidar];
    }),
  ));
}

/* ------------------------------------------------------------- do campo */

async function telaCampo(main) {
  const [pendentes, guardados] = await Promise.all([
    api('/captura/relatos?situacao=pendente'),
    api('/captura/relatos?situacao=aguardando_extracao'),
  ]);

  main.append(cabecalho('Do campo',
    'O que chegou pelo WhatsApp. Quem fecha é o consultor.'));

  if (guardados.length) {
    const f = el('div', 'faixa');
    f.append(el('strong', null, `${guardados.length} mensagem(ns) guardada(s). `),
      document.createTextNode(
        'A leitura automática ainda não está ligada — elas ficam aqui, íntegras, '
        + 'e entram de uma vez quando entrar.'));
    main.append(f);
  }

  const fila = [...pendentes, ...guardados];
  if (fila.length === 0) {
    main.append(el('p', 'vazio', 'Nada esperando validação.'));
    return;
  }

  fila.forEach((r) => {
    const c = el('div', 'cartao');
    const topo = el('div', 'linha');
    topo.append(el('strong', null, r.produtor),
      el('span', 'id', `${r.origem} · ${dia(r.criado_em)}`),
      el('span', r.situacao === 'pendente' ? 'etiqueta boa' : 'etiqueta',
        r.situacao === 'pendente' ? 'lido' : 'aguardando leitura'));
    c.append(topo);

    // Enquanto a leitura automática não entra, o áudio é o relato inteiro —
    // sem tocar, o consultor validaria um cartão vazio.
    if (r.midia_id) {
      const espaco = el('div', 'midia');
      espaco.append(el('p', 'sub', 'carregando o anexo…'));
      c.append(espaco);
      midiaUrl(r.midia_id).then(({ url, tipo }) => {
        const m = el(tipo.startsWith('audio') ? 'audio' : 'img');
        m.src = url;
        if (m.tagName === 'AUDIO') m.controls = true;
        else m.alt = `foto enviada por ${r.produtor}`;
        espaco.replaceChildren(m);
      }).catch(() => espaco.replaceChildren(el('p', 'sub', 'não consegui abrir o anexo')));
    }

    if (r.transcricao) c.append(el('p', 'obs', r.transcricao));
    if (r.extraido) {
      // A confiança sai da lista e vira etiqueta: é sobre o quanto conferir, e
      // no meio de "cultivar · marca · lote" ela passaria batida. Abaixo de
      // 60% o consultor tem de reler o relato antes de validar, e a tela diz
      // isso em vez de deixar o número por conta dele.
      const { confianca, ...campos } = r.extraido;
      if (confianca !== undefined) {
        const pct = Math.round(Number(confianca) * 100);
        topo.append(el('span', pct >= 60 ? 'etiqueta' : 'etiqueta atencao',
          `leitura ${pct}%${pct >= 60 ? '' : ' · confira'}`));
      }
      const pares = Object.entries(campos);
      if (pares.length) {
        const ex = el('p', 'sub');
        ex.textContent = pares.map(([k, v]) => `${k}: ${v}`).join(' · ');
        c.append(ex);
      }
    }

    const acoes = el('div', 'linha');
    const ok = el('button', 'botao pequeno', 'Validar');
    ok.onclick = () => agir(() => api(`/captura/relatos/${r.id}/validar`, { metodo: 'POST', corpo: {} }));
    const nao = el('button', 'botao vazado pequeno', 'Descartar');
    nao.onclick = () => janelaMotivo('Descartar relato', 'observacao',
      (observacao) => api(`/captura/relatos/${r.id}/descartar`, { metodo: 'POST', corpo: { observacao } }));
    acoes.append(ok, nao);
    c.append(acoes);
    main.append(c);
  });
}

/* ---------------------------------------------------------------- janelas */

function janela(titulo, campos, aoConfirmar, rotuloBotao = 'Confirmar') {
  const d = $('#janela');
  d.replaceChildren();
  d.append(el('h3', null, titulo));
  const form = el('form');
  const entradas = {};
  campos.forEach((c) => {
    form.append(el('label', 'rotulo', c.rotulo));
    const i = el(c.tipo === 'textarea' ? 'textarea' : 'input');
    if (c.tipo && c.tipo !== 'textarea') i.type = c.tipo;
    // type=number assume step=1 e recusa decimal em silêncio: o formulário
    // simplesmente não envia. Preço, royalties e estande têm casas.
    if (c.tipo === 'number') i.step = 'any';
    if (c.valor) i.value = c.valor;
    if (c.obrigatorio !== false) i.required = true;
    if (c.dica) i.placeholder = c.dica;
    form.append(i, el('div', 'campo'));
    entradas[c.nome] = i;
  });
  const erro = el('p', 'erro');
  const fim = el('div', 'fim');
  const cancelar = el('button', 'botao vazado pequeno', 'Cancelar');
  cancelar.type = 'button';
  cancelar.onclick = () => d.close();
  const ok = el('button', 'botao pequeno', rotuloBotao);
  ok.type = 'submit';
  fim.append(cancelar, ok);
  form.append(erro, fim);

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    ok.disabled = true; erro.textContent = '';
    try {
      const valores = {};
      for (const [k, i] of Object.entries(entradas)) valores[k] = i.value;
      await aoConfirmar(valores);
      d.close();
      await desenhar();
    } catch (e) { erro.textContent = e.message; ok.disabled = false; }
  };

  d.append(form);
  d.showModal();
}

const janelaMotivo = (titulo, campo, fn, idParaReabrir) => janela(
  titulo, [{ nome: campo, rotulo: 'Motivo', tipo: 'textarea' }],
  async (v) => { await fn(v[campo]); if (idParaReabrir) await telaPedido(idParaReabrir); });

const janelaNovoProdutor = () => janela('Novo produtor', [
  { nome: 'nome', rotulo: 'Nome' },
  { nome: 'documento', rotulo: 'CPF ou CNPJ (opcional)', obrigatorio: false,
    dica: 'em campo, pode ficar em branco' },
], async (v) => {
  const d = v.documento.replace(/\D/g, '');
  await api('/cadastro/produtores', {
    metodo: 'POST',
    corpo: {
      nome: v.nome,
      documentos: d ? [{ tipo: d.length === 14 ? 'cnpj' : 'cpf', valor: d }] : [],
    },
  });
});

const janelaConvite = (p) => janela(`Convidar ${p.nome}`, [
  { nome: 'telefone', rotulo: 'Telefone com DDD', tipo: 'tel', dica: '5566999990000' },
], (v) => api('/auth/convites', {
  metodo: 'POST', corpo: { produtorId: p.id, telefone: v.telefone },
}), 'Enviar convite');

async function janelaNovoPedido() {
  const produtores = await api('/cadastro/produtores');
  if (produtores.length === 0) { alerta('Cadastre um produtor antes.'); return; }

  janela('Novo pedido', [
    { nome: 'numero', rotulo: 'Número' },
    { nome: 'safra', rotulo: 'Safra', valor: '26/27' },
    { nome: 'produtor', rotulo: `Produtor (${produtores.map((p) => p.nome).join(', ')})`,
      valor: produtores[0].nome },
    { nome: 'cultivar', rotulo: 'Cultivar' },
    { nome: 'quantidade', rotulo: 'Quantidade (sc)', tipo: 'number' },
  ], async (v) => {
    const alvo = produtores.find((p) => p.nome.toLowerCase() === v.produtor.trim().toLowerCase());
    if (!alvo) throw new Error('produtor não encontrado na sua carteira');
    await api('/pedidos', {
      metodo: 'POST',
      corpo: {
        numero: v.numero, safra: v.safra, produtorId: alvo.id,
        itens: [{ cultivar: v.cultivar, quantidade: Number(v.quantidade) }],
      },
    });
  }, 'Abrir pedido');
}

const janelaNota = (id) => janela('Lançar nota', [
  { nome: 'numero', rotulo: 'Número da nota' },
  { nome: 'valor', rotulo: 'Valor', tipo: 'number' },
  { nome: 'emitidaEm', rotulo: 'Emitida em', tipo: 'date' },
  { nome: 'vencimento', rotulo: 'Vencimento', tipo: 'date', obrigatorio: false },
], async (v) => {
  await api(`/pedidos/${id}/nota`, {
    metodo: 'POST',
    corpo: {
      numero: v.numero, valor: Number(v.valor),
      emitidaEm: v.emitidaEm, vencimento: v.vencimento || null,
    },
  });
  await telaPedido(id);
}, 'Lançar');

// O título é parâmetro porque nem todo aviso é uma falha: "Senha salva" sob um
// cabeçalho "Não deu" diz à pessoa que deu errado bem na hora em que deu certo.
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
  // Se a identidade não carrega, a sessão não serve para nada — token de uma
  // conta que não existe mais devolve 404, não 401, e engolir isso em silêncio
  // deixava a tela em branco sem dizer por quê.
  try {
    if (!estado.eu) estado.eu = await api('/auth/eu');
    if (estado.eu.tipo !== 'usuario') { sair(); return; }
  } catch (e) {
    if (e.message !== 'sessão expirada') sair();
    return;
  }

  const main = casca();
  try {
    if (estado.aba === 'pedidos') await telaPedidos(main);
    else if (estado.aba === 'carteira') await telaCarteira(main);
    else if (estado.aba === 'funil') await telaFunil(main);
    else if (estado.aba === 'catalogo') await telaCatalogo(main);
    else if (estado.aba === 'visitas') await telaVisitas(main);
    else if (estado.aba === 'caderno') await telaCaderno(main);
    else if (estado.aba === 'campo') await telaCampo(main);
    else if (estado.aba === 'equipe') await telaEquipe(main);
    else await telaPainel(main);
  } catch (e) {
    main.append(el('p', 'vazio', e.message));
  }
}

/**
 * Chegou por um link de senha? Então a tela é essa, e nenhuma outra.
 *
 * O fragmento é lido e apagado da barra de endereço na mesma linha: quem
 * fechar a aba e reabrir pelo histórico não reabre um bilhete válido, e uma
 * captura de tela da barra não leva a senha de ninguém junto.
 */
function abrirBilheteDaUrl() {
  const bilhete = new URLSearchParams(location.hash.slice(1)).get('senha');
  if (!bilhete) return false;
  history.replaceState(null, '', location.pathname);
  telaNovaSenha(bilhete);
  return true;
}

// Também no `hashchange`, e não só na carga: quem já está com o console aberto
// e clica no link recebido só troca o fragmento — o navegador não recarrega
// nada, e sem isto o link simplesmente não fazia efeito nenhum.
addEventListener('hashchange', abrirBilheteDaUrl);

if (!abrirBilheteDaUrl()) desenhar();

/* ---------------------------------------------------------------- visitas */

async function telaVisitas(main) {
  const [fila, h1, ultimas] = await Promise.all([
    api('/visitas/fila'), api('/visitas/h1'), api('/visitas'),
  ]);

  main.append(cabecalho('Visitas',
    `fila por tempo sem visita, pesada pela área · corte em ${fila[0]?.corteDias ?? 15} dias`));

  // A H1 em cima da tela. Ela decide o produto, então não fica escondida num
  // relatório: quem opera vê o número todo dia.
  main.append(painelH1(h1));

  if (fila.length === 0) {
    main.append(el('p', 'vazio', 'Nenhum produtor na carteira ainda.'));
    return;
  }

  main.append(cartaoUltimasVisitas(ultimas));

  main.append(tabela(
    ['Produtor', 'Município', 'Área', 'Última visita', 'Sem visita', ''],
    fila.map((f) => {
      const registrar = el('button', 'botao pequeno', 'Registrar visita');
      registrar.onclick = (ev) => { ev.stopPropagation(); janelaVisita(f); };
      return [
        f.produtor,
        f.municipio ?? '—',
        f.area_ha ? `${num(f.area_ha)} ha` : '—',
        f.nunca ? el('span', 'etiqueta', 'nunca') : dia(f.ultima_em),
        f.atrasado
          ? el('span', 'selo ruim', f.nunca ? 'nunca visitado' : `${f.dias} dias`)
          : el('span', 'etiqueta boa', `${f.dias} dias`),
        registrar,
      ];
    }),
  ));
}

/**
 * O que o campo trouxe, com as fotos.
 *
 * Existe porque foto que ninguém vê não valia ter sido tirada: o consultor
 * fotografa a bordadura, e é aqui que o agrônomo da revenda julga sem ter ido.
 */
function cartaoUltimasVisitas(visitas) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Últimas visitas'));

  if (visitas.length === 0) {
    c.append(el('p', 'sub', 'Nenhuma visita registrada ainda.'));
    return c;
  }

  visitas.slice(0, 8).forEach((v) => {
    const l = el('div', 'linha');
    l.append(el('span', null, v.produtor),
      el('span', 'id', [v.consultor, v.estagio, v.talhao].filter(Boolean).join(' · ')),
      el('span', 'num', `${dia(v.em)} · ${v.canal}`));
    c.append(l);
    if (v.observacao) c.append(el('p', 'obs', v.observacao));

    if (v.fotos?.length) {
      const g = el('div', 'galeria');
      v.fotos.forEach((id) => {
        const cx = el('div', 'miniatura');
        // Buscada com a sessão e mostrada como blob: a rota é privada, e tag de
        // imagem não carrega cabeçalho de autorização.
        midiaUrl(id).then(({ url }) => {
          const img = el('img');
          img.src = url;
          img.alt = `foto da visita a ${v.produtor}`;
          cx.replaceChildren(img);
        }).catch(() => cx.replaceChildren(el('span', 'sub', '—')));
        g.append(cx);
      });
      c.append(g);
    }
  });
  return c;
}

function painelH1(h1) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', `H1 · registro de visita — últimos ${h1.janelaDias} dias`));

  if (h1.medidas === 0) {
    c.append(el('p', 'sub',
      'Nenhum registro cronometrado ainda. A mediana aparece aqui assim que houver.'));
    return c;
  }

  const grade = el('div', 'numeros');
  h1.porCanal.forEach((canal) => {
    const bom = canal.mediana_seg !== null && canal.mediana_seg < h1.confirmaAbaixoDe;
    const ruim = canal.mediana_seg !== null && canal.mediana_seg > h1.mataAcimaDe;
    const cartao = numeroCartao(
      canal.canal === 'whatsapp' ? 'Áudio no WhatsApp' : 'Formulário no app',
      canal.mediana_seg === null ? '—' : `${canal.mediana_seg}s`,
      `mediana · ${canal.visitas} visita(s) · p90 ${canal.p90_seg ?? '—'}s`,
    );
    const veredito = el('span', bom ? 'selo feito' : ruim ? 'selo ruim' : 'selo',
      bom ? 'confirma' : ruim ? 'mata' : 'na faixa cinzenta');
    cartao.append(veredito);
    grade.append(cartao);
  });
  c.append(grade);
  c.append(el('p', 'sub',
    `Abaixo de ${h1.confirmaAbaixoDe}s confirma a hipótese; acima de ${h1.mataAcimaDe}s a derruba.`));
  return c;
}

/**
 * O registro cronometra a si mesmo.
 *
 * O relógio começa quando a janela abre e para no envio — é a medição contínua
 * da H1, em vez de um dia de campo com cronômetro uma vez só. Vem do cliente,
 * então é indicativo: serve para ver tendência e comparar canais.
 */
function janelaVisita(alvo) {
  const comecou = Date.now();
  janela(`Visita — ${alvo.produtor}`, [
    { nome: 'estagio', rotulo: 'Estágio da cultura', obrigatorio: false, dica: 'V4, R1…' },
    { nome: 'estande', rotulo: 'Estande (mil plantas/ha)', tipo: 'number', obrigatorio: false },
    { nome: 'observacao', rotulo: 'O que você viu', tipo: 'textarea', obrigatorio: false },
  ], async (v) => {
    await api('/visitas', {
      metodo: 'POST',
      corpo: {
        produtorId: alvo.produtor_id,
        canal: 'app',
        duracaoSeg: Math.round((Date.now() - comecou) / 1000),
        estagio: v.estagio || null,
        estande: v.estande ? Number(v.estande) : null,
        observacao: v.observacao || null,
      },
    });
  }, 'Registrar');
}

/* --------------------------------------------------------------- catálogo */

/**
 * A safra que as telas usam.
 *
 * Vem do painel, que a deduz do que foi vendido. A constante ficou só como
 * chão para o caso de alguém abrir uma tela antes do painel — e como constante
 * ela estava errada desde o momento em que foi escrita: viraria o ano, as telas
 * ficariam vazias, e ninguém ligaria uma coisa à outra.
 */
const safraAtual = () => estado.safra ?? '26/27';

async function telaCatalogo(main) {
  const [produtos, resumo] = await Promise.all([
    api(`/catalogo/produtos?safra=${encodeURIComponent(safraAtual())}`),
    api(`/catalogo/resumo?safra=${encodeURIComponent(safraAtual())}`),
  ]);

  const novo = el('button', 'botao', 'Novo produto');
  novo.onclick = () => janelaProduto();
  main.append(cabecalho('Catálogo', `safra ${safraAtual()} · ${produtos.length} produtos`, [novo]));

  if (produtos.length === 0) {
    main.append(el('p', 'vazio', 'Nenhum produto ainda. O pedido aceita item digitado à mão até lá.'));
  } else {
    main.append(tabela(
      ['Produto', 'Cultura', 'Direto', 'Distribuidor', 'Royalties', ''],
      produtos.map((p) => {
        const preco = (canal) => {
          const x = p.precos.find((y) => y.canal === canal);
          return x ? brl(x.valor) : '—';
        };
        const roy = p.precos[0]?.royaltiesSc;
        const definir = el('button', 'botao vazado pequeno', 'Definir preço');
        definir.onclick = (ev) => { ev.stopPropagation(); janelaPreco(p); };
        return [p.nome, p.cultura ?? '—', preco('direto'), preco('distribuidor'),
          roy ? brl(roy) : '—', definir];
      }),
    ));
  }

  if (resumo.length) main.append(cartaoResumo(resumo));
}

/**
 * O que a bonificada custa.
 *
 * Dois preços médios lado a lado: o que o comercial acha que pratica e o que a
 * geração de demanda de fato deixou. A diferença entre os dois é o custo da GD,
 * e mostrá-la é o que impede o indicador de mentir.
 */
function cartaoResumo(resumo) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', `Vendido na safra ${safraAtual()}`));
  c.append(tabela(
    ['Produto', 'Volume', 'Bonificada', 'Receita', 'Médio cobrado', 'Médio efetivo'],
    resumo.map((r) => {
      const caiu = r.bonificada > 0;
      const efetivo = el('span', caiu ? 'num' : 'num', brl(r.precoMedioEfetivo));
      if (caiu) efetivo.style.color = 'var(--sol-tinta)';
      return [
        r.produto, `${num(r.quantidade)} sc`,
        r.bonificada ? `${num(r.bonificada)} sc` : '—',
        brl(r.receita), brl(r.precoMedioCobrado), efetivo,
      ];
    }),
  ));
  if (resumo.some((r) => r.bonificada > 0)) {
    c.append(el('p', 'sub',
      'A diferença entre o médio cobrado e o efetivo é o que a geração de demanda custou.'));
  }
  return c;
}

const janelaProduto = () => janela('Novo produto', [
  { nome: 'nome', rotulo: 'Nome' },
  { nome: 'categoria', rotulo: 'Categoria (semente, defensivo, fertilizante, outro)',
    valor: 'semente' },
  { nome: 'cultura', rotulo: 'Cultura', obrigatorio: false, dica: 'milho, soja…' },
  { nome: 'embalagem', rotulo: 'Embalagem', obrigatorio: false, dica: '60.000 sementes' },
], (v) => api('/catalogo/produtos', { metodo: 'POST', corpo: v }), 'Criar');

const janelaPreco = (p) => janela(`Preço — ${p.nome}`, [
  { nome: 'safra', rotulo: 'Safra', valor: safraAtual() },
  { nome: 'canal', rotulo: 'Canal (direto ou distribuidor)', valor: 'direto' },
  { nome: 'valor', rotulo: `Valor por ${p.unidade}`, tipo: 'number' },
  { nome: 'royaltiesSc', rotulo: 'Royalties por saco', tipo: 'number', obrigatorio: false },
  { nome: 'vigenteDe', rotulo: 'Vigente a partir de', tipo: 'date', obrigatorio: false },
], (v) => api(`/catalogo/produtos/${p.id}/precos`, {
  metodo: 'POST',
  corpo: {
    safra: v.safra, canal: v.canal, valor: Number(v.valor),
    royaltiesSc: v.royaltiesSc ? Number(v.royaltiesSc) : 0,
    vigenteDe: v.vigenteDe || null,
  },
}), 'Definir');

/* ------------------------------------------------------------------ funil */

const ROTULO_ESTAGIO = {
  prospeccao: 'Prospecção', qualificacao: 'Qualificação', proposta: 'Proposta',
  negociacao: 'Negociação', ganha: 'Ganha', perdida: 'Perdida',
};

async function telaFunil(main) {
  const safra = encodeURIComponent(safraAtual());
  const [resumo, lista, pen] = await Promise.all([
    api(`/funil/resumo?safra=${safra}`),
    api(`/funil?safra=${safra}`),
    api(`/funil/penetracao?safra=${safra}`),
  ]);

  const nova = el('button', 'botao', 'Nova oportunidade');
  nova.onclick = () => janelaOportunidade();
  main.append(cabecalho('Funil', `safra ${safraAtual()}`, [nova]));

  main.append(cartaoFunil(resumo));
  main.append(cartaoPenetracao(pen));

  if (lista.length === 0) {
    main.append(el('p', 'vazio', 'Nenhuma oportunidade aberta nesta safra.'));
    return;
  }

  main.append(tabela(
    ['Produtor', 'Estágio', 'Potencial', 'Responsável', 'Motivo / concorrente', ''],
    lista.map((o) => {
      const mover = el('button', 'botao vazado pequeno', 'Mover');
      mover.onclick = (ev) => { ev.stopPropagation(); janelaMover(o); };
      const fechado = o.estagio === 'ganha' || o.estagio === 'perdida';
      return [
        o.produtor,
        el('span', o.estagio === 'ganha' ? 'selo feito'
          : o.estagio === 'perdida' ? 'selo ruim' : 'selo', ROTULO_ESTAGIO[o.estagio]),
        o.potencial_sc ? `${num(o.potencial_sc)} sc` : '—',
        o.responsavel ?? '—',
        o.motivo_perda ? `${o.motivo_perda}${o.concorrente ? ` · ${o.concorrente}` : ''}` : '—',
        fechado ? '' : mover,
      ];
    }),
  ));
}

function cartaoFunil(resumo) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Onde estão as conversas'));
  const maior = Math.max(1, ...resumo.map((e) => e.quantas));
  const funil = el('div', 'funil');
  resumo.forEach((e) => {
    const l = el('div', 'faixa-etapa');
    const medidor = el('div', 'medidor');
    const i = el('i');
    i.style.width = `${(e.quantas / maior) * 100}%`;
    if (e.estagio === 'perdida') i.style.background = 'var(--alerta)';
    if (e.estagio === 'ganha') i.style.background = 'var(--marca)';
    medidor.append(i);
    l.append(el('span', null, ROTULO_ESTAGIO[e.estagio]), medidor,
      el('span', 'num', e.potencialSc ? `${num(e.potencialSc)} sc` : String(e.quantas)));
    funil.append(l);
  });
  c.append(funil);
  return c;
}

/**
 * A penetração é o laço: a área que o campo cadastrou vira potencial, e o
 * potencial encontra o que foi vendido. A lacuna é onde está o concorrente —
 * mas a tela não diz a marca, porque só o talhão conta isso.
 */
function cartaoPenetracao(pen) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', `Penetração · ${pen.scPorHa} sc/ha (${pen.origemDaTaxa})`));
  c.append(tabela(
    ['Produtor', 'Área', 'Potencial', 'Comprado', 'Lacuna', 'Penetração'],
    pen.linhas.slice(0, 12).map((l) => {
      const barra = el('div', 'trilho');
      const i = el('i');
      i.style.width = `${Math.min(l.penetracao ?? 0, 100)}%`;
      barra.append(i);
      const caixa = el('div');
      caixa.style.minWidth = '110px';
      caixa.append(barra, el('span', 'passo', l.penetracao === null ? '—' : `${l.penetracao}%`));
      return [
        l.produtor, `${num(l.areaHa)} ha`, `${num(l.potencialSc)} sc`,
        `${num(l.compradoSc)} sc`, `${num(l.lacunaSc)} sc`, caixa,
      ];
    }),
  ));
  c.append(el('p', 'sub',
    'A lacuna é onde o concorrente está. Qual marca ocupa, só o talhão conta.'));
  return c;
}

async function janelaOportunidade() {
  const produtores = await api('/cadastro/produtores');
  if (produtores.length === 0) { alerta('Cadastre um produtor antes.'); return; }
  janela('Nova oportunidade', [
    { nome: 'produtor', rotulo: `Produtor (${produtores.map((p) => p.nome).join(', ')})`,
      valor: produtores[0].nome },
    { nome: 'safra', rotulo: 'Safra', valor: safraAtual() },
    { nome: 'potencialSc', rotulo: 'Potencial em sacos (em branco: estima pela área)',
      tipo: 'number', obrigatorio: false },
  ], async (v) => {
    const alvo = produtores.find((p) => p.nome.toLowerCase() === v.produtor.trim().toLowerCase());
    if (!alvo) throw new Error('produtor não encontrado na sua carteira');
    await api('/funil', {
      metodo: 'POST',
      corpo: { produtorId: alvo.id, safra: v.safra,
        potencialSc: v.potencialSc ? Number(v.potencialSc) : null },
    });
  }, 'Abrir');
}

const janelaMover = (o) => janela(`Mover — ${o.produtor}`, [
  { nome: 'estagio', rotulo: 'Estágio (prospeccao, qualificacao, proposta, negociacao, ganha, perdida)',
    valor: 'qualificacao' },
  { nome: 'motivoPerda', rotulo: 'Motivo, se perdida', tipo: 'textarea', obrigatorio: false },
  { nome: 'concorrente', rotulo: 'Concorrente, se souber', obrigatorio: false },
], (v) => api(`/funil/${o.id}/mover`, {
  metodo: 'POST',
  corpo: { estagio: v.estagio, motivoPerda: v.motivoPerda || null,
    concorrente: v.concorrente || null },
}), 'Mover');

/* --------------------------------------------------- caderno de campo */

async function telaCaderno(main) {
  const safra = encodeURIComponent(safraAtual());
  const [share, plantios, desempenho] = await Promise.all([
    api(`/caderno/share?safra=${safra}`),
    api(`/caderno/plantios?safra=${safra}`),
    api(`/caderno/desempenho?safra=${safra}`),
  ]);

  const novo = el('button', 'botao', 'Registrar plantio');
  novo.onclick = () => janelaPlantio();
  main.append(cabecalho('Lavoura', `caderno de campo · safra ${safraAtual()}`, [novo]));

  main.append(cartaoShare(share));
  if (desempenho.length) main.append(cartaoDesempenho(desempenho));

  if (plantios.length === 0) {
    main.append(el('p', 'vazio', 'Nenhum plantio registrado nesta safra.'));
    return;
  }

  main.append(tabela(
    ['Talhão', 'Produtor', 'Ciclo', 'Cultivar', 'Marca', 'Área', 'Produtividade', ''],
    plantios.map((p) => {
      const colher = el('button', 'botao vazado pequeno', 'Colheita');
      colher.onclick = (ev) => { ev.stopPropagation(); janelaColheita(p); };
      return [
        p.talhao, p.produtor ?? '—', p.ciclo, p.cultivar,
        el('span', p.nossa ? 'etiqueta boa' : 'etiqueta', p.marca),
        p.area_ha ? `${num(p.area_ha)} ha` : '—',
        p.produtividade_sc_ha ? `${num(p.produtividade_sc_ha)} sc/ha` : '—',
        p.produtividade_sc_ha ? '' : colher,
      ];
    }),
  ));
}

/**
 * O share por marca — o último item de fosso do desenho.
 *
 * A base fica escrita ao lado do número de propósito: é a área que nós
 * registramos, não o mercado do território. Share que se apresenta como
 * absoluto vira decisão errada na reunião seguinte.
 */
function cartaoShare(share) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Share por marca — por área plantada'));

  if (share.marcas.length === 0) {
    c.append(el('p', 'sub', 'Sem plantio registrado ainda. O share aparece quando o campo registrar.'));
    return c;
  }

  const n = el('div', 'numeros');
  n.append(numeroCartao('Nosso share', `${share.nossoShare ?? 0}%`,
    `de ${num(share.areaObservadaHa)} ha observados`));
  c.append(n);

  const barras = el('div', 'funil');
  const maior = Math.max(...share.marcas.map((m) => m.areaHa), 1);
  share.marcas.forEach((m) => {
    const l = el('div', 'faixa-etapa');
    const medidor = el('div', 'medidor');
    const i = el('i');
    i.style.width = `${(m.areaHa / maior) * 100}%`;
    if (!m.nossa) i.style.background = 'var(--tinta-3)';
    medidor.append(i);
    l.append(el('span', null, m.marca + (m.nossa ? ' (nossa)' : '')), medidor,
      el('span', 'num', `${m.share}%`));
    barras.append(l);
  });
  c.append(barras);
  c.append(el('p', 'sub', share.base));
  return c;
}

function cartaoDesempenho(linhas) {
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Como cada cultivar se saiu'));
  c.append(tabela(
    ['Cultivar', 'Marca', 'Talhões', 'Média', 'Pior', 'Melhor'],
    linhas.map((l) => [
      l.cultivar,
      el('span', l.nossa ? 'etiqueta boa' : 'etiqueta', l.marca),
      String(l.colhidos),
      `${num(l.media_sc_ha)} sc/ha`, `${num(l.pior)}`, `${num(l.melhor)}`,
    ]),
  ));
  return c;
}

async function janelaPlantio() {
  const fazendas = await api('/cadastro/propriedades');
  const talhoes = [];
  for (const f of fazendas) {
    const lista = await api(`/cadastro/propriedades/${f.id}/talhoes`);
    lista.forEach((t) => talhoes.push({ ...t, fazenda: f.nome }));
  }
  if (talhoes.length === 0) { alerta('Cadastre um talhão antes.'); return; }

  janela('Registrar plantio', [
    { nome: 'talhao', rotulo: `Talhão (${talhoes.map((t) => t.nome).join(', ')})`,
      valor: talhoes[0].nome },
    { nome: 'safra', rotulo: 'Safra', valor: safraAtual() },
    { nome: 'ciclo', rotulo: 'Ciclo (safra ou safrinha)', valor: 'safra' },
    { nome: 'cultivar', rotulo: 'Cultivar' },
    { nome: 'marca', rotulo: 'Marca — nossa ou do concorrente' },
    { nome: 'areaHa', rotulo: 'Área (ha)', tipo: 'number', obrigatorio: false },
    { nome: 'plantadoEm', rotulo: 'Plantado em', tipo: 'date', obrigatorio: false },
  ], async (v) => {
    const alvo = talhoes.find((t) => t.nome.toLowerCase() === v.talhao.trim().toLowerCase());
    if (!alvo) throw new Error('talhão não encontrado');
    await api('/caderno/plantios', {
      metodo: 'POST',
      corpo: { talhaoId: alvo.id, safra: v.safra, ciclo: v.ciclo, cultivar: v.cultivar,
        marca: v.marca, areaHa: v.areaHa ? Number(v.areaHa) : null,
        plantadoEm: v.plantadoEm || null },
    });
  }, 'Registrar');
}

const janelaColheita = (p) => janela(`Colheita — ${p.talhao} · ${p.cultivar}`, [
  { nome: 'produtividadeScHa', rotulo: 'Produtividade (sc/ha)', tipo: 'number' },
  { nome: 'umidade', rotulo: 'Umidade (%)', tipo: 'number', obrigatorio: false },
  { nome: 'colhidoEm', rotulo: 'Colhido em', tipo: 'date', obrigatorio: false },
], (v) => api(`/caderno/plantios/${p.id}/colheita`, {
  metodo: 'POST',
  corpo: { produtividadeScHa: Number(v.produtividadeScHa),
    umidade: v.umidade ? Number(v.umidade) : null, colhidoEm: v.colhidoEm || null },
}), 'Registrar');

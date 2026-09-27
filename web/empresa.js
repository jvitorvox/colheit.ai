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
const dia = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');

const estado = { token: localStorage.getItem(SESSAO), eu: null, aba: 'painel' };

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
  document.body.classList.add('entrando');
  const c = el('div', 'entrada cartao');
  c.append(el('h1', 'marca', 'colheit.ai'));
  c.append(el('p', 'sub', 'Área da empresa'));

  const form = el('form');
  const email = el('input'); Object.assign(email, { type: 'email', required: true, autocomplete: 'username' });
  const senha = el('input'); Object.assign(senha, { type: 'password', required: true, autocomplete: 'current-password' });
  const botao = el('button', 'botao', 'Entrar'); botao.type = 'submit';
  const erro = el('p', 'erro');

  form.append(el('label', 'rotulo', 'E-mail'), email,
    el('div', 'campo'), el('label', 'rotulo', 'Senha'), senha, botao, erro);
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

/* ------------------------------------------------------------------ casca */

const ABAS = [
  ['painel', 'Painel'],
  ['pedidos', 'Pedidos'],
  ['carteira', 'Carteira'],
  ['visitas', 'Visitas'],
  ['campo', 'Do campo'],
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

async function telaPainel(main) {
  const [lista, etapas, relatos] = await Promise.all([
    api('/pedidos'), api('/pedidos/etapas'), api('/captura/relatos?situacao=pendente'),
  ]);

  const andamento = lista.filter((p) => p.situacao === 'andamento');
  const produtores = new Set(lista.map((p) => p.produtor)).size;

  main.append(cabecalho('Painel', `safra em curso · ${estado.eu.tenant}`));

  const n = el('div', 'numeros');
  n.append(
    numeroCartao('Pedidos em andamento', num(andamento.length), `${lista.length} no total`),
    numeroCartao('Produtores com pedido', num(produtores)),
    numeroCartao('Do campo, a validar', num(relatos.length),
      relatos.length ? 'esperando o consultor' : 'nada na fila'),
  );
  main.append(n);

  // O funil pelas dez etapas: é onde o gestor vê a operação travar.
  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Pedidos por etapa'));
  const funil = el('div', 'funil');
  const maior = Math.max(1, ...etapas.map((e) => andamento.filter((p) => p.etapa === e.numero).length));
  etapas.forEach((e) => {
    const quantos = andamento.filter((p) => p.etapa === e.numero).length;
    const l = el('div', 'faixa-etapa');
    const medidor = el('div', 'medidor');
    const preenche = el('i');
    preenche.style.width = `${(quantos / maior) * 100}%`;
    medidor.append(preenche);
    l.append(el('span', null, `${e.numero} · ${e.nome}`), medidor,
      el('span', 'num', String(quantos)));
    funil.append(l);
  });
  c.append(funil);
  main.append(c);
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

    if (r.transcricao) c.append(el('p', 'obs', r.transcricao));
    if (r.extraido) {
      const ex = el('p', 'sub');
      ex.textContent = Object.entries(r.extraido).map(([k, v]) => `${k}: ${v}`).join(' · ');
      c.append(ex);
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

function alerta(texto) {
  const d = $('#janela');
  d.replaceChildren(el('h3', null, 'Não deu'), el('p', 'sub', texto));
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
    else if (estado.aba === 'visitas') await telaVisitas(main);
    else if (estado.aba === 'campo') await telaCampo(main);
    else await telaPainel(main);
  } catch (e) {
    main.append(el('p', 'vazio', e.message));
  }
}

desenhar();

/* ---------------------------------------------------------------- visitas */

async function telaVisitas(main) {
  const [fila, h1] = await Promise.all([api('/visitas/fila'), api('/visitas/h1')]);

  main.append(cabecalho('Visitas',
    `fila por tempo sem visita, pesada pela área · corte em ${fila[0]?.corteDias ?? 15} dias`));

  // A H1 em cima da tela. Ela decide o produto, então não fica escondida num
  // relatório: quem opera vê o número todo dia.
  main.append(painelH1(h1));

  if (fila.length === 0) {
    main.append(el('p', 'vazio', 'Nenhum produtor na carteira ainda.'));
    return;
  }

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

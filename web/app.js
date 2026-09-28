// Portal do produtor.
//
// Sem build: o repositório não tem empacotador, e um arquivo que o navegador
// lê direto é menos coisa para manter. Se um dia precisar de framework, ele
// entra por escolha e não por inércia.

const SESSAO = 'colheitai.token';
const $ = (s, raiz = document) => raiz.querySelector(s);
const el = (t, cls, txt) => {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

const estado = { token: localStorage.getItem(SESSAO), eu: null, desatualizado: false };

/* -------------------------------------------------------------------- api */

async function api(caminho, { metodo = 'GET', corpo } = {}) {
  const resp = await fetch(caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(estado.token ? { authorization: `Bearer ${estado.token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  // O service worker marca o que veio de cópia guardada. A tela avisa em vez
  // de fingir que o dado é de agora.
  if (resp.headers.get('x-do-cache') === '1') estado.desatualizado = true;
  const dados = await resp.json().catch(() => null);
  if (resp.status === 401) { sair(); throw new Error('sessão expirada'); }
  if (!resp.ok) throw new Error(dados?.erro ?? `erro ${resp.status}`);
  return dados;
}

function sair() {
  localStorage.removeItem(SESSAO);
  estado.token = null;
  estado.eu = null;
  location.hash = '';
  desenhar();
}

/* ------------------------------------------------------------------ entrar */

function telaEntrar(raiz, etapa = 'telefone', telefone = '') {
  const cartao = el('div', 'cartao entrada');
  cartao.append(el('h1', 'marca', 'colheit.ai'));
  cartao.append(el('p', 'sub',
    'Seus pedidos, suas notas e sua lavoura — de todas as revendas, num acesso só.'));

  const form = el('form');
  const erro = el('p', 'erro');

  if (etapa === 'telefone') {
    const campo = el('input');
    Object.assign(campo, { type: 'tel', placeholder: 'DDD + número', required: true,
      autocomplete: 'tel', inputMode: 'numeric' });
    const botao = el('button', 'botao', 'Receber código');
    botao.type = 'submit';
    form.append(rotulo('Seu telefone'), campo, botao, erro);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      botao.disabled = true; erro.textContent = '';
      try {
        const tel = campo.value.replace(/\D/g, '');
        const r = await api('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: tel } });
        // Em desenvolvimento a API devolve o código; em produção ele chega pelo
        // WhatsApp e este campo simplesmente não existe.
        telaEntrar(raiz, 'codigo', tel);
        if (r.codigo) $('input', raiz).value = r.codigo;
      } catch (e) { erro.textContent = e.message; botao.disabled = false; }
    };
  } else {
    const campo = el('input');
    Object.assign(campo, { type: 'text', placeholder: '000000', required: true,
      inputMode: 'numeric', maxLength: 6, autocomplete: 'one-time-code' });
    const botao = el('button', 'botao', 'Entrar');
    botao.type = 'submit';
    form.append(rotulo(`Código enviado para ${telefone}`), campo, botao, erro);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      botao.disabled = true; erro.textContent = '';
      try {
        const r = await api('/auth/produtor/entrar', {
          metodo: 'POST', corpo: { telefone, codigo: campo.value },
        });
        localStorage.setItem(SESSAO, r.token);
        estado.token = r.token;
        await desenhar();
        pedirPush();
      } catch (e) { erro.textContent = e.message; botao.disabled = false; }
    };
  }

  cartao.append(form);
  raiz.replaceChildren(cartao);
  $('input', raiz)?.focus();
}

const rotulo = (t) => el('label', 'rotulo', t);

/* -------------------------------------------------------------------- app */

const ETAPAS_CURTAS = ['negociação', 'pedido', 'crédito', 'nota', 'expedição',
  'transporte', 'entrega', 'plantio', 'visita', 'resultado'];

// O banco guarda o valor do enum; a tela dele mostra a palavra escrita certo.
const PAPEL = {
  proprietario: 'proprietário',
  arrendatario: 'arrendatário',
  comodatario: 'comodatário',
};

function barraEtapas(etapa) {
  const barra = el('div', 'etapas');
  ETAPAS_CURTAS.forEach((nome, i) => {
    const n = i + 1;
    const passo = el('i', n < etapa ? 'feito' : n === etapa ? 'agora' : '');
    passo.append(el('b', null, String(n)), el('span', null, nome));
    barra.append(passo);
  });
  return barra;
}

/**
 * Na lista, progresso compacto em vez das dez caixas.
 *
 * Dez etiquetas em 314px de celular ficam ilegíveis e obrigam a arrastar de
 * lado para ver onde o pedido está — que é a única coisa que ele quer saber
 * nesta tela. A faixa completa fica no detalhe, onde ele já escolheu o pedido.
 */
function progresso(etapa) {
  const caixa = el('div', 'progresso');
  const trilho = el('div', 'trilho');
  const preenchido = el('i');
  preenchido.style.width = `${(etapa / 10) * 100}%`;
  trilho.append(preenchido);
  caixa.append(trilho, el('span', 'passo', `${etapa} de 10 · ${ETAPAS_CURTAS[etapa - 1]}`));
  return caixa;
}

function cartaoPedido(p) {
  const c = el('article', 'cartao pedido');
  c.onclick = () => { location.hash = `#/pedido/${p.id}`; };

  const topo = el('div', 'linha');
  topo.append(el('strong', null, p.numero), el('span', 'id', p.safra));
  const selo = el('span', p.situacao === 'concluido' ? 'selo feito' : 'selo', p.etapa_nome);
  topo.append(selo);
  c.append(topo, progresso(p.etapa));
  return c;
}

async function telaPedidos(raiz) {
  const lista = await api('/pedidos');
  const area = el('section');
  area.append(cabecalho('Meus pedidos', `${lista.length} no total`));

  if (lista.length === 0) {
    area.append(vazio('Nenhum pedido ainda. Quando sua revenda lançar, ele aparece aqui.'));
  } else {
    lista.forEach((p) => area.append(cartaoPedido(p)));
  }
  raiz.replaceChildren(area);
}

async function telaPedido(raiz, id) {
  const p = await api(`/pedidos/${id}`);
  const area = el('section');
  area.append(cabecalho(p.numero, `${p.produtor} · safra ${p.safra}`, true));

  const c = el('article', 'cartao');
  c.append(el('p', 'rotulo', 'Onde está'), barraEtapas(p.etapa));
  c.append(el('p', 'nota-linha', `${p.etapa_nome} — ${p.etapa_quem}`));
  area.append(c);

  // O Dia Zero: entre saber que a carga saiu e ela chegar, é a janela para
  // acertar máquina, equipe e regulagem. É quando ele mais abre o aplicativo no
  // ano inteiro — e é a hora de o aplicativo servir para alguma coisa.
  if (p.etapa >= 6 && p.etapa <= 8) area.append(await blocoDiaZero(p));

  const itens = el('article', 'cartao');
  itens.append(el('p', 'rotulo', 'O que vem'));
  p.itens.forEach((i) => {
    const l = el('div', 'linha');
    l.append(el('span', null, i.cultivar),
      el('span', 'num', `${Number(i.quantidade).toLocaleString('pt-BR')} ${i.unidade}`));
    itens.append(l);
  });
  area.append(itens);

  if (p.nota) area.append(cartaoNota(p.nota));

  const hist = el('article', 'cartao');
  hist.append(el('p', 'rotulo', 'Histórico'));
  (p.historico ?? []).forEach((h) => {
    const l = el('div', `linha hist ${h.retrocesso ? 'voltou' : ''}`);
    l.append(el('span', null, `${h.etapa} · ${h.nome}`),
      el('span', 'num', new Date(h.em).toLocaleDateString('pt-BR')));
    hist.append(l);
    if (h.observacao) hist.append(el('p', 'obs', h.observacao));
  });
  area.append(hist);
  raiz.replaceChildren(area);
}

/* --------------------------------------------------------------- dia zero */

const REGULAGEM = 'colheitai.regulagem';

/**
 * O Dia Zero.
 *
 * Três coisas, e nenhuma a mais: há quantos dias a carga saiu, a régua da
 * semeadora, e a lista de preparo.
 *
 * O que ele NÃO faz é prever a data de chegada. Não temos esse dado — nem
 * transportadora, nem rastreio —, e um "chega quinta" inventado é pior que
 * nenhum: ele organiza equipe em cima disso.
 */
async function blocoDiaZero(p) {
  const bloco = el('div');

  const desde = (p.historico ?? []).filter((h) => h.etapa === 6).pop();
  const dias = desde ? Math.floor((Date.now() - new Date(desde.em)) / 86400000) : null;

  const faixa = el('div', 'faixa');
  faixa.append(el('strong', null, p.etapa === 6 ? 'A carga está a caminho. ' : 'Dia Zero. '),
    document.createTextNode(dias === null
      ? 'É a janela para acertar máquina, equipe e regulagem.'
      : `Saiu ${dias === 0 ? 'hoje' : `há ${dias} dia(s)`}. `
        + 'É a janela para acertar máquina, equipe e regulagem.'));
  bloco.append(faixa);

  bloco.append(cartaoRegulagem(p));
  bloco.append(await cartaoPreparo(p));
  return bloco;
}

/**
 * A régua da semeadora: sementes por metro.
 *
 * `pop × espaçamento / 10.000` é conversão de unidade, não agronomia — é a
 * mesma conta que está no verso de qualquer manual. O que é agronomia, e que
 * NÃO fazemos, é descontar germinação e vigor: a tela diz isso em vez de
 * entregar um número que parece final.
 *
 * Os dois valores ficam no aparelho dele. Não vão para o servidor: é ajuste de
 * máquina, muda de talhão para talhão, e não é dado nosso.
 */
function cartaoRegulagem(p) {
  const c = el('article', 'cartao');
  c.append(el('p', 'rotulo', 'Régua da semeadora'));

  const guardado = lerRegulagem();
  const pop = el('input');
  Object.assign(pop, { type: 'number', step: 'any', inputMode: 'decimal', value: guardado.pop ?? '' });
  const esp = el('input');
  Object.assign(esp, { type: 'number', step: 'any', inputMode: 'decimal', value: guardado.esp ?? '0.45' });

  c.append(rotulo('População desejada (mil plantas/ha)'), pop, el('div', 'campo'));
  c.append(rotulo('Espaçamento entre linhas (m)'), esp);

  const saida = el('p', 'num grande');
  const nota = el('p', 'obs');
  const contar = () => {
    const pl = Number(pop.value) * 1000;
    const e = Number(esp.value);
    if (!(pl > 0 && e > 0)) {
      saida.textContent = '—';
      nota.textContent = 'Preencha os dois para ver a régua.';
      return;
    }
    saida.textContent = `${(pl * e / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} sementes/m`;
    nota.textContent = 'É a população desejada convertida para a linha. '
      + 'NÃO desconta germinação nem vigor — confirme na etiqueta do saco e com seu consultor.';
    guardarRegulagem(pop.value, esp.value);
  };
  pop.oninput = contar;
  esp.oninput = contar;
  contar();

  c.append(el('div', 'campo'), saida, nota);

  const cultivares = [...new Set((p.itens ?? []).map((i) => i.cultivar))].filter(Boolean);
  if (cultivares.length) {
    c.append(el('p', 'sub', `Vem nesta carga: ${cultivares.join(', ')}.`));
  }
  return c;
}

function lerRegulagem() {
  try { return JSON.parse(localStorage.getItem(REGULAGEM)) ?? {}; } catch { return {}; }
}
function guardarRegulagem(pop, esp) {
  try { localStorage.setItem(REGULAGEM, JSON.stringify({ pop, esp })); } catch { /* sem espaço */ }
}

/**
 * A lista de preparo. É a única coisa que a sessão do portal ESCREVE.
 *
 * E é dele: a revenda não lê. "Ainda não tenho gente para descarregar" é
 * problema de quem vai receber, e mudaria a conversa comercial se vazasse.
 */
async function cartaoPreparo(p) {
  const c = el('article', 'cartao');
  c.append(el('p', 'rotulo', 'Preparo'));

  let lista;
  try {
    lista = await api(`/pedidos/${p.id}/preparo`);
  } catch {
    // Sem sinal na fazenda é o normal. A lista aparece quando voltar.
    c.append(el('p', 'obs', 'Não consegui trazer a lista agora.'));
    return c;
  }

  const feitos = () => lista.itens.filter((i) => i.feito).length;
  const conta = el('span', 'num');
  const topo = el('div', 'linha');
  topo.append(el('span', null, 'Só você vê esta lista'), conta);
  c.append(topo);

  lista.itens.forEach((i) => {
    const l = el('label', 'preparo-item');
    const caixa = el('input');
    caixa.type = 'checkbox';
    caixa.checked = i.feito;
    caixa.onchange = async () => {
      caixa.disabled = true;
      try {
        lista = await api(`/pedidos/${p.id}/preparo/${i.codigo}`, {
          metodo: 'PUT', corpo: { feito: caixa.checked },
        });
        conta.textContent = `${feitos()} de ${lista.itens.length}`;
      } catch {
        caixa.checked = !caixa.checked;   // não fingir que gravou
      }
      caixa.disabled = false;
    };
    l.append(caixa, el('span', null, i.texto));
    c.append(l);
  });

  conta.textContent = `${feitos()} de ${lista.itens.length}`;
  return c;
}

function cartaoNota(n) {
  const c = el('article', 'cartao destaque');
  c.append(el('p', 'rotulo', 'Nota e boleto'));
  const l = el('div', 'linha');
  l.append(el('span', null, `NF ${n.numero}`),
    el('span', 'num grande', Number(n.valor).toLocaleString('pt-BR',
      { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })));
  c.append(l);

  if (n.pago_em) {
    c.append(el('p', 'nota-linha', `Paga em ${dia(n.pago_em)}`));
  } else {
    if (n.vencimento) {
      c.append(el('p', 'nota-linha',
        `Vence em ${dia(n.vencimento)}`));
    }
    if (n.linha_digitavel) {
      const b = el('button', 'botao pequeno', 'Copiar boleto');
      b.onclick = async (ev) => {
        ev.stopPropagation();
        await navigator.clipboard.writeText(n.linha_digitavel);
        b.textContent = 'Copiado';
        setTimeout(() => { b.textContent = 'Copiar boleto'; }, 2000);
      };
      c.append(b);
      c.append(el('p', 'obs', 'Você paga no seu banco — a plataforma só mostra.'));
    }
  }
  return c;
}

async function telaLavoura(raiz) {
  const fazendas = await api('/cadastro/minha-lavoura');
  const area = el('section');
  area.append(cabecalho('Minha lavoura', 'Atravessa revenda, consultor e safra'));

  if (fazendas.length === 0) {
    area.append(vazio('Sua lavoura aparece aqui quando o consultor cadastrar a propriedade.'));
  }
  fazendas.forEach((f) => {
    const c = el('article', 'cartao');
    const topo = el('div', 'linha');
    topo.append(el('strong', null, f.nome),
      el('span', 'id', [f.municipio, f.uf].filter(Boolean).join('/')));
    c.append(topo);
    if (f.meu_papel) c.append(el('span', 'etiqueta', PAPEL[f.meu_papel] ?? f.meu_papel));
    if (f.talhoes.length === 0) c.append(el('p', 'obs', 'Sem talhão cadastrado.'));
    f.talhoes.forEach((t) => {
      const l = el('div', 'linha');
      l.append(el('span', null, t.nome),
        el('span', 'num', t.areaHa ? `${Number(t.areaHa).toLocaleString('pt-BR')} ha` : '—'));
      c.append(l);
    });
    area.append(c);
  });
  raiz.replaceChildren(area);
}

/* ---------------------------------------------------------------- visitas */

/**
 * Quem esteve na lavoura dele, e quando.
 *
 * Aqui há uma distinção que não pode ser desfeita por engano mais tarde: o
 * produtor NÃO sabe quem consulta os dados dele — é decisão registrada na
 * seção 08 —, mas sabe muito bem quem entrou na porteira. Uma coisa é acesso a
 * dado por terceiro na cadeia; a outra é serviço prestado a ele, na terra
 * dele. O nome do consultor aparece de propósito.
 *
 * O que NÃO aparece: `duracao_seg`, que é a medição da H1 e diz respeito ao
 * nosso processo, não ao dele; e `canal`, que é encanamento nosso.
 */
async function telaVisitas(raiz) {
  const visitas = await api('/visitas');
  const area = el('section');
  area.append(cabecalho('Visitas', 'Quem esteve na sua lavoura, de todas as revendas'));

  if (visitas.length === 0) {
    area.append(vazio('Nenhuma visita registrada ainda.'));
    raiz.replaceChildren(area);
    return;
  }

  visitas.forEach((v) => {
    const c = el('article', 'cartao');
    const topo = el('div', 'linha');
    topo.append(el('strong', null, v.consultor ?? 'Consultor'),
      el('span', 'id', dataHora(v.em)));
    c.append(topo);

    const detalhe = [v.talhao, v.estagio ? `estádio ${v.estagio}` : null,
      v.estande ? `estande ${Number(v.estande).toLocaleString('pt-BR')}` : null]
      .filter(Boolean).join(' · ');
    if (detalhe) c.append(el('p', 'sub', detalhe));
    if (v.observacao) c.append(el('p', 'obs', v.observacao));

    if (v.fotos?.length) c.append(galeriaDaVisita(v));
    area.append(c);
  });

  raiz.replaceChildren(area);
}

/** As fotos do talhão. Buscadas com a sessão: a rota é privada. */
function galeriaDaVisita(v) {
  const g = el('div', 'galeria');
  v.fotos.forEach((id) => {
    const cx = el('div', 'miniatura');
    fetch(`/midia/${id}`, { headers: { authorization: `Bearer ${estado.token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        const img = el('img');
        img.src = URL.createObjectURL(blob);
        img.alt = `foto da visita de ${v.consultor ?? 'consultor'}`;
        // Tag de imagem não carrega cabeçalho de autorização, então o caminho é
        // o blob; soltar a URL depois de desenhar evita segurar a foto inteira
        // na memória a cada rolagem.
        img.onload = () => URL.revokeObjectURL(img.src);
        cx.replaceChildren(img);
      })
      .catch(() => cx.replaceChildren(el('span', 'sub', '—')));
    g.append(cx);
  });
  return g;
}

const dataHora = (d) => (d
  ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  : '—');

/* -------------------------------------------------------- caderno de campo */

/**
 * O caderno de campo do produtor: o que foi plantado na terra dele, e o que
 * saiu de cada talhão.
 *
 * É camada TÉCNICA, e o desenho diz que ela é compartilhada com o agricultor —
 * a lavoura é dele. A política já resolve isso; aqui é só a tela.
 *
 * O que NÃO aparece: `nossa`, que marca se a semente saiu do nosso catálogo. É
 * leitura comercial, serve ao share por marca, e não diz nada a quem plantou.
 */
async function telaCaderno(raiz) {
  const [plantios, desempenho, resultado] = await Promise.all([
    api('/caderno/plantios'), api('/caderno/desempenho'), api('/caderno/resultado'),
  ]);

  const area = el('section');
  area.append(cabecalho('Caderno de campo', 'O que foi plantado na sua terra'));

  // O resultado vem antes do que foi plantado: é o fim do laço, e é a pergunta
  // que ele faz primeiro — como foi o ano. Aba própria seria a sexta em 375px,
  // e o assunto é o mesmo: o que entrou no talhão e o que saiu dele.
  if (resultado?.safra) area.append(cartaoResultado(resultado));

  if (plantios.length === 0) {
    area.append(vazio('Nada registrado ainda. O consultor anota o plantio, '
      + 'e você pode mandar foto do saco ou áudio pelo WhatsApp da revenda.'));
    raiz.replaceChildren(area);
    return;
  }

  // Safra mais recente primeiro. '26/27' ordena como texto neste século, e é
  // assim que a safra é escrita em todo o resto do sistema.
  const safras = [...new Set(plantios.map((p) => p.safra))].sort().reverse();

  safras.forEach((safra) => {
    // Por nome do talhão: o servidor ordena por data de plantio, que numa
    // mesma safra deixa a lista fora de ordem alfabética — e caderno de campo
    // se lê talhão a talhão, na ordem em que a pessoa anda na fazenda.
    const daSafra = plantios.filter((p) => p.safra === safra)
      .sort((a, b) => String(a.talhao).localeCompare(String(b.talhao), 'pt-BR'));
    const ha = daSafra.reduce((s, p) => s + Number(p.area_ha ?? 0), 0);

    const c = el('article', 'cartao');
    const topo = el('div', 'linha');
    topo.append(el('strong', null, `Safra ${safra}`),
      el('span', 'id', `${daSafra.length} talhão(ões)`),
      el('span', 'num', ha ? `${ha.toLocaleString('pt-BR')} ha` : '—'));
    c.append(topo);

    daSafra.forEach((p) => c.append(linhaDePlantio(p)));
    area.append(c);
  });

  if (desempenho.length) area.append(cartaoDesempenho(desempenho));
  raiz.replaceChildren(area);
}

/**
 * O resultado da safra: o fim do laço.
 *
 * A semente que saiu do pedido virou saco por hectare. Para a revenda o número
 * volta ao funil da safra seguinte; para ele é o ano dele, e é o único lugar do
 * sistema que responde "como foi".
 */
function cartaoResultado(r) {
  const c = el('article', 'cartao destaque');
  const topo = el('div', 'linha');
  topo.append(el('strong', null, `Safra ${r.safra}`),
    el('span', r.fechada ? 'etiqueta boa' : 'etiqueta',
      r.fechada ? 'fechada' : `${r.colhidos} de ${r.talhoes} colhidos`));
  c.append(topo);

  if (r.mediaPonderadaScHa === null) {
    c.append(el('p', 'obs',
      'Nenhuma colheita registrada nesta safra ainda. O número aparece aqui '
      + 'quando o consultor lançar a primeira.'));
    return c;
  }

  const numero = el('p', 'num grande resultado');
  numero.textContent = `${r.mediaPonderadaScHa.toLocaleString('pt-BR')} sc/ha`;
  c.append(numero);

  // A variação com a safra anterior é o que ele olha primeiro — e a resposta diz
  // COM QUAL safra está comparando, porque ela pula ano sem colheita.
  if (r.anterior) {
    const v = r.anterior.variacaoPct;
    const linha = el('p', v >= 0 ? 'variacao sobe' : 'variacao desce');
    linha.textContent = `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR')}% `
      + `em relação à safra ${r.anterior.safra} `
      + `(${r.anterior.mediaPonderadaScHa.toLocaleString('pt-BR')} sc/ha)`;
    c.append(linha);
  }

  const n = el('div', 'linha');
  n.append(el('span', null, `${r.areaColhidaHa.toLocaleString('pt-BR')} ha colhidos`),
    el('span', 'num', `${r.totalSc.toLocaleString('pt-BR')} sc no total`));
  c.append(n);

  // A frase vem da API de propósito: média simples de talhões de tamanhos
  // diferentes faz o ano parecer melhor do que foi.
  c.append(el('p', 'obs', r.base.charAt(0).toUpperCase() + r.base.slice(1) + '.'));

  const colhidos = r.porTalhao.filter((t) => t.produtividadeScHa !== null);
  if (colhidos.length > 1) {
    c.append(el('p', 'rotulo', 'Por talhão, do melhor ao pior'));
    const maior = colhidos[0].produtividadeScHa;
    colhidos.forEach((t) => {
      const l = el('div', 'faixa-talhao');
      const medidor = el('div', 'medidor');
      const barra = el('i');
      barra.style.width = `${(t.produtividadeScHa / maior) * 100}%`;
      medidor.append(barra);
      l.append(el('span', null, t.talhao), medidor,
        el('span', 'num', `${t.produtividadeScHa.toLocaleString('pt-BR')}`));
      c.append(l);
      l.title = [t.cultivar, t.marca, `${t.areaHa.toLocaleString('pt-BR')} ha`]
        .filter(Boolean).join(' · ');
    });
  }
  return c;
}

function linhaDePlantio(p) {
  const bloco = el('div', 'plantio');

  const l = el('div', 'linha');
  l.append(el('span', null, p.talhao),
    el('span', 'num', p.area_ha ? `${Number(p.area_ha).toLocaleString('pt-BR')} ha` : '—'));
  bloco.append(l);

  bloco.append(el('p', 'sub', [
    [p.cultivar, p.marca].filter(Boolean).join(' · '),
    p.ciclo === 'safrinha' ? 'safrinha' : null,
    p.plantado_em ? `plantado em ${dia(p.plantado_em)}` : null,
    p.populacao ? `${Number(p.populacao).toLocaleString('pt-BR')} mil pl/ha` : null,
    // O lote é o que liga o saco à origem. Para ele é a garantia do que plantou.
    p.lote ? `lote ${p.lote}` : null,
  ].filter(Boolean).join(' · ')));

  if (p.produtividade_sc_ha) {
    const r = el('div', 'linha colhido');
    r.append(el('span', null, `Colhido ${p.colhido_em ? `em ${dia(p.colhido_em)}` : ''}`.trim()),
      el('span', 'num grande', `${Number(p.produtividade_sc_ha).toLocaleString('pt-BR')} sc/ha`));
    bloco.append(r);
  } else {
    bloco.append(el('p', 'obs', 'Colheita ainda não registrada.'));
  }
  return bloco;
}

/**
 * Como cada cultivar foi na terra DELE.
 *
 * É a comparação que ele não consegue fazer sozinho — e é o motivo de o app
 * valer a pena para quem plantou, não só para quem vendeu. Sem safra no filtro:
 * a média atravessa os anos registrados, e a tela diz isso.
 */
function cartaoDesempenho(linhas) {
  const c = el('article', 'cartao');
  c.append(el('p', 'rotulo', 'Como cada cultivar foi na sua terra'));

  linhas.forEach((d) => {
    const l = el('div', 'linha');
    l.append(el('span', null, [d.cultivar, d.marca].filter(Boolean).join(' · ')),
      el('span', 'num', `${Number(d.media_sc_ha).toLocaleString('pt-BR')} sc/ha`));
    c.append(l);
    if (d.colhidos > 1) {
      c.append(el('p', 'sub',
        `${d.colhidos} colheitas · de ${Number(d.pior).toLocaleString('pt-BR')} `
        + `a ${Number(d.melhor).toLocaleString('pt-BR')} sc/ha`));
    }
  });

  c.append(el('p', 'obs',
    'Média das colheitas registradas, de todas as safras que estão aqui.'));
  return c;
}

/**
 * Uma data na tela.
 *
 * Coluna `date` chega como `2026-10-12`, sem hora, e é montada pelas partes:
 * `new Date('2026-10-12')` é meia-noite em UTC, e a oeste de Greenwich isso
 * desenha o dia ANTERIOR. Dia de plantio não tem fuso — é uma casa no
 * calendário, não um instante.
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

/* ------------------------------------------------------------------ apoio */

function cabecalho(titulo, sub, voltar) {
  const h = el('header', 'topo');
  if (voltar) {
    const b = el('button', 'voltar', '←');
    b.onclick = () => history.back();
    h.append(b);
  }
  const t = el('div');
  t.append(el('h2', null, titulo));
  if (sub) t.append(el('p', 'sub', sub));
  h.append(t);
  return h;
}

const vazio = (t) => el('p', 'vazio', t);

function barraInferior() {
  const nav = el('nav', 'abas');
  [['Pedidos', '#/'], ['Lavoura', '#/lavoura'], ['Caderno', '#/caderno'],
    ['Visitas', '#/visitas'],
    ['Sair', '#sair']].forEach(([nome, destino]) => {
    const b = el('button', location.hash === destino || (destino === '#/' && !location.hash)
      ? 'ativa' : '', nome);
    b.onclick = () => { if (destino === '#sair') sair(); else location.hash = destino; };
    nav.append(b);
  });
  return nav;
}

/* -------------------------------------------------------------------- push */

async function pedirPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      if (await Notification.requestPermission() !== 'granted') return;
    }
    const { chavePublica } = await api('/push/chave-publica');
    const atual = await reg.pushManager.getSubscription();
    const assinatura = atual ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64ParaBytes(chavePublica),
    });
    await api('/push/assinaturas', {
      metodo: 'POST',
      corpo: { ...assinatura.toJSON(), agente: navigator.userAgent },
    });
  } catch (e) {
    // Push é bônus: se falhar, o portal continua inteiro. No iPhone só existe
    // depois que o produtor adiciona à tela de início.
    console.warn('push indisponível:', e.message);
  }
}

function base64ParaBytes(b64) {
  const completo = (b64 + '='.repeat((4 - b64.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const bruto = atob(completo);
  return Uint8Array.from(bruto, (c) => c.charCodeAt(0));
}

/* ------------------------------------------------------------------ rotas */

async function desenhar() {
  const raiz = $('#app');
  estado.desatualizado = false;

  if (!estado.token) { telaEntrar(raiz); $('#rodape').replaceChildren(); return; }

  try {
    if (!estado.eu) estado.eu = await api('/auth/eu');
    const rota = location.hash.replace(/^#\/?/, '');
    if (rota.startsWith('pedido/')) await telaPedido(raiz, rota.slice(7));
    else if (rota === 'lavoura') await telaLavoura(raiz);
    else if (rota === 'visitas') await telaVisitas(raiz);
    else if (rota === 'caderno') await telaCaderno(raiz);
    else await telaPedidos(raiz);
    $('#rodape').replaceChildren(barraInferior());
  } catch (e) {
    if (e.message === 'sessão expirada') return;
    raiz.replaceChildren(vazio(e.message));
  }

  const faixa = $('#sem-rede');
  faixa.hidden = !estado.desatualizado;
}

window.addEventListener('hashchange', desenhar);
window.addEventListener('online', () => { $('#sem-rede').hidden = true; desenhar(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => { if (estado.token) pedirPush(); });
}

desenhar();

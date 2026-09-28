// O aplicativo de campo do consultor.
//
// Duas coisas o definem, e as duas vêm da H1: registrar uma visita tem de
// caber em menos de 60 segundos, e tem de funcionar sem sinal. Se qualquer uma
// das duas falhar não há dado; sem dado não há produto.
//
// Daí o desenho: a visita é GRAVADA LOCALMENTE primeiro e enviada depois.
// Nunca se espera a rede para dizer ao consultor que está feito — no meio do
// talhão, "enviando..." girando é o mesmo que perder o registro.

const SESSAO = 'colheitai.consultor';
const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};
const num = (n) => Number(n ?? 0).toLocaleString('pt-BR');

// Estádio fenológico da soja. Por toque, nunca digitado: teclado de celular no
// meio da lavoura é o atrito que mata a H1 sozinho.
const ESTADIOS = ['VE', 'VC', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'];

const estado = {
  token: localStorage.getItem(SESSAO),
  eu: null,
  aba: 'fila',
  fila: [],
  filaDeCache: false,
  saida: [],
  sessaoExpirada: false,
};

/* ------------------------------------------------------------------- rede */

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
  if (!resp.ok) {
    const erro = new Error(dados?.erro ?? `erro ${resp.status}`);
    erro.status = resp.status;
    throw erro;
  }
  // O service worker marca o que veio da cópia guardada. A tela diz isso: dado
  // velho identificado como velho é melhor que dado velho passando por novo.
  return { dados, doCache: resp.headers.get('x-do-cache') === '1' };
}

/* --------------------------------------------------------- a fila de saída */
//
// IndexedDB e não localStorage: aqui mora trabalho de campo que ainda não
// chegou ao servidor, e localStorage é síncrono, pequeno e o primeiro a ser
// limpo por qualquer faxina do navegador.

const BASE = 'colheitai-campo';
const LOJA = 'saida';

function abrirBase() {
  return new Promise((ok, falha) => {
    const p = indexedDB.open(BASE, 1);
    p.onupgradeneeded = () => {
      // A chave É o clienteId: guardar duas vezes a mesma visita é impossível
      // por construção, e é o mesmo identificador que o servidor usa para
      // recusar o reenvio duplicado.
      p.result.createObjectStore(LOJA, { keyPath: 'clienteId' });
    };
    p.onsuccess = () => ok(p.result);
    p.onerror = () => falha(p.error);
  });
}

function comLoja(modo, fn) {
  return abrirBase().then((db) => new Promise((ok, falha) => {
    const t = db.transaction(LOJA, modo);
    const pedido = fn(t.objectStore(LOJA));
    t.oncomplete = () => ok(pedido?.result);
    t.onerror = () => falha(t.error);
  }));
}

const enfileirar = (item) => comLoja('readwrite', (l) => l.put(item));
const desenfileirar = (clienteId) => comLoja('readwrite', (l) => l.delete(clienteId));
const naFila = () => comLoja('readonly', (l) => l.getAll());

async function lerFilaDeSaida() {
  try {
    estado.saida = (await naFila()) ?? [];
  } catch {
    // Navegador sem IndexedDB, ou modo privado com armazenamento bloqueado. A
    // tela precisa dizer isso: sem fila local, trabalhar sem sinal perde dado.
    estado.saida = [];
    estado.semArmazenamento = true;
  }
}

/**
 * Tenta enviar o que está na fila, do mais antigo para o mais novo.
 *
 * Em ordem, e parando no primeiro problema de rede: adiantar os seguintes só
 * embaralharia a fila sem entregar nada. O que o servidor RECUSA (400) não
 * volta para a fila — ficaria em laço para sempre —, fica marcado para o
 * consultor ver e decidir.
 */
async function escoar() {
  if (!estado.token || estado.enviando) return;
  estado.enviando = true;
  try {
    const fila = [...estado.saida]
      .filter((i) => !i.recusado)
      .sort((a, b) => a.em.localeCompare(b.em));

    for (const item of fila) {
      try {
        await api('/visitas', { metodo: 'POST', corpo: item.corpo });
        await desenfileirar(item.clienteId);
      } catch (erro) {
        if (erro.status === 401) {
          // Sessão venceu no campo. O registro NÃO se perde por isso: ele fica
          // na fila e sai quando o consultor entrar de novo.
          estado.sessaoExpirada = true;
          break;
        }
        if (erro.status >= 400 && erro.status < 500) {
          await enfileirar({ ...item, recusado: erro.message });
          continue;
        }
        break;   // sem rede, ou servidor fora: a fila espera
      }
    }
  } finally {
    estado.enviando = false;
    await lerFilaDeSaida();
    desenhar();
  }
}

/* ----------------------------------------------------------------- entrar */

function telaEntrar() {
  document.body.classList.add('entrando');
  const c = el('div', 'entrada cartao');
  c.append(el('h1', 'marca', 'colheit.ai'));
  c.append(el('p', 'sub', 'Campo — a fila do dia e o registro de visita'));

  const form = el('form');
  const email = el('input');
  Object.assign(email, { type: 'email', required: true, autocomplete: 'username' });
  const senha = el('input');
  Object.assign(senha, { type: 'password', required: true, autocomplete: 'current-password' });
  const botao = el('button', 'botao', 'Entrar');
  botao.type = 'submit';
  const erro = el('p', 'erro');

  form.append(el('label', 'rotulo', 'E-mail'), email, el('div', 'campo'),
    el('label', 'rotulo', 'Senha'), senha, botao, erro);

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    botao.disabled = true;
    erro.textContent = '';
    try {
      const { dados } = await api('/auth/login', {
        metodo: 'POST', corpo: { email: email.value, senha: senha.value },
      });
      localStorage.setItem(SESSAO, dados.token);
      estado.token = dados.token;
      estado.sessaoExpirada = false;
      await iniciar();
    } catch (e) {
      erro.textContent = e.message;
      botao.disabled = false;
    }
  };

  // Se há visita esperando, dizer isso antes de entrar: é a garantia de que o
  // trabalho de ontem não sumiu com a sessão.
  if (estado.saida.length) {
    c.append(el('p', 'sub',
      `${estado.saida.length} visita(s) guardada(s) aqui, esperando você entrar.`));
  }
  c.append(form);
  return c;
}

function sair() {
  localStorage.removeItem(SESSAO);
  estado.token = null;
  estado.eu = null;
  desenhar();
}

/* ------------------------------------------------------------------ telas */

function cabecalho(titulo, sub, voltarPara) {
  const h = el('header', 'topo');
  if (voltarPara) {
    const b = el('button', 'voltar', '←');
    b.onclick = () => { estado.tela = null; desenhar(); };
    h.append(b);
  }
  const t = el('div');
  t.append(el('h2', null, titulo));
  if (sub) t.append(el('p', 'sub', sub));
  h.append(t);
  return h;
}

/** O aviso de conexão. Aparece só quando há algo a dizer. */
function avisoDeSinal() {
  if (estado.semArmazenamento) {
    return el('div', 'sinal erro',
      'Este navegador não guarda dados. Sem sinal, a visita se perde — entre por outro.');
  }
  if (estado.sessaoExpirada) {
    const d = el('div', 'sinal erro');
    d.append(document.createTextNode('Sua sessão venceu. As visitas estão guardadas — '));
    const b = el('button', 'botao vazado pequeno', 'entrar de novo');
    b.onclick = () => { estado.token = null; desenhar(); };
    d.append(b);
    return d;
  }
  if (estado.semServiceWorker) {
    return el('div', 'sinal erro',
      'Este navegador não deixou o app guardar a casca. Registrar sem sinal '
      + 'funciona, mas só com o app já aberto — não feche no talhão.');
  }
  const recusadas = estado.saida.filter((i) => i.recusado).length;
  if (recusadas) {
    return el('div', 'sinal erro',
      `${recusadas} visita(s) o servidor recusou. Veja na aba Fila de saída.`);
  }
  if (!navigator.onLine) {
    return el('div', 'sinal offline',
      estado.saida.length
        ? `Sem sinal. ${estado.saida.length} visita(s) guardada(s) — saem sozinhas quando voltar.`
        : 'Sem sinal. Pode registrar: sai sozinho quando voltar.');
  }
  return null;
}

/** A fila do dia: quem está há mais tempo sem visita, pesado pela área. */
function telaFila(app) {
  app.append(cabecalho('Fila do dia',
    estado.filaDeCache
      ? 'lista guardada — pode ter mudado desde a última conexão'
      : `${estado.fila.length} produtores · ${estado.eu?.tenant ?? ''}`));

  const aviso = avisoDeSinal();
  if (aviso) app.append(aviso);

  if (estado.fila.length === 0) {
    app.append(el('p', 'vazio', 'Nenhum produtor na sua carteira.'));
    return;
  }

  estado.fila.forEach((f) => {
    const b = el('button', `alvo${f.nunca ? ' nunca' : f.atrasado ? ' atrasado' : ''}`);
    b.append(el('span', 'nome', f.produtor));
    b.append(el('span', 'num', f.nunca ? 'nunca' : `${f.dias}d`));
    b.append(el('span', 'onde',
      [f.municipio, f.area_ha > 0 ? `${num(f.area_ha)} ha` : null].filter(Boolean).join(' · ')));
    b.onclick = () => { estado.ultimaGravada = null; estado.tela = { visita: f }; desenhar(); };
    app.append(b);
  });
}

/**
 * O registro de visita. É esta tela que a H1 mede.
 *
 * O cronômetro começa quando ela abre e para no toque em Registrar — não
 * quando a rede responde. É a duração do REGISTRO, que é o que a hipótese
 * afirma, e medir o envio junto misturaria sinal de celular com atrito de
 * formulário.
 */
function telaVisita(app, f) {
  const abertoEm = Date.now();
  app.append(cabecalho(f.produtor,
    f.nunca ? 'nunca visitado' : `última visita há ${f.dias} dias`, true));

  const c = el('div', 'cartao');
  c.append(el('p', 'rotulo', 'Estádio'));
  const chips = el('div', 'chips');
  let estagio = null;
  ESTADIOS.forEach((e) => {
    const b = el('button', null, e);
    b.type = 'button';
    b.onclick = () => {
      // Tocar de novo desmarca: errar o chip e não conseguir voltar atrás faz
      // o consultor gravar um estádio errado só para sair da tela.
      estagio = estagio === e ? null : e;
      [...chips.children].forEach((x) => x.classList.toggle('ativo', x.textContent === estagio));
    };
    chips.append(b);
  });
  c.append(chips);
  app.append(c);

  const c2 = el('div', 'cartao');
  c2.append(el('label', 'rotulo', 'Estande (plantas/m)'));
  const estande = el('input');
  Object.assign(estande, { type: 'number', step: 'any', inputMode: 'decimal' });
  c2.append(estande, el('div', 'campo'));
  c2.append(el('label', 'rotulo', 'Observação'));
  const obs = el('textarea');
  obs.placeholder = 'O que você viu. Opcional.';
  c2.append(obs);
  app.append(c2);

  const barra = el('div', 'gravar');
  const botao = el('button', 'botao');
  const crono = el('span', 'crono', '0s');
  botao.append(el('span', null, 'Registrar visita'), crono);
  const relogio = setInterval(() => {
    crono.textContent = `${Math.round((Date.now() - abertoEm) / 1000)}s`;
  }, 1000);
  const erro = el('p', 'erro');

  botao.onclick = async () => {
    botao.disabled = true;
    clearInterval(relogio);
    const duracaoSeg = Math.round((Date.now() - abertoEm) / 1000);

    const item = {
      // Gerado AGORA, antes de qualquer tentativa de envio: é o mesmo em todos
      // os reenvios, e é o que o servidor usa para não gravar duas vezes.
      clienteId: (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
      em: new Date().toISOString(),
      produtor: f.produtor,
      corpo: {
        produtorId: f.produtor_id,
        canal: 'app',
        duracaoSeg,
        estagio,
        estande: estande.value === '' ? null : Number(estande.value),
        observacao: obs.value.trim() || null,
      },
    };
    // A hora da visita sai do relógio do celular, não do servidor: visitada às
    // seis da manhã e sincronizada às seis da tarde é uma visita da manhã.
    item.corpo.em = item.em;
    item.corpo.clienteId = item.clienteId;

    try {
      await enfileirar(item);
    } catch {
      erro.textContent = 'Não consegui guardar aqui. Verifique o armazenamento do navegador.';
      botao.disabled = false;
      return;
    }

    // Volta para a fila na hora. O envio corre por fora — o consultor já pode
    // andar para o próximo talhão.
    estado.tela = null;
    estado.ultimaGravada = { produtor: f.produtor, duracaoSeg };
    await lerFilaDeSaida();
    desenhar();
    escoar();
  };

  barra.append(botao, erro);
  app.append(barra);
}

/** O que ainda não chegou ao servidor. Existe para nada ficar invisível. */
function telaSaida(app) {
  app.append(cabecalho('Fila de saída',
    estado.saida.length ? `${estado.saida.length} esperando` : 'nada esperando'));

  const aviso = avisoDeSinal();
  if (aviso) app.append(aviso);

  if (estado.saida.length === 0) {
    app.append(el('p', 'vazio', 'Tudo enviado.'));
    return;
  }

  const agora = el('button', 'botao', 'Tentar enviar agora');
  agora.onclick = () => escoar();
  app.append(agora, el('div', 'campo'));

  estado.saida
    .slice()
    .sort((a, b) => b.em.localeCompare(a.em))
    .forEach((i) => {
      const c = el('div', 'cartao');
      const topo = el('div', 'linha');
      topo.append(el('strong', null, i.produtor),
        el('span', 'id', new Date(i.em).toLocaleString('pt-BR')),
        el('span', i.recusado ? 'etiqueta atencao' : 'etiqueta',
          i.recusado ? 'recusada' : 'esperando'));
      c.append(topo);
      c.append(el('p', 'sub', [
        i.corpo.estagio, i.corpo.estande ? `estande ${i.corpo.estande}` : null,
        `${i.corpo.duracaoSeg}s para registrar`,
      ].filter(Boolean).join(' · ')));
      if (i.corpo.observacao) c.append(el('p', 'obs', i.corpo.observacao));

      if (i.recusado) {
        c.append(el('p', 'erro', i.recusado));
        const fora = el('button', 'botao vazado pequeno', 'Descartar');
        fora.onclick = async () => {
          await desenfileirar(i.clienteId);
          await lerFilaDeSaida();
          desenhar();
        };
        c.append(fora);
      }
      app.append(c);
    });
}

/* --------------------------------------------------------------- desenhar */

function desenhar() {
  const app = $('#app');
  app.replaceChildren();

  if (!estado.token) { app.append(telaEntrar()); return; }
  document.body.classList.remove('entrando');

  if (estado.tela?.visita) { telaVisita(app, estado.tela.visita); return; }

  // Fica até o consultor fazer outra coisa, e não se apaga sozinho: `escoar()`
  // redesenha a tela logo depois de gravar, e um aviso de uma passagem só
  // piscava e sumia antes de alguém ler. Ele também é onde o consultor vê o
  // próprio número da H1 — apagar isso é apagar metade da razão de medir.
  if (estado.ultimaGravada) {
    const g = estado.ultimaGravada;
    const f = el('div', 'faixa');
    f.append(el('strong', null, `${g.produtor}: registrado em ${g.duracaoSeg}s. `),
      document.createTextNode(navigator.onLine ? 'Enviando.' : 'Sai quando o sinal voltar.'));
    app.append(f);
  }

  if (estado.aba === 'fila') telaFila(app);
  else telaSaida(app);

  app.append(abas());
}

function abas() {
  const barra = el('nav', 'abas');
  [['fila', 'Fila do dia'], ['saida', 'Fila de saída']].forEach(([id, rotulo]) => {
    const b = el('button', estado.aba === id ? 'ativa' : '');
    b.append(document.createTextNode(rotulo));
    if (id === 'saida' && estado.saida.length) {
      b.append(el('span', 'conta', String(estado.saida.length)));
    }
    b.onclick = () => { estado.ultimaGravada = null; estado.aba = id; estado.tela = null; desenhar(); };
    barra.append(b);
  });
  const s = el('button', null, 'Sair');
  s.onclick = sair;
  barra.append(s);
  return barra;
}

/* ----------------------------------------------------------------- início */

async function iniciar() {
  await lerFilaDeSaida();
  desenhar();          // a fila local aparece antes de qualquer rede

  try {
    const eu = await api('/auth/eu');
    estado.eu = eu.dados;
    if (!eu.dados.tenant_id) { sair(); return; }
  } catch (erro) {
    // 401 com fila guardada não desloga: o trabalho de campo continua visível,
    // e o consultor entra de novo quando puder.
    if (erro.status === 401 && estado.saida.length) estado.sessaoExpirada = true;
    else if (erro.status === 401) { sair(); return; }
  }

  try {
    const r = await api('/visitas/fila');
    estado.fila = r.dados;
    estado.filaDeCache = r.doCache;
  } catch {
    estado.fila = [];
  }

  desenhar();
  escoar();
}

// Voltou o sinal: escoa sem esperar o consultor perceber. É o momento em que
// ele está dirigindo de volta, com o celular no bolso.
window.addEventListener('online', () => { escoar(); desenhar(); });
window.addEventListener('offline', () => desenhar());

if ('serviceWorker' in navigator) {
  // Escopo próprio: o portal do produtor tem o `sw.js` dele, que não quer nada
  // de fila de escrita. Um por aplicativo é o que mantém os dois simples.
  navigator.serviceWorker.register('/consultor-sw.js', { scope: '/consultor' })
    .catch(() => {
      // Falha silenciosa aqui seria a pior: o app prometeria trabalhar sem
      // sinal e só quebraria no talhão, onde não há como descobrir por quê. A
      // fila local não depende do service worker — o que se perde é ABRIR o
      // app sem conexão, e a tela diz exatamente isso.
      estado.semServiceWorker = true;
      desenhar();
    });
} else {
  estado.semServiceWorker = true;
}

iniciar();

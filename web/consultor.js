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
// Teto de fotos por visita — o mesmo do servidor. Bordadura, meio do talhão,
// praga de perto: mais que isso é álbum, e cada foto é uma subida a mais.
const MAXIMO_FOTOS = 6;

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
  // A última leitura da safra, por produtor. Perder o sinal no talhão não pode
  // apagar da tela o número que ele levou até lá.
  safraLida: {},
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

/* ------------------------------------------------------------------ fotos */

// Lado maior da foto guardada. Uma foto de celular tem 3 a 8 MB; a 1600px e
// qualidade 0,72 ela fica em torno de 250 KB, e continua dando para ver lagarta
// na folha. Numa conexão de fazenda, é a diferença entre subir e não subir.
const LADO_MAXIMO = 1600;
const QUALIDADE = 0.72;

/**
 * Encolhe a foto antes de ela entrar na fila.
 *
 * `imageOrientation: 'from-image'` não é detalhe: sem isso a foto tirada de pé
 * chega deitada, porque o celular grava a rotação no EXIF em vez de girar os
 * pixels — e o canvas desenha os pixels como estão.
 *
 * Se o navegador não colaborar, fica o arquivo original: foto grande é melhor
 * que foto nenhuma, e o servidor recusa acima de 12 MB.
 */
async function encolher(arquivo) {
  try {
    const bitmap = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
    const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height));
    const tela = document.createElement('canvas');
    tela.width = Math.round(bitmap.width * escala);
    tela.height = Math.round(bitmap.height * escala);
    tela.getContext('2d').drawImage(bitmap, 0, 0, tela.width, tela.height);
    bitmap.close?.();
    const menor = await new Promise((ok) => tela.toBlob(ok, 'image/jpeg', QUALIDADE));
    // Foto já pequena pode sair maior depois do recompress. Fica a menor.
    return menor && menor.size < arquivo.size ? menor : arquivo;
  } catch {
    return arquivo;
  }
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
 * Sobe as fotos que ainda não subiram e devolve os identificadores.
 *
 * O progresso é gravado foto a foto, de volta na fila local. Sem isso, cair o
 * sinal na terceira foto faria a próxima tentativa remandar as duas primeiras —
 * meio mega a mais numa conexão que já estava ruim, toda vez.
 *
 * O binário sobe uma vez só: o reenvio da visita carrega identificadores, não
 * arquivos.
 */
async function subirFotos(item) {
  const fotos = item.fotos ?? [];
  if (!fotos.length) return [];

  const ids = [...(item.fotosEnviadas ?? new Array(fotos.length).fill(null))];
  for (let i = 0; i < fotos.length; i++) {
    if (ids[i]) continue;
    const resp = await fetch('/midia', {
      method: 'POST',
      headers: {
        'content-type': fotos[i].type || 'image/jpeg',
        ...(estado.token ? { authorization: `Bearer ${estado.token}` } : {}),
      },
      body: fotos[i],
    });
    const dados = await resp.json().catch(() => null);
    if (!resp.ok) {
      const erro = new Error(dados?.erro ?? `erro ${resp.status}`);
      erro.status = resp.status;
      throw erro;
    }
    ids[i] = dados.id;
    await enfileirar({ ...item, fotosEnviadas: ids });
  }
  return ids;
}

/**
 * Entrega um item da fila ao servidor, conforme o que ele é.
 *
 * A fila é uma só, e por tempo: visita e colheita do mesmo dia saem na ordem em
 * que aconteceram. O que muda por tipo é só a porta.
 *
 * Os dois lados são idempotentes, que é o que torna o reenvio seguro: a visita
 * pelo `clienteId`, e a colheita porque é uma por plantio — reenviar grava o
 * mesmo número no mesmo talhão.
 */
function entregar(item) {
  if (item.tipo === 'colheita') {
    return api(`/caderno/plantios/${item.plantioId}/colheita`, {
      metodo: 'POST', corpo: item.corpo,
    });
  }
  return subirFotos(item).then((midiaIds) =>
    api('/visitas', { metodo: 'POST', corpo: { ...item.corpo, midiaIds } }));
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
        await entregar(item);
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
    // `true` volta para o começo da aba; um objeto volta para aquela tela. Sem
    // isso, sair da colheita caía na lista da carteira em vez de no produtor.
    b.onclick = () => {
      estado.tela = typeof voltarPara === 'object' ? voltarPara : null;
      desenhar();
    };
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

  // Fotos. Ficam ANTES do estande de propósito: é o que o consultor faz com o
  // talhão na frente, e o que ele digita é depois, andando de volta.
  const fotos = [];
  const cF = el('div', 'cartao');
  cF.append(el('p', 'rotulo', 'Fotos do talhão'));
  const galeria = el('div', 'galeria');
  const escolher = el('input');
  // `capture` abre a câmera direto no celular; no computador vira seletor de
  // arquivo, e é o mesmo caminho. `multiple` porque bordadura e meio do talhão
  // são duas fotos, não duas visitas.
  Object.assign(escolher, { type: 'file', accept: 'image/*', capture: 'environment', multiple: true });
  escolher.hidden = true;
  const botaoFoto = el('button', 'botao vazado');
  botaoFoto.type = 'button';
  botaoFoto.textContent = 'Tirar foto';
  botaoFoto.onclick = () => escolher.click();

  const redesenharGaleria = () => {
    galeria.replaceChildren();
    fotos.forEach((f, i) => {
      const cx = el('div', 'miniatura');
      const img = el('img');
      img.src = URL.createObjectURL(f);
      img.alt = `foto ${i + 1}`;
      // A URL é solta assim que a imagem desenha: a foto de 250 KB fica presa
      // na memória até alguém soltar, e são várias por dia de campo.
      img.onload = () => URL.revokeObjectURL(img.src);
      const tirar = el('button', 'tirar', '×');
      tirar.type = 'button';
      tirar.title = 'remover';
      tirar.onclick = () => { fotos.splice(i, 1); redesenharGaleria(); };
      cx.append(img, tirar);
      galeria.append(cx);
    });
    botaoFoto.textContent = fotos.length ? `Mais uma foto (${fotos.length})` : 'Tirar foto';
    botaoFoto.disabled = fotos.length >= MAXIMO_FOTOS;
  };

  escolher.onchange = async () => {
    botaoFoto.disabled = true;
    botaoFoto.textContent = 'preparando…';
    for (const arquivo of [...escolher.files].slice(0, MAXIMO_FOTOS - fotos.length)) {
      fotos.push(await encolher(arquivo));
    }
    escolher.value = '';   // escolher a mesma foto de novo tem de disparar
    redesenharGaleria();
  };

  cF.append(galeria, escolher, botaoFoto);
  app.append(cF);

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
      // Os binários viajam na fila local; o que sobe para o servidor é foto por
      // foto, e o reenvio da visita leva só os identificadores.
      fotos: [...fotos],
      fotosEnviadas: new Array(fotos.length).fill(null),
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
    estado.ultimaGravada = { produtor: f.produtor, duracaoSeg, fotos: fotos.length };
    await lerFilaDeSaida();
    desenhar();
    escoar();
  };

  barra.append(botao, erro);
  app.append(barra);
}

/* ------------------------------------------------------- resultado da safra */

/**
 * A safra da carteira dele, produtor a produtor.
 *
 * Duas coisas num lugar só: o que ele precisa saber antes de bater na porteira
 * — "José fez 63,9, dez por cento acima do ano passado" — e o talhão que ainda
 * falta colher, que é o que ele está ali para fechar.
 *
 * Fica FORA do caminho da visita de propósito. A tela de registro é medida pela
 * H1 e tem de caber em 60 segundos; enfiar o histórico da safra nela seria
 * derrubar a hipótese para ganhar contexto.
 */
async function telaSafra(app) {
  const alvo = estado.tela?.safra ?? null;
  app.append(cabecalho(alvo ? alvo.produtor : 'Safra',
    alvo ? 'o que saiu de cada talhão' : 'a carteira, talhão a talhão', Boolean(alvo)));

  const aviso = avisoDeSinal();
  if (aviso) app.append(aviso);

  // A última leitura fica guardada na memória da página. Sem isso, perder o
  // sinal no meio do talhão apagava a tela inteira — e é justamente ali que ele
  // precisa do número para conversar com o produtor.
  const chave = alvo?.produtor_id ?? 'carteira';
  const guardado = estado.safraLida[chave] ?? {};
  let dados = guardado.safra ?? null;
  let regiao = guardado.regiao ?? null;
  let velho = Boolean(dados);
  try {
    const filtro = alvo ? `?produtorId=${alvo.produtor_id}` : '';
    // A região vem junto, na mesma ida: é ela que abre a conversa na porteira,
    // e buscá-la depois faria a linha aparecer com a tela já montada.
    const [r, b] = await Promise.all([
      api(`/caderno/resultado${filtro}`),
      alvo ? api(`/caderno/benchmark${filtro}`).catch(() => ({ dados: null })) : null,
    ]);
    dados = r.dados;
    regiao = b?.dados ?? null;
    velho = r.doCache;
    estado.safraLida[chave] = { safra: dados, regiao };
  } catch {
    if (!dados) {
      app.append(el('p', 'vazio', 'Não consegui trazer a safra, e não tenho cópia guardada.'));
      return;
    }
  }

  if (!dados?.safra) {
    app.append(el('p', 'vazio', 'Nenhum plantio registrado ainda.'));
    return;
  }
  if (velho) {
    app.append(el('p', 'sub',
      'Números da última vez que houve sinal — podem ter mudado.'));
  }

  app.append(cartaoSafra(dados, regiao));

  if (!alvo) {
    // Sem produtor escolhido, a lista é a porta: ele toca em quem vai visitar.
    estado.fila.forEach((f) => {
      const b = el('button', 'alvo');
      b.append(el('span', 'nome', f.produtor));
      b.append(el('span', 'num', '›'));
      b.append(el('span', 'onde', f.municipio ?? ''));
      b.onclick = () => { estado.tela = { safra: f }; desenhar(); };
      app.append(b);
    });
    return;
  }

  // Com produtor escolhido, o que importa é o talhão que falta fechar.
  dados.porTalhao.forEach((t) => {
    const c = el('div', 'cartao');
    const topo = el('div', 'linha');
    topo.append(el('strong', null, t.talhao),
      el('span', 'num', t.areaHa ? `${num(t.areaHa)} ha` : '—'));
    c.append(topo);
    c.append(el('p', 'sub', [t.cultivar, t.marca].filter(Boolean).join(' · ')));

    if (t.produtividadeScHa !== null) {
      const l = el('div', 'linha');
      l.append(el('span', null, `Colhido ${t.colhidoEm ? dia(t.colhidoEm) : ''}`.trim()),
        el('span', 'num grande', `${num(t.produtividadeScHa)} sc/ha`));
      c.append(l);
    } else if (naFilaDeSaida(t.plantioId)) {
      c.append(el('p', 'sub', 'Colheita registrada — esperando sinal.'));
    } else {
      const b = el('button', 'botao vazado', 'Registrar colheita');
      // `alvo` viaja junto: é por ele que se volta para a safra DESTE produtor
      // depois de gravar. Sem isso a volta caía na carteira inteira.
      b.onclick = () => { estado.tela = { colheita: { ...t, alvo } }; desenhar(); };
      c.append(b);
    }
    app.append(c);
  });
}

const naFilaDeSaida = (plantioId) =>
  estado.saida.some((i) => i.tipo === 'colheita' && i.plantioId === plantioId && !i.recusado);

function cartaoSafra(r, regiao) {
  const c = el('div', 'cartao');
  const topo = el('div', 'linha');
  topo.append(el('strong', null, `Safra ${r.safra}`),
    el('span', r.fechada ? 'etiqueta boa' : 'etiqueta',
      r.fechada ? 'fechada' : `${r.colhidos} de ${r.talhoes} colhidos`));
  c.append(topo);

  if (r.mediaPonderadaScHa === null) {
    c.append(el('p', 'sub', 'Nenhuma colheita registrada nesta safra.'));
    return c;
  }
  c.append(el('p', 'num grande resultado', `${num(r.mediaPonderadaScHa)} sc/ha`));
  if (r.anterior) {
    c.append(el('p', r.anterior.variacaoPct >= 0 ? 'variacao sobe' : 'variacao desce',
      `${r.anterior.variacaoPct > 0 ? '+' : ''}${num(r.anterior.variacaoPct)}% `
      + `sobre a safra ${r.anterior.safra}`));
  }
  // A vizinhança. É o que abre a conversa na porteira — "o senhor fez cinco por
  // cento acima da região" diz mais do que qualquer número sozinho.
  if (regiao && !regiao.semGenteBastante && regiao.mediaPonderadaScHa) {
    const dif = Math.round((r.mediaPonderadaScHa / regiao.mediaPonderadaScHa - 1) * 1000) / 10;
    c.append(el('p', dif >= 0 ? 'variacao sobe' : 'variacao desce',
      `${dif > 0 ? '+' : ''}${num(dif)}% em relação a ${regiao.produtores} outros `
      + `produtores de ${regiao.nivel === 'município' ? regiao.municipio : regiao.uf} `
      + 'que estão aqui'));
    // Ele vai repetir isto ao produtor: a frase tem de ir junto, senão o número
    // vira "a média do município", que ele não é.
    c.append(el('p', 'sub', `${regiao.base.charAt(0).toUpperCase()}${regiao.base.slice(1)}.`));
  }

  const l = el('div', 'linha');
  l.append(el('span', null, `${num(r.areaColhidaHa)} ha colhidos`),
    el('span', 'num', `${num(r.totalSc)} sc`));
  c.append(l);
  // A frase vem da API: média simples de talhões de tamanhos diferentes faz o
  // ano parecer melhor do que foi, e é o que ele vai repetir ao produtor.
  c.append(el('p', 'sub', `${r.base.charAt(0).toUpperCase()}${r.base.slice(1)}.`));
  return c;
}

/**
 * Registrar a colheita, no campo.
 *
 * Mesma fila da visita: grava aqui e sai quando houver sinal. Uma colheita por
 * plantio — reenviar grava o mesmo número no mesmo talhão, então o reenvio é
 * seguro por construção, sem precisar de chave de cliente.
 */
function telaColheita(app, t) {
  app.append(cabecalho(t.talhao, `${t.alvo.produtor} · ${t.cultivar ?? ''}`.trim(),
    { safra: t.alvo }));

  const c = el('div', 'cartao');
  c.append(rotuloCampo('Produtividade (sc/ha)'));
  const sc = el('input');
  Object.assign(sc, { type: 'number', step: 'any', inputMode: 'decimal' });
  c.append(sc, el('div', 'campo'));
  c.append(rotuloCampo('Umidade (%)'));
  const umid = el('input');
  Object.assign(umid, { type: 'number', step: 'any', inputMode: 'decimal' });
  c.append(umid, el('div', 'campo'));
  c.append(rotuloCampo('Observação'));
  const obs = el('textarea');
  obs.placeholder = 'Opcional.';
  c.append(obs);
  app.append(c);

  const barra = el('div', 'gravar');
  const botao = el('button', 'botao', 'Registrar colheita');
  const erro = el('p', 'erro');
  botao.onclick = async () => {
    if (!(Number(sc.value) > 0)) {
      erro.textContent = 'A produtividade é obrigatória.';
      return;
    }
    botao.disabled = true;
    const item = {
      clienteId: (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
      tipo: 'colheita',
      plantioId: t.plantioId,
      produtor: `${t.alvo.produtor} · ${t.talhao}`,
      em: new Date().toISOString(),
      corpo: {
        // A data sai do aparelho: colhido hoje, sincronizado depois, continua
        // sendo de hoje.
        colhidoEm: new Date().toISOString().slice(0, 10),
        produtividadeScHa: Number(sc.value),
        umidade: umid.value === '' ? null : Number(umid.value),
        observacao: obs.value.trim() || null,
      },
    };
    try {
      await enfileirar(item);
    } catch {
      erro.textContent = 'Não consegui guardar aqui.';
      botao.disabled = false;
      return;
    }
    estado.tela = { safra: t.alvo };
    estado.ultimaGravada = null;
    await lerFilaDeSaida();
    desenhar();
    escoar();
  };
  barra.append(botao, erro);
  app.append(barra);
}

const rotuloCampo = (t) => el('label', 'rotulo', t);
const dia = (d) => {
  if (!d) return '';
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [a, m, j] = s.split('-'); return `${j}/${m}/${a}`; }
  return new Date(s).toLocaleDateString('pt-BR');
};

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
      // A fila mistura visita e colheita; o resumo diz o que cada uma é, senão
      // a colheita apareceria como uma visita sem estádio e sem duração.
      c.append(el('p', 'sub', (i.tipo === 'colheita'
        ? [`${num(i.corpo.produtividadeScHa)} sc/ha`,
          i.corpo.umidade ? `${num(i.corpo.umidade)}% de umidade` : null]
        : [
          i.corpo.estagio, i.corpo.estande ? `estande ${i.corpo.estande}` : null,
          i.fotos?.length ? `${i.fotos.length} foto(s)` : null,
          `${i.corpo.duracaoSeg}s para registrar`,
        ]).filter(Boolean).join(' · ')));
      if (i.corpo.observacao) c.append(el('p', 'obs', i.corpo.observacao));

      // As miniaturas saem da própria fila local: sem rede, o consultor
      // continua vendo o que fotografou e o que ainda não subiu.
      if (i.fotos?.length) {
        const g = el('div', 'galeria');
        i.fotos.forEach((b, n) => {
          const cx = el('div', `miniatura${i.fotosEnviadas?.[n] ? ' subiu' : ''}`);
          const img = el('img');
          img.src = URL.createObjectURL(b);
          img.alt = `foto ${n + 1}`;
          img.onload = () => URL.revokeObjectURL(img.src);
          cx.append(img);
          g.append(cx);
        });
        c.append(g);
      }

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
  if (estado.tela?.colheita) { telaColheita(app, estado.tela.colheita); return; }

  // Fica até o consultor fazer outra coisa, e não se apaga sozinho: `escoar()`
  // redesenha a tela logo depois de gravar, e um aviso de uma passagem só
  // piscava e sumia antes de alguém ler. Ele também é onde o consultor vê o
  // próprio número da H1 — apagar isso é apagar metade da razão de medir.
  if (estado.ultimaGravada) {
    const g = estado.ultimaGravada;
    const f = el('div', 'faixa');
    f.append(el('strong', null,
      `${g.produtor}: registrado em ${g.duracaoSeg}s`
      + (g.fotos ? ` com ${g.fotos} foto(s). ` : '. ')),
    document.createTextNode(navigator.onLine ? 'Enviando.' : 'Sai quando o sinal voltar.'));
    app.append(f);
  }

  if (estado.aba === 'fila') telaFila(app);
  else if (estado.aba === 'safra') telaSafra(app);   // async: pinta ao chegar
  else telaSaida(app);

  app.append(abas());
}

function abas() {
  const barra = el('nav', 'abas');
  [['fila', 'Fila do dia'], ['safra', 'Safra'], ['saida', 'Saída']].forEach(([id, rotulo]) => {
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

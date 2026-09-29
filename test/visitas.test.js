// Registro de visita — e a H1 medida em vez de suposta.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dono, encerrar } from '../api/src/db.js';
import { migrar } from '../api/src/migrar.js';
import { usarExtrator } from '../api/src/modulos/captura/extrator.js';
import { subirApi, criarTenant, criarUsuario, entrar, limparBase } from './ajuda.js';

const NUMERO = '5566999000009';
const TEL = '5566999330055';
let req, fechar, revenda, ercules, tGestor, tConsultor, tProdutor, grande, pequeno, semVisita;

before(async () => {
  await migrar({ silencioso: true });
  await limparBase();
  usarExtrator(null);

  revenda = await criarTenant('3 Tentos', '11111111000111', 'distribuidor');
  await criarUsuario(revenda, 'Gestora', 'gestora@3t.com', 'gestor');
  ercules = await criarUsuario(revenda, 'Ercules', 'ercules@3t.com', 'consultor');
  ({ req, fechar } = await subirApi());
  tGestor = await entrar(req, 'gestora@3t.com');
  tConsultor = await entrar(req, 'ercules@3t.com');

  const criaProdutor = async (nome, areaHa) => {
    const p = await req('/cadastro/produtores', {
      metodo: 'POST', token: tGestor, corpo: { nome },
    });
    if (areaHa) {
      await req('/cadastro/propriedades', {
        metodo: 'POST', token: tGestor,
        corpo: { nome: `Fazenda ${nome}`, produtorId: p.corpo.id,
          municipio: 'Sorriso', uf: 'MT', areaHa },
      });
    }
    return p.corpo.id;
  };
  grande = await criaProdutor('Produtor Grande', 18000);
  pequeno = await criaProdutor('Produtor Pequeno', 400);
  semVisita = await criaProdutor('Nunca Visitado', 9000);

  // Quem cadastrou foi a gestora, então o consultor precisa ser autorizado —
  // a carteira é por produtor, e recusar sem ela é o comportamento correto.
  for (const p of [grande, pequeno, semVisita]) {
    const r = await req('/cadastro/carteira', {
      metodo: 'POST', token: tGestor, corpo: { usuarioId: ercules, produtorId: p },
    });
    if (r.status !== 201) throw new Error(`autorização falhou: ${JSON.stringify(r.corpo)}`);
  }

  await req('/captura/canal', { metodo: 'POST', token: tGestor, corpo: { numero: NUMERO } });
  await req('/auth/convites', { metodo: 'POST', token: tGestor, corpo: { produtorId: grande, telefone: TEL } });
  const cod = await req('/auth/produtor/codigo', { metodo: 'POST', corpo: { telefone: TEL } });
  const ent = await req('/auth/produtor/entrar', {
    metodo: 'POST', corpo: { telefone: TEL, codigo: cod.corpo.codigo },
  });
  tProdutor = ent.corpo.token;
});

after(async () => { usarExtrator(null); await fechar(); await encerrar(); });

/* ---------------------------------------------------------------- registro */

test('registra visita, guardando quanto levou e por qual canal', async () => {
  const r = await req('/visitas', {
    metodo: 'POST', token: tConsultor,
    corpo: { produtorId: grande, canal: 'app', duracaoSeg: 41,
      estagio: 'V4', estande: 62, observacao: 'lavoura fechando bem' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.duracao_seg, 41);
  assert.equal(r.corpo.canal, 'app');
  assert.equal(r.corpo.consultor, 'Ercules', 'fica registrado quem foi');
});

test('não registra visita em produtor de outra carteira', async () => {
  const outra = await criarTenant('Rival', '22222222000122');
  await criarUsuario(outra, 'Rival', 'rival@rv.com', 'gestor');
  const tRival = await entrar(req, 'rival@rv.com');

  const r = await req('/visitas', {
    metodo: 'POST', token: tRival, corpo: { produtorId: grande },
  });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /carteira/);
});

test('duração absurda é descartada, não envenena a mediana', async () => {
  const r = await req('/visitas', {
    metodo: 'POST', token: tConsultor,
    corpo: { produtorId: pequeno, duracaoSeg: 60 * 60 * 5 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.duracao_seg, null, 'aba esquecida aberta não é registro de visita');
});

/* -------------------------------------------------------------- fila do dia */

test('nunca visitado vem primeiro — é o pior caso da carteira', async () => {
  const r = await req('/visitas/fila', { token: tConsultor });
  assert.equal(r.corpo[0].produtor_id, semVisita);
  assert.equal(r.corpo[0].nunca, true);
  assert.equal(r.corpo[0].atrasado, true);
});

test('a fila pesa o tempo sem visita pela área', async () => {
  // Grande (18.000 ha) e Pequeno (400 ha) foram visitados agora; o Grande tem
  // que vir antes mesmo empatando em dias.
  const r = await req('/visitas/fila', { token: tConsultor });
  const ordem = r.corpo.map((f) => f.produtor);
  assert.ok(ordem.indexOf('Produtor Grande') < ordem.indexOf('Produtor Pequeno'));
});

test('quem foi visitado hoje não está atrasado', async () => {
  const r = await req('/visitas/fila', { token: tConsultor });
  const g = r.corpo.find((f) => f.produtor_id === grande);
  assert.equal(g.dias, 0);
  assert.equal(g.atrasado, false);
  assert.equal(g.corteDias, 15);
});

test('passado o corte de quinze dias, vira alerta', async () => {
  await dono.query("update visita set em = now() - interval '20 days' where produtor_id = $1",
    [pequeno]);
  const r = await req('/visitas/fila', { token: tConsultor });
  const p = r.corpo.find((f) => f.produtor_id === pequeno);
  assert.equal(p.dias, 20);
  assert.equal(p.atrasado, true);
});

/* ------------------------------------------------------------------- H1 */

test('a H1 é medida por canal, com mediana e não média', async () => {
  for (const s of [30, 35, 900]) {
    await req('/visitas', {
      metodo: 'POST', token: tConsultor,
      corpo: { produtorId: grande, canal: 'app', duracaoSeg: s },
    });
  }
  const r = await req('/visitas/h1', { token: tGestor });
  const app = r.corpo.porCanal.find((c) => c.canal === 'app');
  assert.ok(app.mediana_seg < 60, `mediana ${app.mediana_seg}s deveria confirmar a H1`);
  assert.equal(r.corpo.confirmaAbaixoDe, 60);
  assert.equal(r.corpo.mataAcimaDe, 90);
});

test('sem amostra não sai veredito', async () => {
  // Mediana de três visitas tem a mesma cara de mediana de trezentas, e é
  // dessa cara que sai uma decisão de produto tomada sobre ruído.
  const r = await req('/visitas/h1', { token: tGestor });
  assert.equal(r.corpo.minimoParaVeredito, 20);
  assert.equal(r.corpo.amostraCurta, true, `só ${r.corpo.medidas} medições até aqui`);
});

test('o que se digita no console não conta como registro de campo', async () => {
  // Digitar sentado, com teclado de verdade e sem sol na tela, é mais rápido
  // que digitar no talhão — e como é MAIS rápido, misturar puxaria a mediana
  // para baixo e faria a hipótese parecer confirmada por causa da mesa.
  for (const s of [5, 6, 7]) {
    const r = await req('/visitas', {
      metodo: 'POST', token: tGestor,
      corpo: { produtorId: grande, canal: 'console', duracaoSeg: s },
    });
    assert.equal(r.status, 201);
  }

  const r = await req('/visitas/h1', { token: tGestor });
  assert.equal(r.corpo.porCanal.some((c) => c.canal === 'console'), false,
    'fora da conta');
  assert.equal(r.corpo.foraDaConta.visitas, 3,
    'e visível, porque some-las em silêncio esconderia de onde vem o movimento');

  const app = r.corpo.porCanal.find((c) => c.canal === 'app');
  assert.ok(app.mediana_seg > 7, 'a mediana do app não foi puxada pelos 5-7s da mesa');
});

test('a medição sai por pessoa, que é o que um piloto lê', async () => {
  const r = await req('/visitas/h1', { token: tGestor });
  const meu = r.corpo.porPessoa.filter((p) => p.canal === 'app');
  assert.ok(meu.length >= 1);
  assert.ok(meu[0].nome && meu[0].mediana_seg !== undefined);
  assert.equal(r.corpo.porPessoa.some((p) => p.canal === 'console'), false,
    'o gestor na mesa não é consultor em campo');
});

/* ---------------------------------------- o laço com a captura por WhatsApp */

test('relato de visita validado vira visita, no canal whatsapp', async () => {
  usarExtrator(async () => ({
    transcricao: 'Passei na Gleba 1, estande bom, lavoura fechando.',
    extraido: { estagio: 'V6', estande: 58 },
    tipo: 'visita',
  }));

  const msg = await req('/captura/mensagens', {
    metodo: 'POST', cabecalhos: { 'x-gateway-segredo': process.env.GATEWAY_SEGREDO },
    // A duração do áudio, como o WhatsApp a informa. É a medição da H1 neste
    // canal, e ela chega junto com a mensagem.
    corpo: { de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/visita-1.ogg', duracaoSeg: 29 },
  });
  assert.equal(msg.corpo.desfecho, 'relato_pendente');

  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;
  // Corpo vazio de propósito: quem valida é um agrônomo na mesa, e o tempo
  // DELE não é o esforço do consultor na lavoura. A medição não pode sair daqui.
  const val = await req(`/captura/relatos/${msg.corpo.relatoId}/validar`, {
    metodo: 'POST', token: tConsultor, corpo: {},
  });
  assert.equal(val.status, 200);

  const depois = await req('/visitas', { token: tConsultor });
  assert.equal(depois.corpo.length, antes + 1, 'o áudio virou visita de verdade');

  const nova = depois.corpo[0];
  assert.equal(nova.canal, 'whatsapp');
  assert.equal(nova.duracao_seg, 29, 'veio do áudio, não de quem validou');
  assert.equal(nova.estagio, 'V6');
  assert.match(nova.observacao, /estande bom/);
});

test('o tempo de quem valida não entra na medição', async () => {
  // Antes disto o canal do WhatsApp ficava SEM medida nenhuma — a tela de
  // validação nunca mandou duração —, e o remendo óbvio seria gravar ali o
  // tempo do agrônomo. Seria pior que a lacuna: um número com cara de
  // comparável que mede outra pessoa, em outro lugar, fazendo outra coisa.
  usarExtrator(async () => ({
    transcricao: 'Passei na Gleba 2.', extraido: { estagio: 'V8' }, tipo: 'visita',
  }));
  const msg = await req('/captura/mensagens', {
    metodo: 'POST', cabecalhos: { 'x-gateway-segredo': process.env.GATEWAY_SEGREDO },
    corpo: { de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/visita-2.ogg', duracaoSeg: 41 },
  });
  await req(`/captura/relatos/${msg.corpo.relatoId}/validar`, {
    metodo: 'POST', token: tConsultor, corpo: { duracaoSeg: 999 },
  });
  const nova = (await req('/visitas', { token: tConsultor })).corpo[0];
  assert.equal(nova.duracao_seg, 41, 'o 999 de quem validou foi ignorado');
});

test('áudio sem duração informada fica sem relógio, e não inventa um', async () => {
  usarExtrator(async () => ({
    transcricao: 'Passei na Gleba 3.', extraido: { estagio: 'V9' }, tipo: 'visita',
  }));
  const msg = await req('/captura/mensagens', {
    metodo: 'POST', cabecalhos: { 'x-gateway-segredo': process.env.GATEWAY_SEGREDO },
    corpo: { de: TEL, para: NUMERO, tipo: 'audio', midiaRef: 'midia/visita-3.ogg' },
  });
  await req(`/captura/relatos/${msg.corpo.relatoId}/validar`, {
    metodo: 'POST', token: tConsultor, corpo: {},
  });
  const nova = (await req('/visitas', { token: tConsultor })).corpo[0];
  assert.equal(nova.duracao_seg, null, 'lacuna honesta é melhor que número inventado');
});

test('com os dois canais medidos, a H1 responde qual é mais rápido', async () => {
  const r = await req('/visitas/h1', { token: tGestor });
  const canais = Object.fromEntries(r.corpo.porCanal.map((c) => [c.canal, c.mediana_seg]));
  assert.ok(canais.whatsapp !== undefined, 'é a comparação que a H1 revisada pede');
  assert.ok(canais.app !== undefined);
});

test('relato que não é visita não vira visita', async () => {
  usarExtrator(async () => ({
    transcricao: 'Foto da etiqueta do saco.',
    extraido: { lote: '24-0904' },
    tipo: 'lote',
  }));
  const msg = await req('/captura/mensagens', {
    metodo: 'POST', cabecalhos: { 'x-gateway-segredo': process.env.GATEWAY_SEGREDO },
    corpo: { de: TEL, para: NUMERO, tipo: 'imagem', midiaRef: 'midia/saco.jpg' },
  });
  const antes = (await req('/visitas', { token: tConsultor })).corpo.length;
  await req(`/captura/relatos/${msg.corpo.relatoId}/validar`, {
    metodo: 'POST', token: tConsultor, corpo: {},
  });
  const depois = (await req('/visitas', { token: tConsultor })).corpo.length;
  assert.equal(depois, antes);
});

/* -------------------------------------------------------------- o produtor */

test('o produtor vê quem esteve na lavoura dele', async () => {
  const r = await req(`/visitas?produtorId=${grande}`, { token: tProdutor });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.length > 0);
  assert.ok(r.corpo.every((v) => v.produtor === 'Produtor Grande'));
});

test('o produtor não registra visita nem vê a fila', async () => {
  const cria = await req('/visitas', {
    metodo: 'POST', token: tProdutor, corpo: { produtorId: grande },
  });
  assert.equal(cria.status, 400);
  assert.match(cria.corpo.erro, /área da empresa/);

  const fila = await req('/visitas/fila', { token: tProdutor });
  assert.equal(fila.status, 400);
});

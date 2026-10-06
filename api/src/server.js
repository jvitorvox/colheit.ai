import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app as poolApp } from './db.js';
import { identificar, soEmpresa } from './http/identificar.js';
import { tratarErro } from './http/erros.js';
import { rotasAuth } from './modulos/auth/rotas.js';
import { rotasCadastro } from './modulos/cadastro/rotas.js';
import { rotasConta } from './modulos/conta/rotas.js';
import { rotasPlataforma } from './modulos/plataforma/rotas.js';
import { rotasPedidos } from './modulos/pedidos/rotas.js';
import { rotasPush } from './modulos/push/rotas.js';
import { rotasCaptura } from './modulos/captura/rotas.js';
import { rotasVisitas } from './modulos/visitas/rotas.js';
import { rotasCatalogo } from './modulos/catalogo/rotas.js';
import { rotasFunil } from './modulos/funil/rotas.js';
import { rotasCaderno } from './modulos/caderno/rotas.js';
import { rotasMidia } from './modulos/midia/rotas.js';
import { rotasPainel } from './modulos/painel/rotas.js';
import { ligarSeAutorizado } from './modulos/captura/extrator.js';
import { ligarSeConfigurado } from './modulos/auth/correio.js';
import { garantirAdminFixo } from './admin-fixo.js';

const RAIZ_WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

export function criarApp() {
  const api = express();
  api.disable('x-powered-by');
  api.use(express.json({ limit: '256kb' }));

  // O PWA é servido pela própria API, de propósito: mesma origem resolve CORS,
  // escopo de service worker e cookie de uma vez só. Em produção o nginx fica
  // na frente, mas a origem continua sendo uma.
  // Em produção quem faz cache é o service worker, e a casca pode ter validade
  // curta no HTTP. Em desenvolvimento, zero: senão cada mudança de tela pede
  // recarga forçada, e alguém vai perder meia hora achando que o código não subiu.
  const emProducao = process.env.NODE_ENV === 'production';
  api.use(express.static(RAIZ_WEB, {
    extensions: ['html'],
    maxAge: emProducao ? '5m' : 0,
    etag: true,
  }));

  api.get('/saude', async (_req, res) => {
    try {
      await poolApp.query('select 1');
      res.json({ ok: true });
    } catch (erro) {
      res.status(503).json({ ok: false, erro: erro.message });
    }
  });

  api.use("/auth", rotasAuth);

  // Conta é a única área pública da API: quem chega aqui ainda não é cliente.
  api.use('/conta', rotasConta);

  // Cadastro é área da empresa: a sessão do portal não entra aqui.
  api.use('/cadastro', identificar, rotasCadastro);

  // Pedidos atende as duas sessões: a rota decide por verbo, e a política
  // decide o que cada uma enxerga.
  api.use('/pedidos', rotasPedidos);
  api.use('/push', rotasPush);
  api.use('/captura', rotasCaptura);
  api.use('/visitas', rotasVisitas);
  api.use('/catalogo', rotasCatalogo);
  api.use('/funil', rotasFunil);
  api.use('/caderno', rotasCaderno);
  api.use('/midia', rotasMidia);
  api.use('/painel', rotasPainel);

  // Moderação de cadastro. Sessão de plataforma, que não tem tenant — e por
  // isso não alcança nenhuma das rotas acima nem as tabelas por trás delas.
  api.use('/plataforma', rotasPlataforma);

  api.use((_req, res) => res.status(404).json({ erro: 'rota não encontrada' }));
  api.use(tratarErro);
  return api;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const porta = Number(process.env.API_PORT ?? 3000);

  // A leitura automática se liga na subida do processo, não dentro de
  // `criarApp()`: assim o teste sobe a API sem nunca herdar um extrator de
  // verdade do ambiente, e o que vale aparece no log de quem subiu.
  const ia = ligarSeAutorizado();
  console.log(ia.ligado
    ? `extrator LIGADO (${ia.modelo}) — plano sem-treino declarado`
    : `extrator desligado (${ia.motivo}) — a fila fica guardada`);

  // Mesma ideia, e pelo mesmo motivo: o teste sobe a API sem nunca herdar um
  // correio de verdade do ambiente. Sem ele, "esqueci minha senha" fica fora,
  // e as outras duas portas da recuperação continuam abertas.
  const correio = await ligarSeConfigurado();
  console.log(correio.ligado
    ? `correio LIGADO (${correio.host}, de ${correio.de})`
    : `correio desligado (${correio.motivo}) — recuperação só pelo gestor e pelo admin`);

  // Falhar aqui não derruba a API: o caso comum é o banco ainda sem migração.
  try {
    const admin = await garantirAdminFixo();
    console.log(admin.ligado
      ? `admin de plataforma ${admin.email}`
      : `admin de plataforma desligado (${admin.motivo})`);
  } catch (erro) {
    console.log(`admin de plataforma não criado (${erro.message}) — rode a migração e suba de novo`);
  }

  criarApp().listen(porta, () => console.log(`api em :${porta}`));
}

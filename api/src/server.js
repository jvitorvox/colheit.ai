import express from 'express';
import { app as poolApp } from './db.js';
import { identificar } from './http/identificar.js';
import { tratarErro } from './http/erros.js';
import { rotasCadastro } from './modulos/cadastro/rotas.js';

export function criarApp() {
  const api = express();
  api.disable('x-powered-by');
  api.use(express.json({ limit: '256kb' }));

  api.get('/saude', async (_req, res) => {
    try {
      await poolApp.query('select 1');
      res.json({ ok: true });
    } catch (erro) {
      res.status(503).json({ ok: false, erro: erro.message });
    }
  });

  // Tudo abaixo exige contexto. Cada módulo entra com o próprio prefixo.
  api.use('/cadastro', identificar, rotasCadastro);

  api.use((_req, res) => res.status(404).json({ erro: 'rota não encontrada' }));
  api.use(tratarErro);
  return api;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const porta = Number(process.env.API_PORT ?? 3000);
  criarApp().listen(porta, () => console.log(`api em :${porta}`));
}

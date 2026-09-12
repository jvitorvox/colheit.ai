// Esqueleto. As rotas entram com o módulo `cadastro`, quando a chave de
// identidade do produtor estiver decidida — ver seção 18 do desenho.
import { createServer } from 'node:http';
import { app } from './db.js';

const porta = Number(process.env.API_PORT ?? 3000);

createServer(async (req, res) => {
  if (req.url === '/saude') {
    try {
      await app.query('select 1');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (erro) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, erro: erro.message }));
    }
  }
  res.writeHead(404).end();
}).listen(porta, () => console.log(`api em :${porta}`));

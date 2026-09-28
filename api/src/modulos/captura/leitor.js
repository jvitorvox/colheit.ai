// O leitor da fila: passa o extrator no que está em `aguardando_extracao`.
//
// Roda com o papel DONO e não é uma rota, pelo mesmo motivo do despachante de
// push: a fila atravessa tenants, ela é da plataforma. E é ela que torna a
// espera reversível — no dia em que o plano sem-treino for fechado, a base de
// campo acumulada entra de uma vez, sem ninguém reenviar áudio nenhum.
//
//   docker compose exec -w /app/api api npm run ler
import { dono } from '../../db.js';
import { ligarSeAutorizado } from './extrator.js';
import { extrairPendentes } from './service.js';

/**
 * Liga o extrator pelo ambiente e drena a fila.
 *
 * O limite existe porque cada item é uma chamada paga a provedor externo: uma
 * fila de meses represada, lida de uma vez sem teto, é uma conta que ninguém
 * autorizou. Rodar de novo continua de onde parou.
 */
export async function ler({ limite = Number(process.env.IA_LIMITE) || 100 } = {}) {
  const estado = ligarSeAutorizado();
  if (!estado.ligado) return { extrator: 'desligado', motivo: estado.motivo, processados: 0 };
  return { modelo: estado.modelo, ...(await extrairPendentes({ limite })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ler()
    .then((r) => { console.log(JSON.stringify(r)); return dono.end(); })
    .catch((erro) => { console.error(erro.message); process.exit(1); });
}

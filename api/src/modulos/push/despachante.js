import { dono } from '../../db.js';
import * as repo from './repository.js';
import { enviarWebPush } from './enviador.js';

// Quantas falhas passageiras antes de desistir do aviso. Três é o suficiente
// para atravessar uma instabilidade e pouco o bastante para não guardar aviso
// velho: "a carga saiu" não vale três dias depois.
const MAX_TENTATIVAS = 3;
const MAX_FALHAS_ASSINATURA = 5;

/**
 * Drena a fila de avisos.
 *
 * Roda com o papel DONO, e isso é proposital: a fila atravessa tenants — ela é
 * da plataforma, não de uma empresa. É o mesmo motivo pelo qual migração e job
 * usam o dono, e por isso o despachante não é uma rota.
 *
 * O envio é injetável para o teste poder exercer entrega, assinatura morta e
 * falha passageira sem serviço externo nenhum.
 */
export async function despachar({ limite = 100, enviar = enviarWebPush } = {}) {
  const fila = await repo.pendentes(dono, limite);
  const resumo = { enviadas: 0, descartadas: 0, adiadas: 0, assinaturasRemovidas: 0 };

  for (const aviso of fila) {
    const assinaturas = await repo.assinaturasDoProdutor(dono, aviso.produtor_id);

    if (assinaturas.length === 0) {
      await repo.marcarDescartada(dono, aviso.id, 'sem assinatura de push');
      resumo.descartadas++;
      continue;
    }

    const carga = {
      titulo: 'colheit.ai',
      texto: aviso.texto,
      pedidoId: aviso.pedido_id,
      etapa: aviso.etapa,
    };

    let entregouAlguma = false;
    let ultimoMotivo = null;

    for (const a of assinaturas) {
      const r = await enviar(a, carga);
      if (r.ok) {
        await repo.registrarEntrega(dono, a.id);
        entregouAlguma = true;
        continue;
      }
      ultimoMotivo = r.motivo;
      if (r.morta) {
        await repo.removerAssinatura(dono, a.id);
        resumo.assinaturasRemovidas++;
      } else {
        await repo.registrarFalha(dono, a.id);
      }
    }

    // Basta um navegador receber. Quem tem celular e desktop não precisa dos
    // dois de pé para ficar sabendo.
    if (entregouAlguma) {
      await repo.marcarEnviada(dono, aviso.id);
      resumo.enviadas++;
    } else if (aviso.tentativas + 1 >= MAX_TENTATIVAS) {
      await repo.marcarDescartada(dono, aviso.id, ultimoMotivo ?? 'sem entrega');
      resumo.descartadas++;
    } else {
      await repo.contarTentativa(dono, aviso.id, ultimoMotivo);
      resumo.adiadas++;
    }
  }

  await limparAssinaturasMortas();
  return resumo;
}

/** Assinatura que falha demais está morta mesmo que nunca devolva 410. */
async function limparAssinaturasMortas() {
  await dono.query('delete from assinatura_push where falhas >= $1', [MAX_FALHAS_ASSINATURA]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  despachar()
    .then((r) => { console.log(JSON.stringify(r)); return dono.end(); })
    .catch((erro) => { console.error(erro.message); process.exit(1); });
}

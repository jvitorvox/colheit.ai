import { createHash, randomUUID } from 'node:crypto';
import { dono } from '../../db.js';
import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { armazem } from './armazem.js';
import { uuidValido } from '../cadastro/validar.js';

const TIPOS = {
  'audio/ogg': 'audio', 'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/aac': 'audio',
  'image/jpeg': 'imagem', 'image/png': 'imagem', 'image/webp': 'imagem',
  'application/pdf': 'documento',
};

// Áudio de campo é de segundos e foto de celular não passa disto. O limite
// existe para o canal não virar porta de entrada de arquivo grande.
const MAXIMO_BYTES = 12 * 1024 * 1024;

/**
 * Guarda um arquivo. Chamado pelo gateway, que não tem sessão — por isso usa o
 * papel dono e recebe o tenant de quem chamou, já resolvido pelo canal.
 */
export async function guardar({ tenantId, produtorId, mime, bytes }) {
  // O WhatsApp manda `audio/ogg; codecs=opus`. O parâmetro descreve a
  // codificação, não o tipo — guardar os dois separaria o mesmo formato em
  // duas famílias, e o de cima é o que interessa para decidir o que aceitar.
  const limpo = String(mime ?? '').split(';')[0].trim().toLowerCase();
  const tipo = TIPOS[limpo];
  if (!tipo) throw new ErroDeUso(`tipo de arquivo não aceito: ${mime}`, 'mime');
  if (!bytes?.length) throw new ErroDeUso('arquivo vazio', 'arquivo');
  if (bytes.length > MAXIMO_BYTES) throw new ErroDeUso('arquivo grande demais', 'arquivo');

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Reconexão do gateway reentrega o mesmo áudio. Guardar duas cópias do mesmo
  // minuto é só custo, então o hash decide.
  const jaTem = await repo.porHash(dono, tenantId, sha256);
  if (jaTem) return { id: jaTem.id, repetido: true };

  const chave = `${tenantId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
  const arm = await armazem();
  await arm.guardar(chave, bytes, limpo);

  try {
    const id = await repo.registrar(dono, {
      tenantId, produtorId: produtorId ?? null, tipo, mime: limpo, bytes: bytes.length, sha256, chave,
    });
    return { id, repetido: false };
  } catch (erro) {
    // Sem a linha, o objeto é lixo que ninguém alcança — e que ninguém apagaria.
    await arm.apagar(chave);
    throw erro;
  }
}

/** Entrega o arquivo a quem a política deixar. */
export function baixar(ctx, id) {
  uuidValido(id, 'id');
  return comContexto(ctx, async (cx) => {
    const m = await repo.buscar(cx, id);
    if (!m) throw new NaoEncontrado('mídia');
    const arm = await armazem();
    return { ...m, bytes: await arm.buscar(m.chave) };
  });
}

export const listar = (ctx) => comContexto(ctx, (cx) => repo.listarDoTenant(cx));

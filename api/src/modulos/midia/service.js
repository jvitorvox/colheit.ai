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
 * Guarda um arquivo. Duas portas, uma implementação.
 *
 * O gateway entra pelo papel dono — não tem sessão, e o tenant dele veio do
 * canal. O aplicativo do consultor entra pela sessão, e aí o tenant vem do
 * contexto e a política confere o carimbo no `with check`.
 */
async function guardarCom(cx, { tenantId, produtorId, mime, bytes }) {
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
  const jaTem = await repo.porHash(cx, tenantId, sha256);
  if (jaTem) return { id: jaTem.id, repetido: true };

  const chave = `${tenantId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
  const arm = await armazem();
  await arm.guardar(chave, bytes, limpo);

  try {
    const id = await repo.registrar(cx, {
      tenantId, produtorId: produtorId ?? null, tipo, mime: limpo, bytes: bytes.length, sha256, chave,
    });
    return { id, repetido: false };
  } catch (erro) {
    // Sem a linha, o objeto é lixo que ninguém alcança — e que ninguém apagaria.
    await arm.apagar(chave);
    throw erro;
  }
}

/** A porta do gateway: sem sessão, tenant já resolvido pelo canal. */
export const guardar = (args) => guardarCom(dono, args);

/**
 * A porta do aplicativo do consultor: com sessão.
 *
 * Nasce SEM produtor. Quem carimba de quem é a foto é o vínculo com a visita —
 * lá o produtor já foi conferido contra a carteira, e aqui não haveria como
 * conferir. Aceitar `produtorId` nesta porta deixaria alguém pendurar foto na
 * lavoura de um produtor que não é dele.
 */
export function guardarDaSessao(ctx, { mime, bytes }) {
  return comContexto(ctx, (cx) => guardarCom(cx, {
    tenantId: ctx.tenant, produtorId: null, mime, bytes,
  }));
}

/**
 * Carimba de quem é a mídia, uma vez.
 *
 * É o que faz a foto do talhão aparecer no portal do produtor: a política de
 * `midia` deixa ele alcançar o que tem o id dele. Só preenche o que está vazio
 * — remarcar mídia já atribuída seria mover a foto de um produtor para outro.
 *
 * Recebe `cx` e não `ctx`, ao contrário do resto do módulo: ela participa da
 * transação de quem chamou, porque gravar a visita, pendurar a foto e carimbar
 * o dono têm de acontecer juntos ou não acontecer. Continua sendo service
 * falando com service — nenhum módulo alcança o repository do outro.
 */
export function atribuirAoProdutor(cx, ids, produtorId) {
  if (!ids?.length) return Promise.resolve(0);
  return repo.atribuirAoProdutor(cx, ids, produtorId);
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

/**
 * Lê passando POR CIMA da política, para o extrator.
 *
 * É o mesmo caso do gateway e do despachante de push: job não tem sessão, e a
 * fila atravessa tenants — ela é da plataforma. Não há rota que chegue aqui, e
 * é de propósito: o que passa por cima da política não pode ser alcançável por
 * uma requisição.
 */
export async function lerComoDono(id) {
  const m = await repo.buscar(dono, id);
  if (!m) return null;
  const arm = await armazem();
  return { ...m, bytes: await arm.buscar(m.chave) };
}

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

// ⚠️ Esta é a ÚNICA parte do gateway que conhece o Baileys, e a única que o CI
// não cobre — não há como testá-la sem um número de WhatsApp de verdade. Tudo
// que é decisão mora em laco.js, que roda em teste com um dublê.
//
// Baileys é biblioteca não oficial: é contra os termos do WhatsApp, e quando o
// bloqueio vier não haverá a quem recorrer. Um número por tenant existe para o
// estrago parar num cliente, e o portal continua de pé sozinho.

const SESSOES = process.env.SESSOES_DIR ?? '/dados/sessoes';
const MIDIA = process.env.MIDIA_DIR ?? '/dados/midia';
const silencioso = pino({ level: 'silent' });

const TIPOS = {
  conversation: 'texto',
  extendedTextMessage: 'texto',
  audioMessage: 'audio',
  imageMessage: 'imagem',
};

export async function abrirConexao({ numero, aoReceber, aoConectar, aoCair }) {
  await mkdir(join(SESSOES, numero), { recursive: true });
  await mkdir(MIDIA, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(join(SESSOES, numero));
  let sock;

  const conectar = () => {
    sock = makeWASocket({
      auth: state,
      logger: silencioso,
      browser: Browsers.appropriate('colheit.ai'),
      markOnlineOnConnect: false,   // ficar "online" o dia inteiro é sinal de robô
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        console.log(`\n  Pareie o número ${numero} lendo o código abaixo:\n`);
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') aoConectar?.();
      if (u.connection === 'close') {
        const codigo = u.lastDisconnect?.error?.output?.statusCode;
        const definitivo = codigo === DisconnectReason.loggedOut
          || codigo === DisconnectReason.badSession;
        aoCair?.({ definitivo, motivo: codigo ?? 'desconhecido' });
        if (!definitivo) setTimeout(conectar, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          await aoReceber(await traduzir(m, sock));
        } catch (erro) {
          console.error('falha ao traduzir mensagem:', erro.message);
        }
      }
    });
  };

  conectar();

  return {
    enviarTexto: (para, texto) => sock.sendMessage(`${para}@s.whatsapp.net`, { text: texto }),
    fechar: async () => { try { await sock?.logout?.(); } catch { /* já caiu */ } },
  };
}

/** Traduz o formato do Baileys para o que o laço entende. */
async function traduzir(m, sock) {
  const jid = m.key.remoteJid ?? '';
  const chave = Object.keys(m.message ?? {}).find((k) => TIPOS[k]);
  const tipo = TIPOS[chave] ?? 'texto';

  const bruta = {
    id: m.key.id,
    de: jid.split('@')[0],
    deMim: Boolean(m.key.fromMe),
    deGrupo: jid.endsWith('@g.us'),
    deStatus: jid === 'status@broadcast',
    tipo,
    texto: m.message?.conversation
      ?? m.message?.extendedTextMessage?.text
      ?? m.message?.imageMessage?.caption
      ?? null,
    midiaRef: null,
  };

  if (bruta.deMim || bruta.deGrupo || bruta.deStatus) return bruta;

  if (tipo === 'audio' || tipo === 'imagem') {
    // O binário não vai para o banco: fica no volume, e o que trafega é o
    // ponteiro. Armazenamento de verdade entra quando houver — aqui é disco.
    const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: silencioso, reuploadRequest: sock.updateMediaMessage });
    const nome = `${randomUUID()}.${tipo === 'audio' ? 'ogg' : 'jpg'}`;
    await writeFile(join(MIDIA, nome), buffer);
    bruta.midiaRef = nome;
  }

  return bruta;
}

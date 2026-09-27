import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Dois armazéns atrás da mesma porta: disco para desenvolver, S3 para valer.
//
// A escolha é por ambiente e não por chamada — quem guarda não precisa saber
// onde. Trocar de um para o outro é uma variável, e é essa a razão da costura.

/* ------------------------------------------------------------------ disco */

export function armazemDeDisco(raiz) {
  const base = resolve(raiz);
  // Chave é construída por nós, mas normalizar antes de concatenar é o que
  // impede que um dia alguém passe "../" e escreva fora do lugar.
  const caminho = (chave) => {
    const destino = resolve(join(base, chave));
    if (!destino.startsWith(base)) throw new Error('chave inválida');
    return destino;
  };

  return {
    nome: 'disco',
    async guardar(chave, bytes) {
      const destino = caminho(chave);
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(destino, bytes);
    },
    buscar: (chave) => readFile(caminho(chave)),
    async apagar(chave) {
      try { await unlink(caminho(chave)); } catch { /* já não existia */ }
    },
  };
}

/* --------------------------------------------------------------------- s3 */

async function armazemS3() {
  // Importado sob demanda: quem roda com disco não paga o custo de carregar o
  // SDK inteiro na subida da API.
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
    CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');

  const balde = exigir('S3_BUCKET');
  const cliente = new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGIAO ?? 'us-east-1',
    // MinIO e compatíveis não usam host por bucket.
    forcePathStyle: true,
    credentials: {
      accessKeyId: exigir('S3_CHAVE'),
      secretAccessKey: exigir('S3_SEGREDO'),
    },
  });

  try {
    await cliente.send(new HeadBucketCommand({ Bucket: balde }));
  } catch {
    await cliente.send(new CreateBucketCommand({ Bucket: balde })).catch(() => {});
  }

  return {
    nome: 's3',
    guardar: (chave, bytes, mime) => cliente.send(new PutObjectCommand({
      Bucket: balde, Key: chave, Body: bytes, ContentType: mime,
    })),
    async buscar(chave) {
      const r = await cliente.send(new GetObjectCommand({ Bucket: balde, Key: chave }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    apagar: (chave) => cliente.send(new DeleteObjectCommand({ Bucket: balde, Key: chave }))
      .catch(() => {}),
  };
}

function exigir(nome) {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} é obrigatória quando ARMAZEM=s3`);
  return v;
}

/* ------------------------------------------------------------------ porta */

let atual = null;

export async function armazem() {
  if (atual) return atual;
  atual = process.env.ARMAZEM === 's3'
    ? await armazemS3()
    : armazemDeDisco(process.env.MIDIA_DIR ?? '/dados/midia');
  return atual;
}

/** Para o teste poder exercitar os dois sem reiniciar o processo. */
export function usarArmazem(a) { atual = a; }

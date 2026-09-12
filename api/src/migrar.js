// Migração versionada desde o primeiro dia, como manda a seção 13.
// Aplica db/migrations/*.sql em ordem, uma vez cada, dentro de transação.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dono } from './db.js';

const pasta = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

export async function migrar({ silencioso = false } = {}) {
  const log = silencioso ? () => {} : console.log;

  await dono.query(`
    create table if not exists schema_migrations (
      versao      text primary key,
      aplicada_em timestamptz not null default now()
    )`);

  const { rows } = await dono.query('select versao from schema_migrations');
  const jaAplicadas = new Set(rows.map((r) => r.versao));

  const arquivos = (await readdir(pasta)).filter((f) => f.endsWith('.sql')).sort();
  let aplicadas = 0;

  for (const arquivo of arquivos) {
    if (jaAplicadas.has(arquivo)) continue;
    const sql = await readFile(join(pasta, arquivo), 'utf8');
    const cx = await dono.connect();
    try {
      await cx.query('begin');
      await cx.query(sql);
      await cx.query('insert into schema_migrations (versao) values ($1)', [arquivo]);
      await cx.query('commit');
      log(`  aplicada  ${arquivo}`);
      aplicadas++;
    } catch (erro) {
      await cx.query('rollback');
      throw new Error(`falhou em ${arquivo}: ${erro.message}`, { cause: erro });
    } finally {
      cx.release();
    }
  }

  log(aplicadas ? `${aplicadas} migração(ões) aplicada(s)` : 'banco já está na última versão');
  return aplicadas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrar()
    .then(() => dono.end())
    .catch((erro) => { console.error(erro.message); process.exit(1); });
}

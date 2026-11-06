// A conta de plataforma que nasce sozinha na subida da API.
//
// `npm run admin -- plataforma` continua sendo o caminho de quem tem a máquina:
// sai um link de uma viagem só, e ninguém conhece a senha de ninguém. Este aqui
// é o atalho para ambiente de desenvolvimento e homologação, onde ter um login
// conhecido vale mais do que rodar um comando a cada banco novo.
//
// O .env manda: a cada subida a conta é criada ou alinhada a ele — senha,
// nome e `ativo`. Trocar a senha é trocar a variável e subir de novo.
// Sem PLATAFORMA_ADMIN_EMAIL ou PLATAFORMA_ADMIN_SENHA, nada acontece.
import { dono } from './db.js';
import { gerarHash } from './modulos/auth/senha.js';

const SENHA_PADRAO = 'colheitai-admin';

// A migração 040, embutida no código. A imagem da API copia só `src/`: onde o
// banco não recebe `db/migrations` (produção sem o bind mount do compose), a
// 040 nunca rodava. Usa a mesma versão em schema_migrations, então roda uma vez
// só, venha por aqui ou pelo `migrar`.
const VERSAO_040 = '040_redefine_senha_admin_plataforma.sql';
const HASH_040 = 'scrypt$16384$8$1$A5PuiQC4lgqDDO0FBwN06Q==$UgAFJn8aKn84/R1piNCNH6h0N1Zzo81FYlgk1o8TGstvks06XqNsTNqo5DhTyLRSaaAumLdoPZK7FpwJBwqIAg==';

export async function redefinirAdminUmaVez() {
  const cx = await dono.connect();
  try {
    await cx.query('begin');
    await cx.query(`create table if not exists schema_migrations (
      versao text primary key, aplicada_em timestamptz not null default now())`);
    const { rowCount } = await cx.query(
      'insert into schema_migrations (versao) values ($1) on conflict do nothing', [VERSAO_040]);
    if (rowCount === 0) { await cx.query('rollback'); return false; }
    await cx.query(`
      insert into plataforma_usuario (nome, email, senha_hash)
      values ('Admin', 'admin@colheit.ai', $1)
      on conflict (email) do update set senha_hash = excluded.senha_hash, ativo = true`, [HASH_040]);
    await cx.query(`delete from tentativa_login where chave = 'admin@colheit.ai'`);
    await cx.query('commit');
    return true;
  } catch (erro) {
    await cx.query('rollback');
    throw erro;
  } finally {
    cx.release();
  }
}

export async function garantirAdminFixo(env = process.env) {
  const email = String(env.PLATAFORMA_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const senha = env.PLATAFORMA_ADMIN_SENHA ?? '';
  const nome = String(env.PLATAFORMA_ADMIN_NOME ?? '').trim() || 'Admin';
  if (!email || !senha) return { ligado: false, motivo: 'PLATAFORMA_ADMIN_EMAIL/SENHA ausentes' };

  // A senha padrão está escrita no repositório. Em produção ela seria a porta
  // de entrada de qualquer um que leu o código.
  if (senha === SENHA_PADRAO && env.NODE_ENV === 'production') {
    return { ligado: false, motivo: 'senha padrão recusada em produção' };
  }

  const hash = await gerarHash(senha);
  await dono.query(`
    insert into plataforma_usuario (nome, email, senha_hash)
    values ($1, $2, $3)
    on conflict (email) do update
      set nome = excluded.nome, senha_hash = excluded.senha_hash, ativo = true`,
  [nome, email, hash]);
  return { ligado: true, email, padrao: senha === SENHA_PADRAO };
}

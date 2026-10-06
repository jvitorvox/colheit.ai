// A conta de plataforma que nasce sozinha na subida da API.
//
// `npm run admin -- plataforma` continua sendo o caminho de quem tem a máquina:
// sai um link de uma viagem só, e ninguém conhece a senha de ninguém. Este aqui
// é o atalho para ambiente de desenvolvimento e homologação, onde ter um login
// conhecido vale mais do que rodar um comando a cada banco novo.
//
// O .env manda: a cada subida a conta é criada ou alinhada a ele — senha,
// nome e `ativo`. Trocar a senha é trocar a variável e subir de novo.
// Sem PLATAFORMA_ADMIN_EMAIL ou PLATAFORMA_ADMIN_SENHA, nada acontece — e não
// há valor padrão de propósito: senha escrita no repositório é senha de todos.
import { dono } from './db.js';
import { gerarHash } from './modulos/auth/senha.js';

export async function garantirAdminFixo(env = process.env) {
  const email = String(env.PLATAFORMA_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const senha = env.PLATAFORMA_ADMIN_SENHA ?? '';
  const nome = String(env.PLATAFORMA_ADMIN_NOME ?? '').trim() || 'Admin';
  if (!email || !senha) return { ligado: false, motivo: 'PLATAFORMA_ADMIN_EMAIL/SENHA ausentes' };

  const hash = await gerarHash(senha);
  await dono.query(`
    insert into plataforma_usuario (nome, email, senha_hash)
    values ($1, $2, $3)
    on conflict (email) do update
      set nome = excluded.nome, senha_hash = excluded.senha_hash, ativo = true`,
  [nome, email, hash]);
  return { ligado: true, email };
}

// `npm run superadmin` — o passo do deploy, depois da migração. Ao contrário da
// subida, aqui faltar a variável é erro: quem chamou queria a conta.
if (import.meta.url === `file://${process.argv[1]}`) {
  garantirAdminFixo()
    .then((r) => {
      if (!r.ligado) throw new Error(r.motivo);
      console.log(`super admin pronto: ${r.email}`);
    })
    .then(() => dono.end())
    .catch((erro) => { console.error(`super admin não criado: ${erro.message}`); process.exit(1); });
}

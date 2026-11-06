// `npm run superadmin`: o mesmo alinhamento do admin fixo que a API faz na
// subida, só que depois da migração.
//
// O deploy sobe a API antes de migrar, então num banco novo a tentativa da
// subida falha (a tabela ainda não existe). Este passo, rodado no fim do
// deploy, garante a conta a partir de PLATAFORMA_ADMIN_* e diz o que fez.
import { garantirAdminFixo } from './admin-fixo.js';
import { encerrar } from './db.js';

try {
  const admin = await garantirAdminFixo();
  console.log(admin.ligado
    ? `admin de plataforma ${admin.email}${admin.padrao ? ' — ⚠️ SENHA PADRÃO, troque PLATAFORMA_ADMIN_SENHA' : ''}`
    : `admin de plataforma desligado (${admin.motivo})`);
} finally {
  await encerrar();
}

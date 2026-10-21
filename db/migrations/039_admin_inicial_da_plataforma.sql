-- O login inicial da /plataforma, gravado no banco.
--
--   e-mail  admin@colheit.ai
--   senha   colheitai-admin
--
-- Existe para que todo banco novo já tenha por onde entrar na moderação, sem
-- depender de .env nem de `npm run admin -- plataforma`. A senha está escrita
-- aqui, então é de todos que leem o repositório: troque-a fora do seu
-- computador (`npm run admin -- senha-plataforma admin@colheit.ai`, ou
-- PLATAFORMA_ADMIN_SENHA no .env).
--
-- `do nothing` no conflito: se a conta já existe, a senha dela não é tocada.
insert into plataforma_usuario (nome, email, senha_hash)
values ('Admin', 'admin@colheit.ai',
  'scrypt$16384$8$1$xhCxPt/bAo/p0/6RmwrJsA==$pmk3nY9QO8xkxT66FZMOsikwWnwJKgmlITvkVU4/r/N45xemHxL8fVcUlIFv1xHCaI+gu9ei4jGOi/9JmGC9tg==')
on conflict (email) do nothing;

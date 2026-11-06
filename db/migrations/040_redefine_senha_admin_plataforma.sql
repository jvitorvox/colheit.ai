-- Redefine a senha de admin@colheit.ai para quem não tem acesso ao servidor.
--
-- A 039 usa `do nothing` no conflito: se a conta já existia em produção, a
-- senha antiga continuou valendo e ninguém a conhecia. Esta migração alinha a
-- conta, cria se faltar e reativa.
--
-- O repositório é público, então aqui vai só o hash scrypt de uma senha
-- aleatória e forte. A senha foi entregue ao dono fora do repositório. Troque-a
-- depois de entrar.
insert into plataforma_usuario (nome, email, senha_hash)
values ('Admin', 'admin@colheit.ai',
  'scrypt$16384$8$1$A5PuiQC4lgqDDO0FBwN06Q==$UgAFJn8aKn84/R1piNCNH6h0N1Zzo81FYlgk1o8TGstvks06XqNsTNqo5DhTyLRSaaAumLdoPZK7FpwJBwqIAg==')
on conflict (email) do update
  set senha_hash = excluded.senha_hash, ativo = true;

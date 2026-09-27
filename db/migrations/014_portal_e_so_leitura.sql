-- 014 · A sessão do portal é só de leitura, de verdade
--
-- Correção de um furo aberto na 011. As políticas do produtor foram escritas
-- só com `using`, e nesse caso o PostgreSQL usa a MESMA expressão como
-- `with check` no INSERT e no UPDATE. O comentário da 011 dizia que a sessão
-- do portal era de leitura; o banco discordava.
--
-- Na prática, o produtor autenticado podia:
--   · inserir produtor_vinculo com o próprio id — se pendurar em QUALQUER
--     revenda da plataforma, passando a enxergar a carteira dela;
--   · inserir produtor_propriedade ligando a si mesmo terra alheia, e com isso
--     enxergar a propriedade e os talhões de outro produtor;
--   · alterar o próprio nome e os próprios documentos, inclusive assumindo um
--     CPF que ainda não tivesse dono.
--
-- `with check (false)` fecha as três. Leitura continua igual.

alter policy produtor_ele_mesmo   on produtor             with check (false);
alter policy documento_dele       on produtor_documento   with check (false);
alter policy vinculo_dele         on produtor_vinculo     with check (false);
alter policy propriedade_dele     on propriedade          with check (false);
alter policy relacao_dele         on produtor_propriedade with check (false);
alter policy talhao_dele          on talhao               with check (false);

comment on function app.produtor_atual() is
  'O produtor da sessão do portal. Nulo em toda sessão de tenant. A sessão dele '
  'é estritamente de leitura no núcleo — o que ele manda do campo entra por '
  'outro caminho e passa pela validação do consultor.';

-- 027 · O produtor vê o nome de quem esteve na lavoura dele
--
-- A 018 já dizia a intenção: "o produtor vê QUEM esteve na lavoura dele e
-- quando". Só que `usuario` tem isolamento por tenant, e a sessão do portal não
-- tem tenant — então o `left join` da listagem devolvia nome nulo, em silêncio.
-- A tela mostraria "Consultor" genérico e ninguém desconfiaria de nada.
--
-- Vale marcar a distinção, porque ela é fácil de desfazer por engano depois: o
-- produtor NÃO sabe quem consulta os dados dele — decisão da seção 08 — mas
-- sabe muito bem quem entrou na porteira. Acesso a dado por terceiro na cadeia
-- e serviço prestado na terra dele são coisas diferentes.

create policy usuario_que_visitou on usuario
  using (
    exists (select 1 from visita v
             where v.usuario_id = usuario.id
               and v.produtor_id = app.produtor_atual())
  )
  with check (false);

comment on policy usuario_que_visitou on usuario is
  'Política, e não função security definer: a subconsulta passa pela política '
  'de `visita`, então o alcance é exatamente quem registrou visita para ESTE '
  'produtor — sem criar uma função que devolva nome de usuário por id solto. '
  'Ela abre a LINHA; nenhuma rota do portal seleciona coluna de usuario além '
  'do nome do consultor na listagem de visitas.';

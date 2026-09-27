-- 012 · Território
--
-- Um município, um franqueado. É exclusivo, e é ele que decide de quem é o
-- produtor quando a venda passa por uma distribuidora que atende vários
-- fornecedores.
--
-- O lote no saco não serve para esse desempate: quem embala é a franqueadora,
-- então os sacos que dois franqueados entregam à mesma distribuidora saem
-- idênticos. O lote diz a marca e o que foi plantado; o município diz de quem
-- é a venda.

alter table tenant drop constraint tenant_tipo_check;
alter table tenant add constraint tenant_tipo_check
  check (tipo in ('franqueadora', 'franqueado', 'industria', 'distribuidor', 'revenda'));

create table territorio (
  municipio     text not null,
  uf            char(2) not null,
  franqueado_id uuid not null references tenant(id) on delete cascade,
  desde         date not null default current_date,
  primary key (municipio, uf)
);

comment on table territorio is
  'Chave em (municipio, uf): a exclusividade é a própria restrição de unicidade. '
  'Dois franqueados no mesmo município é um estado que o banco não permite existir.';

create index on territorio (franqueado_id);

-- Território é dado de rede, não de tenant: a distribuidora precisa saber a
-- qual franqueado pertence o município do produtor dela. Leitura aberta,
-- escrita só pelo dono.
grant select on territorio to public;

create or replace function app.franqueado_do_municipio(p_municipio text, p_uf char(2))
  returns uuid
  language sql stable
  as $$
    select franqueado_id from territorio
     where municipio = p_municipio and uf = p_uf
  $$;

comment on function app.franqueado_do_municipio(text, char) is
  'Usada para CARIMBAR a atribuição no momento da venda — nunca para recalcular '
  'depois. Redesenhar um território reescreveria o passado e vazaria histórico '
  'de um franqueado para outro.';

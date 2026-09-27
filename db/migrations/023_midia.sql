-- 023 · Mídia
--
-- Áudio de produtor descrevendo a própria lavoura é o dado mais sensível que o
-- projeto captura. Ele não pode ficar em disco de um contêiner — nem atrás de
-- URL pública, que é o jeito mais comum de vazar sem perceber.
--
-- O binário vai para o armazém; aqui fica o registro, com dono e política.

create table midia (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  produtor_id uuid references produtor(id) on delete set null,
  tipo        text not null check (tipo in ('audio', 'imagem', 'documento')),
  mime        text not null,
  bytes       integer not null check (bytes > 0),
  sha256      text not null,
  chave       text not null unique,
  criado_em   timestamptz not null default now()
);

comment on column midia.chave is
  'Caminho no armazém. Nunca sai numa URL: quem busca o arquivo passa por '
  '/midia/:id, e a política decide antes de o byte sair.';
comment on column midia.sha256 is
  'Mesmo arquivo enviado duas vezes reaproveita a linha. Reconexão do gateway '
  'reentrega áudio, e guardar duas cópias do mesmo minuto é só custo.';

create index on midia (tenant_id, criado_em desc);
create unique index on midia (tenant_id, sha256);

select app.aplicar_isolamento('midia');

-- O produtor alcança o que ele mesmo mandou.
create policy midia_dele on midia
  using (produtor_id = app.produtor_atual())
  with check (false);

-- ---------------------------------------------------------------------------
-- A mensagem passa a apontar para o registro, não para um nome de arquivo.
--
-- `midia_ref` guardava o nome que o gateway escrevia em disco. Sem FK, sem
-- dono e sem política — funcionava numa máquina, e é justamente o que estava
-- sendo consertado. Não há dado de produção a preservar.
-- ---------------------------------------------------------------------------
alter table mensagem_whatsapp drop column midia_ref;
alter table mensagem_whatsapp add column midia_id uuid references midia(id) on delete set null;

create index on mensagem_whatsapp (midia_id) where midia_id is not null;

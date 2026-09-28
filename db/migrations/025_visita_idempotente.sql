-- 025 · Visita registrada uma vez só
--
-- O aplicativo do consultor trabalha sem sinal e guarda a visita numa fila
-- local, que ele reenvia quando a conexão volta. Reenvio é o normal desse
-- desenho, não a exceção: o celular perde o rádio no meio do POST, a resposta
-- não chega, e o aplicativo — que não tem como saber se o servidor gravou —
-- tenta de novo.
--
-- Sem uma chave que o CLIENTE gera, cada tentativa vira uma visita nova. O
-- consultor visitou uma vez e a mediana da H1 passa a contar três registros de
-- dez segundos: o número que decide o produto fica envenenado justamente pela
-- peça que existe para alimentá-lo.

alter table visita add column cliente_id uuid;

comment on column visita.cliente_id is
  'Identificador que o APLICATIVO gera antes de tentar enviar, e repete em cada '
  'reenvio da mesma visita. É o que torna o reenvio seguro. Nulo para visita '
  'criada por outro caminho — formulário do console, relato do WhatsApp.';

-- Por tenant, e não global: chave que o cliente gera não deve permitir a
-- ninguém descobrir, por colisão, que outra empresa gravou algo.
create unique index visita_cliente_id_por_tenant
  on visita (tenant_id, cliente_id)
  where cliente_id is not null;

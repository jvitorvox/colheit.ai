-- 038 · A H1 medível de verdade
--
-- A H1 decide o produto: se o consultor não registra a visita em menos de 60
-- segundos de mediana, não há dado, e sem dado não há CRM. A 018 disse que a
-- medição seria contínua em vez de um dia de campo com cronômetro — e era, mas
-- o instrumento tinha três defeitos que só aparecem quando alguém vai levá-lo
-- a campo. Um deles empurra o número para o lado errado.
--
--   1. O CONSOLE se carimbava como `app`.
--
--      A janela de visita do console cronometra a si mesma e grava
--      `canal: 'app'`. Só que quem digita ali é o gestor, sentado, com teclado
--      de verdade, sem sol e sem luva — e cai no mesmo balde do consultor no
--      meio do talhão. Pior: digitar na mesa é MAIS RÁPIDO, então a mistura
--      puxa a mediana para baixo e faz a hipótese parecer confirmada. Para um
--      número que decide o produto, é o pior viés possível.
--
--   2. O WHATSAPP não tinha relógio NENHUM.
--
--      `duracao_seg` do relato validado vinha do corpo do POST de validação —
--      e a tela de validação nunca mandou nada. Na prática: zero medidas
--      naquele canal, justamente o canal que a H1 revisada quer comparar com o
--      aplicativo. Pior ainda seria o que quase aconteceu: gravar ali o tempo
--      de quem VALIDA, que é um agrônomo na mesa, e apresentar isso como
--      esforço do consultor na lavoura.
--
--   3. Não havia piso de amostra.
--
--      Mediana de três visitas devolvia veredito com a mesma cara de mediana
--      de trezentas.
--
-- Este arquivo resolve 1 e 2. O piso é do serviço, ao lado do veredito.

-- ---------------------------------------------------------------------------
-- 1 · O console é um canal, e não o aplicativo.
-- ---------------------------------------------------------------------------
alter table visita drop constraint visita_canal_check;
alter table visita add constraint visita_canal_check
  check (canal in ('app', 'whatsapp', 'console'));

comment on column visita.canal is
  'app = aplicativo do consultor, na lavoura. whatsapp = áudio do produtor. '
  'console = alguém digitando na mesa — NÃO entra no veredito da H1, porque '
  'digitar sentado é mais rápido e misturar puxaria a mediana para baixo.';

-- O que já existe fica como está. As visitas de antes desta linha vieram de
-- seed e de teste, e não dá para adivinhar retroativamente quais saíram do
-- console; inventar um critério agora seria pior que assumir a mistura. A
-- medição do piloto é por janela de tempo, e começa depois daqui.

-- ---------------------------------------------------------------------------
-- 2 · O relógio do WhatsApp é a duração do áudio.
--
-- Ela é medida no aparelho de quem falou, no instante em que falou, e chega
-- junto com a mensagem. É o análogo honesto do cronômetro do aplicativo:
--
--   aplicativo → tela abre ......... toque em Registrar
--   whatsapp   → botão pressionado .. botão solto
--
-- Os dois deixam de fora o caminho até ali (achar o produtor na fila, achar a
-- conversa), e por isso são comparáveis entre si. Nenhum dos dois é o tempo da
-- VISITA — é o tempo do REGISTRO, que é o que a hipótese afirma.
--
-- Texto e imagem não têm duração, e ficam nulos: melhor uma lacuna honesta que
-- um número inventado para preencher coluna.
-- ---------------------------------------------------------------------------
alter table mensagem_whatsapp add column duracao_seg integer
  check (duracao_seg is null or duracao_seg >= 0);

comment on column mensagem_whatsapp.duracao_seg is
  'Segundos de áudio, como o WhatsApp informou. Só para tipo = audio. É a '
  'medição da H1 no canal do WhatsApp — e ela vem do aparelho de quem gravou, '
  'não de quem validou depois na mesa.';

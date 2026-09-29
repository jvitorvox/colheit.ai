# Piloto da H1 — o roteiro de campo

A H1 diz: **o consultor registra a visita se for rápido o bastante — mediana
abaixo de 60 segundos.** Sem isso não há dado, e sem dado não há produto. É a
hipótese que mata o projeto sozinha, e por isso é a única que não dá para
resolver escrevendo código.

Este arquivo é o que sobra para uma pessoa fazer. O sistema já mede sozinho; o
que ele não faz é ir à lavoura.

---

## Antes de sair

- [ ] Um consultor de verdade, com carteira de verdade, indo a campo num dia
      normal de trabalho. Não um colega testando no estacionamento: o que se
      mede é sol na tela, luva, pressa e sinal ruim.
- [ ] O aplicativo instalado **como aplicativo** (`/consultor` → adicionar à
      tela de início), não uma aba de navegador. A aba muda o tempo de abrir.
- [ ] A carteira dele montada na aba **Equipe → Quem atende**. Sem carteira a
      fila vem vazia e não há o que registrar.
- [ ] Um canal de WhatsApp pareado, **se** o áudio for entrar na comparação.
      Sem ele o piloto mede um canal só — o que ainda responde à H1, mas não
      responde qual canal é o de captura.
- [ ] **Não** contar a hipótese para ele. "Queremos ver se dá para registrar
      rápido" faz a pessoa correr, e o número que sai mede a explicação, não o
      produto.

## O que dizer

> Use como você usaria num dia normal. Registre o que achar que vale registrar.
> Se for chato, pule — é para eu ver onde trava.

E nada além disso. Em particular, não peça para ele registrar todas as visitas:
**a taxa de registro é metade do resultado**. Um consultor que registra 3 de 10
visitas em 40 segundos não confirma a H1 — ele mostra que o atrito está em
outro lugar.

## Quantas

O sistema não dá veredito abaixo de **20 medições**, porque mediana de três tem
a mesma cara de mediana de trezentas. Vinte visitas registradas é cerca de uma
semana de um consultor ativo. Duas semanas é melhor: a primeira mede o
aprendizado do aplicativo, a segunda mede o aplicativo.

## O que ler depois

**Console → Visitas**, no alto da tela.

| O que aparece | O que quer dizer |
|---|---|
| **Formulário no app** | mediana de tela aberta → toque em Registrar, no celular dele |
| **Áudio no WhatsApp** | mediana da duração do áudio que ele gravou |
| **amostra curta** | ainda não há 20 medições; não decida nada |
| **Por consultor** | a mediana de cada um. É aqui que se lê um piloto |
| linha do console | visitas digitadas na mesa, **fora da conta** |

Mediana abaixo de 60 s confirma; acima de 90 s mata; no meio é faixa cinzenta e
pede mais uma semana.

## O que o número NÃO é

- **Não é o tempo da visita.** É o tempo do registro. A visita leva meia hora;
  a hipótese é sobre o que vem depois dela.
- **Não é auditado.** O relógio vem do aparelho do consultor. Serve para ver
  tendência e comparar canais — nunca para cobrar ninguém, e dizer isso a ele
  é parte do protocolo.
- **Não cobre o caminho até a tela.** O cronômetro do aplicativo começa quando
  a tela de visita abre; a duração do áudio começa quando ele aperta o botão.
  Os dois deixam de fora achar o produtor na fila ou achar a conversa — e é por
  isso que são comparáveis entre si.
- **Não inclui o envio.** Para no toque em Registrar, não quando a rede
  responde. Misturar sinal de fazenda com atrito de formulário mediria a
  operadora.

## As perguntas que o número não responde

Anote à mão, porque nenhuma delas cabe num percentil:

1. Quantas visitas ele fez e **não** registrou? (pergunte no fim do dia)
2. Onde ele parou e pensou? Estádio? Estande? A foto?
3. Ele preferiu o áudio? Por quê — pressa, ou porque digitar de luva não dá?
4. Alguma vez o aplicativo perdeu algo, ou pareceu ter perdido?

Se a mediana confirmar e a resposta 1 for "metade", a H1 não foi confirmada.

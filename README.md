# colheit.ai

CRM de campo e portal do produtor para a cadeia de insumos agrícolas — indústria,
distribuidor/revenda, consultor técnico e agricultor.

O desenho do produto (problema, personas, concorrentes, arquitetura e o que ainda
está em aberto) vive fora do código, no documento de desenho.

## Subir

```bash
cp .env.example .env      # ajuste as senhas
docker compose up -d --build
docker compose exec api npm --prefix api run migrar
```

API em `http://localhost:7011` — `/saude` responde `{"ok":true}`.

## Testar o isolamento

```bash
docker compose exec api npm --prefix api run teste
```

## A regra que sustenta tudo

Isolamento **no banco**, não na aplicação. Dois papéis de PostgreSQL:

| Papel | Quem é | Row-level security |
|---|---|---|
| `colheitai_owner` | migração, job, carga | passa por cima |
| `colheitai_app` | requisição HTTP | **obedece sempre** |

A aplicação obedece porque **não é dona de nenhuma tabela** — no PostgreSQL o dono
ignora RLS por padrão. Sem essa separação, RLS é decoração.

O tenant entra no contexto por transação (`app.tenant_id`), e as rotas não precisam
saber que existe multi-tenancy. Um `WHERE` esquecido não vaza dado de outra empresa.

### Toda tabela de negócio nova

```sql
create table minha_tabela (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  ...
);
create index on minha_tabela (tenant_id);
select app.aplicar_isolamento('minha_tabela');   -- não esquecer
```

E o teste de isolamento roda no CI a cada migração nova — não é conferência manual.

### Coluna `date` volta como texto

`pg.types.setTypeParser(1082, v => v)` em `db.js`. Sem isso, `plantado_em` de
12/10 virava `2026-10-12T00:00:00.000Z` no JSON e o navegador em Cuiabá (UTC-4)
desenhava **11/10** — um dia antes, em toda data do sistema: plantio, colheita,
vencimento de nota, vigência de preço. Errado para todo usuário brasileiro, e
silencioso, porque a data está quase certa.

Dia sem hora não tem fuso: não é um instante, é uma casa no calendário. O `dia()`
das telas monta pelas partes quando recebe `2026-10-12`, e só converte pelo fuso
o que traz hora. Há teste para os dois lados.

## Estrutura

```
db/init/          papéis de banco, uma vez na criação do volume
db/migrations/    versionadas, aplicadas em ordem, uma vez cada
api/src/          db.js (dois pools), migrar.js, server.js
test/             isolamento entre tenants
```

## Identidade do produtor

Chave sintética, documentos como tabela, **identidade global e relação por tenant**.

CPF não é chave primária porque o mesmo produtor opera sob CPF, CNPJ e inscrição
estadual — com CPF como chave ele viraria N registros e a porta única quebraria no
caso que ela existe para resolver. Somam-se: o consultor cadastra em campo sem o
documento em mãos, e CPF como chave se espalharia por toda FK, log e URL.

| Tabela | Escopo | O que guarda |
|---|---|---|
| `produtor` | global | identidade — é o mesmo João para todas as revendas |
| `produtor_documento` | global | CPF, CNPJ, IE. PK em (tipo, valor): um documento, um dono |
| `produtor_vinculo` | **por tenant** | a relação comercial. Tudo comercial pendura aqui |

`produtor` é a exceção à regra do tenant_id, e a política é o preço: enxerga quem
tem vínculo, não quem tem a coluna.

```sql
-- porta única: mesmo CPF por outra revenda devolve o MESMO produtor
select app.vincular_produtor("João", '[{"tipo":"cpf","valor":"12345678901"}]');
```

A revenda que chega depois só ganha um vínculo — nunca descobre que o registro já
existia. Cadastro sem documento é aceito (é o caso do campo), o que produz duplicata
temporária: `app.fundir_produtor()` resolve, e **ninguém é apagado** — o perdedor
aponta para o vencedor e o histórico continua alcançável.

## Duas dimensões de isolamento

| | Pergunta | Onde |
|---|---|---|
| tenant | de qual empresa é o dado | `app.tenant_id` |
| carteira | qual consultor pode atuar sobre aquele produtor | `app.usuario_id` |

Gestor enxerga a empresa inteira; consultor, só a carteira. Sem usuário no contexto
é job e integração — rodam no tenant, sem pessoa por trás. Quem cadastra em campo
entra na própria carteira no mesmo ato, senão perderia de vista o que acabou de criar.

## Terra

`propriedade` não tem coluna de dono. Tem `produtor_propriedade` com papel
(proprietário, arrendatário, comodatário) e período — porque arrendamento é a regra,
e o dono da terra também é cliente. O CAR é chave natural do **imóvel**, nunca do
produtor, e é opcional: é autodeclarado e uma fazenda pode abranger mais de um.

## Módulo cadastro

Primeiro módulo com camada de API. A estrutura é a regra da seção 13 do desenho —
`rota -> service -> repository`, **o SQL vive só no repository**, e nenhum módulo
importa o repository de outro.

```
POST   /cadastro/produtores                      cadastra ou reconhece (porta única)
GET    /cadastro/produtores                      a carteira que o contexto permite ver
POST   /cadastro/produtores/:id/documentos       acrescenta CPF, CNPJ ou IE
POST   /cadastro/produtores/fundir               resolve duplicata, sem apagar ninguém
POST   /cadastro/propriedades                    cria a terra junto com quem a opera
POST   /cadastro/propriedades/:id/operadores     arrendatário entra como segundo papel
PATCH  /cadastro/operadores/:id/encerrar         fecha o período, mantém o histórico
POST   /cadastro/propriedades/:id/talhoes        talhão
POST   /cadastro/carteira                        autoriza consultor sobre um produtor
```

**Documento é validado com dígito verificador**, não só formato: erro de digitação é
de onde vem a maior parte das duplicatas, e o banco só garante que são dígitos.
Inscrição estadual fica no formato — a regra varia por estado.

## Autenticação

Duas identidades, de formatos diferentes — e é a cadeia que pede isso.

| | Como entra | Sessão | Vê |
|---|---|---|---|
| `usuario` (gestor, consultor) | e-mail e senha | 12 h | o tenant dele |
| `produtor` | telefone e código de 6 dígitos | 30 dias | o que é dele, em **todas** as revendas |

Senha no produtor seria atrito na ponta de que a adoção inteira depende, e o canal
já existe: o código é o mesmo vínculo por código do WhatsApp, e o convite sai de
quem tem vínculo — no contrato. É o gancho que a H2 mede.

```
POST /auth/login                    e-mail e senha
POST /auth/produtor/codigo          pede o código (responde igual para telefone conhecido ou não)
POST /auth/produtor/entrar          telefone + código
GET  /auth/eu                       quem sou eu, nos dois casos
POST /auth/convites                 convida produtor (exige vínculo)
POST /auth/usuarios/:id/senha       só gestor, e só da própria empresa
```

### O que o módulo protege

- **Resposta uniforme.** E-mail inexistente, usuário sem senha e senha errada dão a
  mesma resposta — distinguir entregaria quais e-mails existem na plataforma.
- **Tempo uniforme.** Conta sem senha gasta o mesmo trabalho de scrypt de uma
  conferência real; sem isso o relógio entregaria o que a mensagem esconde.
- **Freio de força bruta** por e-mail ou telefone: cinco falhas bloqueiam 15 minutos,
  dez bloqueiam uma hora. A falha é **gravada fora da exceção** — lançar de dentro da
  transação provocaria rollback e o contador zeraria sozinho.
- **Código de uso único**, com validade de 10 minutos, guardado só como hash, e pedir
  um novo invalida o anterior.
- **HS256 fixado na verificação.** Aceitar o algoritmo que vem no próprio token é como
  se abre a porta para `alg: none`.

### Os dois eixos de contexto

`comContexto()` põe `app.tenant_id` + `app.usuario_id` **ou** `app.produtor_id` — nunca
os dois. As políticas do produtor (migração 011) são permissivas e se somam às de
tenant: quando um eixo está preenchido, o outro é nulo e as políticas dele não casam.

A sessão do portal é de **leitura** no núcleo de cadastro, e não entra em `/cadastro`.

## Módulo pedidos — as dez etapas

O coração do produto. A referência é acompanhar uma entrega de e-commerce: hoje o
pedido some depois do "fechado" e o agricultor só descobre o andamento se perguntar.

| | | avisa | | | | avisa |
|---|---|---|---|---|---|---|
| 1 | Negociação | | | 6 | Transporte | ✓ |
| 2 | Pedido | ✓ | | 7 | Entrega | ✓ |
| 3 | Crédito | ✓ | | 8 | Plantio | |
| 4 | Faturamento | ✓ | | 9 | Acompanhamento | ✓ |
| 5 | Expedição | | | 10 | Resultado | |

```
GET   /pedidos                      a empresa vê a carteira; o produtor vê os dele
GET   /pedidos/etapas               as dez, com quem faz e quem avisa
GET   /pedidos/:id                  com itens, nota e histórico completo
POST  /pedidos                      nasce na etapa 1, com o território carimbado
POST  /pedidos/:id/avancar          uma etapa, nunca pulando
POST  /pedidos/:id/retroceder       exige motivo, fica marcado no histórico
POST  /pedidos/:id/cancelar         exige motivo
PATCH /pedidos/:id/credito          pendente · aprovado · recusado
POST  /pedidos/:id/nota             a nota, que é o motor da captura
POST  /pedidos/:id/nota/pago        registra o pagamento
GET   /pedidos/avisos               fila de notificação; quem entrega é outro módulo
GET   /pedidos/gargalo              dias parado por etapa — só empresa
GET   /pedidos/:id/preparo          a lista do Dia Zero
PUT   /pedidos/:id/preparo/:item    marca ou desmarca — só o produtor do pedido
```

### Três regras que não são burocracia

**A etapa 4 exige a nota.** Marcar faturado sem o documento deixaria o dado entrar
pela metade — e a nota *é* o sell-out. A regra deixou de ser combinada e virou
estrutural.

**Avança uma de cada vez.** Pular seria cômodo e destrói a promessa: a régua do
agricultor é ver o pedido andar, e pedido que salta de 2 para 7 não conta história.

**Retroceder exige motivo e fica marcado.** A realidade volta — carga recusada na
porteira, entrega que não foi. Apagar o passo em falso seria perder o que a operação
precisa aprender.

### O carimbo do território

`pedido.franqueado_id` e `pedido.municipio` são gravados na criação, a partir do
município da terra, e **nunca recalculados**. Redesenhar um território depois
reescreveria o passado e vazaria histórico de um franqueado para outro.

É por esse carimbo que o franqueado enxerga a venda que a distribuidora fez com
produto dele — visibilidade descendente, **e só de leitura**: quem opera a venda é
quem a altera.

## Módulo push

É o push do PWA que cumpre o "chega sem abrir o app" — custo zero por mensagem,
sem intermediário e sem template. O WhatsApp continua sem disparar nada: ele só
recebe o que vem do campo e responde quando perguntam.

```
GET    /push/chave-publica    a chave VAPID, sem sessão (o navegador precisa antes)
POST   /push/assinaturas      registra o navegador
DELETE /push/assinaturas      remove pelo endpoint
GET    /push/assinaturas      as minhas
```

O envio não é rota. `npm run despachar` drena a fila com o papel **dono**, porque
ela atravessa tenants — é da plataforma, não de uma empresa. Mesmo motivo pelo qual
migração e job usam o dono.

### O que o despachante decide

| Desfecho | O que faz |
|---|---|
| entregou em ao menos um navegador | marca enviada — quem tem celular e desktop não precisa dos dois de pé |
| `404` ou `410` | apaga a assinatura: é o serviço dizendo que aquele navegador não existe mais |
| falha passageira | adia; na terceira tentativa descarta com motivo |
| produtor sem assinatura | descarta na hora — "a carga saiu" não vale três dias depois, e a informação continua no histórico do pedido |

`assinatura_push.agente` guarda o user agent de propósito: é assim que a ressalva do
iPhone — onde o push exige adicionar o portal à tela de início — vira número em vez
de suposição.

### O contrato do cliente

O PWA ainda não existe. Quando existir, o service worker precisa de:

```js
const { chavePublica } = await (await fetch('/push/chave-publica')).json();
const sub = await registro.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: chavePublica,
});
await fetch('/push/assinaturas', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ ...sub.toJSON(), agente: navigator.userAgent }),
});
```

A carga que chega no `push` é `{ titulo, texto, pedidoId, etapa }`.

## Módulo captura — WhatsApp

O hábito já existe: produtor e RTV trocam foto de talhão e áudio sobre a lavoura
hoje, e isso morre numa conversa pessoal. O módulo não cria comportamento novo —
dá destino ao que já acontece. É a arquitetura do RDO do Construtivo, com o
consultor no lugar do engenheiro.

```
POST /captura/mensagens          o gateway entrega o que chegou
GET  /captura/saidas             o que ele deve enviar
POST /captura/saidas/:id/enviada
GET  /captura/relatos            a fila do consultor (e o produtor vê o que mandou)
POST /captura/relatos/:id/validar
POST /captura/relatos/:id/descartar   exige motivo
POST /captura/canal              o número da empresa
```

### "Nunca dispara" virou restrição, não disciplina

`mensagem_whatsapp` tem `check (direcao = 'entrada' or responde_a is not null)`.
Saída só existe atrelada a uma entrada — **o banco recusa uma mensagem solta**.
A regra deixou de depender de quem escreve o gateway, e há teste que tenta
inserir promoção direto no banco e falha.

Um número por tenant, como no Construtivo: se um cair, o canal para de um
cliente, não da plataforma.

### Duas perguntas que o canal sabe responder

| O que ele escreve | O que volta |
|---|---|
| "cadê minha carga?", "chegou a nota?" | os pedidos em andamento, com a etapa de cada um |
| "quanto rendeu a colheita?", "como foi a safra?" | o fechamento da safra em quatro linhas |
| qualquer outra coisa | vira **relato de campo**, que é o destino certo do resto |

```
Safra 26/27: 66,3 sc/ha na média, 2.100 ha colhidos (2 de 3 talhões).
+18,6% em relação à safra 25/26.
Melhor: Gleba 2, 71,2 sc/ha.
Média ponderada pela área colhida.
```

Quatro linhas porque mensagem longa não se lê no trator. Mas **a base do número
vai junto**: é no WhatsApp que ela mais importa, porque a mensagem é encaminhada
e vira captura de tela sem nenhum contexto em volta.

A safra é testada antes do pedido: "quanto rendeu o pedido" bate nas duas listas,
e quem escreve "rendeu" quer produtividade — quem quer o pedido escreve "cadê".

É casamento de palavra, não entendimento, e **continua sendo mesmo depois que o
extrator de IA ligar**: pergunta respondida por regra é barata, previsível e não
manda o texto do produtor para provedor nenhum.

Nada disso dispara: a resposta só existe porque ele perguntou, e o banco recusa
mensagem solta. Há teste que envelhece as entradas em 48 horas e confere que a
fila de saída não cresce sozinha.

### O consultor pergunta pelo nome do produtor

Ele atende muitos: o agregado da carteira diz menos que o nome que ele vai
visitar daqui a dez minutos.

```
> como foi a safra do Cesar?
José Cesar Sabo — safra 26/27: 68,4 sc/ha na média, 1.800 ha colhidos (1 de 1).
+20% em relação à safra 25/26.
+15,3% em relação a 6 outros produtores de Sorriso que estão aqui (59,3 sc/ha).
Melhor: Gleba 1, 68,4 sc/ha.
Média ponderada pela área colhida.
```

**A vizinhança vem na mesma mensagem**, porque é o que ele vai dizer na porteira
daqui a dez minutos — e uma segunda ida seria uma segunda pergunta.

A régua muda de produtor para produtor, porque cada um é excluído da própria:
perguntar pelo Cesar dá região de 59,3, perguntar pela Marli dá 62,8. Isso **não
revela nada novo** — a diferença entre as duas consultas mistura as lavouras do
Cesar e da Marli, e ele já vê as duas. Excluir só quem se consulta é o que
mantém a régua honesta sem virar alavanca.

**Sem nome, a resposta depende do que o tenant é dono.** Rede, território ou
municípios — nas três, a comparação já vem resolvida numa linha cada, e o que
não cabe numa mensagem é lista longa, não lista.

### Quem tem rede recebe a rede

A exceção à regra acima. A franqueadora tem poucos franqueados, e a comparação
de cada um já vem resolvida numa linha — cabe numa mensagem, ao contrário de uma
carteira espalhada por municípios.

```
> como foi a safra?
Safra 26/27, a rede:
FS Mato Grosso: 68,6 sc/ha, +6,4% no território dele.
FS Goiás: 74,2 sc/ha, +4,1% no território dele.
FS Bahia: 48,1 sc/ha, -9,8% no território dele.
1 sem comparação ainda — território com pouca gente aqui.
Cada um contra o próprio território, que inclui quem não comprou da rede.
```

Ordenada **pela variação, não pela produtividade**: numa mensagem curta o que
interessa é quem está fora da própria régua, para os dois lados. Cinco linhas é o
teto; acima disso a mensagem diz quantos ficaram e manda para o painel.

Franqueado cujo território ainda não tem cinco produtores **é contado, não
sumido** — o que falta ali é vizinhança, não desempenho, e some-lo confundiria as
duas coisas.

A condição é **ter rede**, não ser de um tipo: `redeContraRegiao` devolve vazio
para quem não tem, e a revenda cai no resumo de sempre. Há teste fazendo a mesma
pergunta pelos dois telefones.

### E quem tem território recebe o território

```
> como foi a safra?
Safra 26/27: 69,4 sc/ha na média, 3.400 ha colhidos (3 de 3 talhões).
+6,3% em relação ao seu território inteiro (65,3 sc/ha).
São 8 produtores em 2 municípios, incluindo quem não comprou de você.
Melhor: Gleba 1, 71,5 sc/ha.
Média ponderada pela área colhida.
```

A franquia é exclusiva por município, então a pergunta do franqueado **não** é
"como foi a lavoura dos meus clientes" — é *quanto do que plantaram aqui passou
pela marca, e como se compara com o que não passou*.

O denominador é o **território**, não o que ele enxerga: ele vê a lavoura que
desceu dos pedidos dele, e o território tem muito mais. Há teste comparando os
dois números.

`incluindo quem não comprou de você` não é enfeite: sem isso ele leria a média
como se fosse a dos próprios clientes, que é justamente o **outro lado** da
comparação.

Duas linhas curtas, e não uma de cento e trinta caracteres — no celular a longa
quebra em três e a ressalva fica órfã no fim.

Mesma disciplina das outras: a condição é `territorio` ter linha apontando para
o tenant. Revenda, distribuidora e franqueadora não têm, e a função no banco
simplesmente não devolve nada.

### As quatro ordens da mesma pergunta

```
> como foi a safra?          [distribuidora]
Safra 26/27, por município:
Sorriso/MT: 69,5 sc/ha, +9,1% na região.
Água Boa/MT: 63,5 sc/ha, +1,6% no estado (MT).
Sinop/MT: 53,2 sc/ha, -12,9% na região.
A região inclui a sua carteira, e só aparece com cinco produtores.
```

"Como foi a safra?" tem **cinco** respostas para a sessão de empresa, nesta
ordem:

| Se o texto traz | Resposta |
|---|---|
| um **nome de produtor** | a lavoura dele, com a vizinhança dele |
| nada, e o tenant tem **rede** | cada franqueado contra o território dele |
| nada, e o tenant tem **território** | o que desceu dele contra o território inteiro |
| nada, e há **município com região** | município a município, com a região de cada um |
| nada disso | o resumo da carteira, sem comparação |

**Nenhuma dessas condições olha o tipo do tenant.** Todas olham se o dado existe
— é o que mantém as cinco num arquivo só, sem uma segunda regra de visibilidade
para manter em dia com a política. Há teste conferindo que um nome no texto ganha
até de quem tem território.

As duas listas — rede e municípios — ordenam **pela variação e não pela
produtividade**: numa mensagem curta o que interessa é quem está fora da própria
régua, para os dois lados. E o município que subiu para o estado **diz que
subiu**, senão "+1,6%" seria lido como se fosse contra aquela cidade.

Três desfechos, porque é o que a realidade tem: **um nome** responde por ele,
**mais de um** devolve a lista e pede o nome mais completo, e **nenhum** vale a
carteira inteira. Chutar entre dois Sabo seria responder com o número do vizinho.

A busca **não sabe o que é carteira** — quem limita é a política, e ela limita.
Há teste em que o consultor pergunta pelo "Sabo da Concorrente" e a resposta não
o menciona.

Palavras de pergunta entram numa lista de ruído: sem ela, "como foi a colheita?"
procuraria um produtor chamado "Fazenda Boa Colheita" e o encontraria. E **só o
consultor** procura nome: o produtor fala de uma lavoura só — a dele —, e
procurar nome no texto dele só criaria chance de errar.

> ⚠️ **A regra não tem memória da mensagem anterior.**
>
> "como foi a safra do Sabo?" funciona; "e a da Marli?" logo em seguida **não** —
> não há palavra de safra nela, então vira relato de campo, sem resposta. É o
> preço de não manter estado de conversa, e o contorno é escrever "e a safra da
> Marli?". Fica registrado porque é o tipo de coisa que parece defeito quando se
> usa pela primeira vez.

### E o produtor pergunta pelo talhão

Mesmo gesto, outro eixo: o consultor nomeia **produtor**, o produtor nomeia
**talhão**. Ele tem uma lavoura só; o que varia dentro dela é a gleba, e a
pergunta específica precisava de resposta específica.

```
> e a Gleba 2, quanto rendeu?
Gleba 2: 71,2 sc/ha na safra 26/27, em 900 ha de FS560.
+10,9% em relação à média da sua lavoura (64,2 sc/ha, ponderada pela área).

> quanto rendeu o pivô?
Pivô do fundo: 52,4 sc/ha na safra 26/27, em 500 ha de FS560.
-18,4% em relação à média da sua lavoura (64,2 sc/ha, ponderada pela área).
```

**A comparação é com a própria lavoura, não com a região.** A da região
precisaria do número do vizinho — que é dele, não nosso para repassar.

O nome é procurado nas **duas direções**, porque as duas acontecem:

| O que ele escreve | Como casa |
|---|---|
| "e a Gleba 2, ..." | o nome **inteiro** está dentro da frase |
| "quanto rendeu o pivô?" | um **pedaço** do nome "Pivô do fundo" |

E quando o nome inteiro casa, só esses valem: quem escreveu "Gleba 2" não quer a
Gleba 1, e o casamento por pedaço traria as duas — o número tem um caractere e
não entra nos termos.

Talhão plantado e ainda não colhido responde isso, e não um número. Talhão de
outro produtor não é alcançável: a busca não sabe de dono, quem limita é a
política.


### ⚠️ A extração nasce desligada, e é decisão

Áudio de produtor descrevendo a própria lavoura é o dado mais sensível que o
projeto captura, e o **plano sem-treino do provedor segue pendente** desde o
copiloto do CRM. O extrator existe e está pronto — mas nasce desligado, e o
relato fica em `aguardando_extracao`: o estado honesto de chegou, está
guardado, ninguém leu.

**A espera é reversível.** `npm run ler` passa o extrator na fila represada,
então nada do que chegou antes se perde: no dia em que o plano for fechado, a
base de campo acumulada entra de uma vez. Existe teste para isso.

Detalhes da leitura automática em [Extrator de IA](#extrator-de-ia).

### O gateway fica fora

Baileys é adaptador, não módulo. Ele se identifica por `GATEWAY_SEGREDO` — não é
usuário, não tem sessão, e atende vários canais. Sem o segredo configurado a porta
fica fechada, de propósito.

Manter o gateway fora é o que permite trocá-lo (pela API oficial, por exemplo) sem
tocar no módulo — e é o que torna tudo isto testável sem WhatsApp nenhum.

## O portal do produtor (PWA)

Servido pela própria API, em `web/`. Mesma origem resolve CORS, escopo de service
worker e sessão de uma vez só — em produção o nginx fica na frente, mas a origem
continua sendo uma.

**Sem build.** O repositório não tem empacotador e um arquivo que o navegador lê
direto é menos coisa para manter. Se um dia precisar de framework, ele entra por
escolha e não por inércia.

```
web/index.html   casca e estilo
web/app.js       telas, rotas por hash, cliente da API
web/sw.js        cache da casca e recebimento do push
web/manifest.json
```

### Cinco telas

**Entrar** — telefone e código, sem senha. **Meus pedidos** — progresso compacto por
cartão; dez etiquetas em 314px de celular ficam ilegíveis e obrigam a arrastar de
lado para ver o que ele quer saber. **Detalhe** — aí sim a faixa completa das dez
etapas, mais nota, boleto e histórico. **Minha lavoura** — a terra e os talhões.
**Caderno de campo** — o que foi plantado em cada talhão, por safra, e o que
saiu na colheita. **Visitas** — quem esteve na lavoura dele, de todas as
revendas, com as fotos do talhão.

### O Dia Zero

Entre saber que a carga saiu e ela chegar existe uma janela de dias em que o
produtor está mais ligado no aplicativo do que em qualquer outro momento do ano.
A estratégia diz que o agricultor é o centro; esta é a hora em que isso deixa de
ser frase. Aparece no detalhe do pedido, da etapa 6 à 8 — depois do plantio o
preparo já virou lavoura.

Três coisas, e nenhuma a mais.

**Há quantos dias a carga saiu.** Não há previsão de chegada, e não se inventa
uma: não temos transportadora nem rastreio, e um "chega quinta" fabricado é pior
que nada — ele organiza equipe em cima disso.

**A régua da semeadora.** `população × espaçamento ÷ 10.000` = sementes por
metro. É conversão de unidade, não agronomia — a mesma conta do verso do manual.
O que é agronomia e **não** fazemos é descontar germinação e vigor, e a tela diz
isso em vez de entregar um número com cara de final. Os dois valores ficam no
aparelho (`localStorage`): é ajuste de máquina, muda de talhão para talhão, e não
é dado nosso.

**A lista de preparo.** Cinco itens — descarga, equipe, semeadora, regulagem,
tratamento. Sete seriam completos e ninguém leria no celular.

> ⚠️ **A lista é dele. A revenda não lê.**
>
> "Ainda não tenho gente para descarregar" é problema de quem vai receber, e
> saber disso mudaria a conversa comercial. A política dá leitura e escrita só ao
> produtor do pedido; a revenda recebe a lista sempre zerada, e a escrita dela é
> recusada com 404. Se um dia a revenda precisar enxergar o preparo, que seja
> decisão tomada e **dita a ele** — não efeito colateral de onde a tabela nasceu.

É a **única escrita** que a sessão do portal faz no sistema inteiro. Em todo o
resto ela é de leitura; aqui é porque o dado é dele — ninguém além dele sabe se a
semeadora está revisada.

O texto dos itens mora no service, e o banco guarda só o **código**. Mudar a
redação de um item não pode apagar o que a pessoa já marcou, e apagaria se a
chave fosse a frase. Marcar de novo também não reescreve a hora: foi feito quando
foi feito.

### O caderno é dele, e é o que faz o app valer a pena para quem planta

A camada técnica é compartilhada com o agricultor — a política de `plantio` já
dizia isso desde a 022, e faltava a tela. Por safra, talhão a talhão: cultivar,
marca, área, população, data de plantio, **lote** (a garantia do que ele plantou)
e a produtividade quando a colheita entra.

No fim, **como cada cultivar foi na terra dele** — média, pior e melhor das
colheitas registradas. É a comparação que ele não consegue fazer sozinho, e o
motivo de o aplicativo valer a pena para quem plantou, não só para quem vendeu.

O que **não** aparece: `nossa`, a marca de que a semente saiu do nosso catálogo.
É leitura comercial, serve ao share por marca, e não diz nada a quem plantou. O
`/caderno/share` continua fechado ao portal pelo mesmo motivo.

Ele **lê e não escreve** — quem fecha o registro é o consultor, e a política já
exige sessão de empresa. O caminho dele para contribuir é o WhatsApp: foto do
saco, áudio do plantio, e o consultor valida. A tela vazia diz exatamente isso.

### O resultado da safra — e a média que engana

No topo do caderno, porque é a pergunta que ele faz primeiro: **como foi o ano**.
É o fim do laço — a semente que saiu do pedido virou saco por hectare. Para a
revenda o número volta ao funil da safra seguinte; para ele é o ano dele.

> A produtividade é **ponderada pela área colhida**, não a média dos talhões.
>
> Um talhão de 40 ha com 88 sc/ha e um de 1.800 ha com 55 não dão 71,5 — dão
> **55,7**. A média simples é a que faz o ano parecer melhor do que foi, e é
> exatamente a que sai por engano de um `avg()`. A frase viaja com o número até a
> tela, como no share por marca.

O que ainda não colheu **não dilui**: fica de fora da área colhida em vez de
entrar como zero, e o cartão diz `3 de 4 colhidos` em vez de se declarar fechado.

A comparação é com a última safra que **produziu número**, não com a
imediatamente anterior — safra plantada e ainda não colhida, ou ano pulado,
daria uma variação sobre nada. A resposta carrega qual safra foi usada, então
pular é honesto: `+14,8% em relação à safra 25/26 (58,1 sc/ha)`.

`/caderno/resultado` atende as duas sessões, como o resto do caderno: a política
decide se é a terra de um produtor ou a carteira da revenda. Não virou aba
própria porque seria a sexta em 375px, e o assunto é o mesmo do caderno — o que
entrou no talhão e o que saiu dele.

### ⚠️ O benchmark regional — o número mais fácil de vazar

"Como eu fui em relação à minha região?" é a pergunta que o produtor mais quer
responder. **Num município com dois produtores, a média da região É o número do
vizinho**: basta subtrair o próprio.

`app.benchmark_regional` é a **única função do sistema que lê através de
produtores diferentes**, e por isso está escrita para ser lida inteira:

| | |
|---|---|
| `security definer` | tem de ser — a política do portal limita o produtor à terra dele, e um benchmark que só enxerga a terra dele não é benchmark. Não há como fazer isto por política. |
| devolve só agregado | nunca uma linha, nunca um nome, nunca um id. Há teste conferindo as quatro colunas. |
| a regra mora **dentro** | chamador nenhum pode contorná-la, nem por engano nem de propósito |
| quem pergunta é **excluído** | comparar-se com um grupo que te contém é comparar-se consigo mesmo, e ainda facilita a subtração |

**O piso são cinco outros produtores.** Com três, quem conhece dois vizinhos
deduz o terceiro; com cinco, o resíduo de uma subtração continua sendo um bolo
de quatro. Está em `app.benchmark_minimo()`, e não num arquivo de configuração,
porque **afrouxá-lo tem de ser uma migração que alguém revisa**.

Município magro sobe para o estado, e a resposta **diz qual nível usou** — sem
isso ele lê "região" achando que é a cidade dele. Estado magro não inventa:
devolve nada.

```
Safra 26/27: 64,2 sc/ha na média, 2.800 ha colhidos (3 de 3 talhões).
+10,3% em relação à safra 25/26.
+5,1% em relação a 5 outros produtores de Sorriso que estão aqui (61,1 sc/ha).
Melhor: Gleba 2, 71,2 sc/ha.
Média ponderada pela área colhida.
```

**"que estão aqui"** não é enfeite: não é a média do município, é a média de
quem está no sistema. A frase viaja com o número no portal e no WhatsApp.

Quando não há gente bastante, a linha **some** — não diz "sem dados". O produtor
não precisa saber que existe uma régua que ainda não alcançou; dizer isso o
faria voltar semana que vem esperando um número que depende de quantos vizinhos
dele entraram no sistema.

**A resposta de talhão não traz a região.** "Gleba 2 rendeu tanto" se compara com
a lavoura dele; a lavoura se compara com a vizinhança. São duas réguas, e juntá-
las na mesma mensagem confundiria qual é qual.

E o produtor e o consultor, perguntando pela mesma lavoura por caminhos
diferentes, recebem **o mesmo número** — há teste comparando as duas mensagens,
porque um dos dois estaria errado na frente do outro.

⚠️ `região` e `vizinhos` **não** são palavras de pergunta. "Como foi a região?"
vira relato de campo, sem resposta. Foi escolha: um relato dizendo "a região do
pivô está boa" seria engolido como pergunta, e perder registro de campo é pior
que não responder. Ele recebe a régua na pergunta que faz de verdade — "quanto
rendeu minha colheita?".


### Ele não sabe quem consulta, mas sabe quem entrou na porteira

São coisas diferentes, e a diferença é fácil de desfazer por engano depois.
Acesso ao dado por terceiro na cadeia é a decisão da seção 08 — o produtor não é
informado. **Serviço prestado na terra dele, por gente que passou pela porteira,
é dele saber**: a tela mostra o nome do consultor, a data, o talhão, o estádio e
o que foi anotado.

O que ela **não** mostra: `duracao_seg`, que é a medição da H1 e diz respeito ao
nosso processo, não a ele; e `canal`, que é encanamento nosso.

Fazer o nome aparecer custou uma política. A 018 já dizia a intenção — "o
produtor vê quem esteve na lavoura dele" — mas `usuario` tem isolamento por
tenant, e a sessão do portal não tem tenant: o `left join` devolvia nome nulo,
**em silêncio**, e a tela mostraria "Consultor" genérico sem ninguém desconfiar.
A 027 abre exatamente a linha de quem registrou visita para aquele produtor, e a
subconsulta passa pela política de `visita` — sem função `security definer` que
devolva nome de usuário por id solto.

### Offline é leitura, e só

O service worker guarda a casca e a última resposta de cada consulta. Sem conexão o
app abre e mostra o que tinha, com uma faixa dizendo que é cópia — melhor que tela
em branco no meio do talhão. **Fila de escrita não entra aqui**: o portal é de
leitura, e sincronização offline é problema do aplicativo do consultor, que é quem
trabalha onde não há sinal.

Resposta de `/auth/` nunca é guardada. `/midia` também fica fora da lista de
consultas: a volta pelo cache desserializa a resposta como JSON, e foto não é
JSON — ela cai no ramo da casca, cache-primeiro, que é o certo porque mídia é
imutável pelo id.

⚠️ A casca é servida **cache-primeiro**. Mexeu em `app.js` ou `base.css`? Vire
`VERSAO` no `sw.js`, senão o produtor continua abrindo o portal velho para
sempre — e ninguém liga uma coisa à outra. Há teste conferindo isso.

### Cache em desenvolvimento

`express.static` serve com `max-age=0` fora de produção. Com cache, cada mudança de
tela pediria recarga forçada — e alguém perderia meia hora achando que o código não
subiu.

## O app do consultor — e a H1 no bolso

`/consultor`, instalável pelo `manifest-consultor.json`. Terceiro front-end da
mesma origem, e o único que escreve sem conexão.

Duas coisas o definem, e as duas vêm da H1: registrar uma visita tem de caber em
menos de 60 segundos, e tem de funcionar sem sinal. Se qualquer uma das duas
falhar não há dado, e sem dado não há produto.

### A visita é gravada antes de ser enviada

```
toque em Registrar
  → clienteId gerado no celular
  → gravada em IndexedDB          ← aqui o consultor já pode andar
  → POST /visitas quando houver sinal
```

Nunca se espera a rede para dizer que está feito. No meio do talhão,
"enviando..." girando é o mesmo que perder o registro. A tela volta para a fila
na hora, com o número de segundos que levou.

IndexedDB e não `localStorage`: aqui mora trabalho de campo que ainda não chegou
ao servidor, e `localStorage` é síncrono, pequeno e o primeiro a cair em
qualquer faxina do navegador.

### O reenvio é o normal, não a exceção

O rádio cai no meio do POST, a resposta não chega, e o app — que não tem como
saber se o servidor gravou — tenta de novo. **Sem uma chave que o cliente gera,
cada tentativa viraria uma visita:** o consultor passou uma vez e a mediana da H1
passaria a contar três registros de dez segundos. O número que decide o produto,
envenenado justamente pela peça que existe para alimentá-lo.

Daí `visita.cliente_id`, gerado no celular **antes** da primeira tentativa e
repetido em todas. O servidor grava com
`on conflict (tenant_id, cliente_id) do nothing` e devolve a visita que já
existe, com `repetida: true`.

`on conflict` e não tentar-e-tratar-o-erro: dentro de uma transação, uma violação
de unicidade aborta tudo, e a consulta seguinte falharia sobre o que já foi
desfeito. Assim, o reenvio e a corrida entre dois reenvios simultâneos se
resolvem de uma vez — há teste com quatro ao mesmo tempo.

| | Por quê |
|---|---|
| a chave é por tenant | chave que o cliente gera não pode servir de sonda para descobrir o que outra empresa gravou |
| o reenvio **não** reescreve | vale o que foi medido na primeira gravação |
| sem `clienteId`, nada muda | é o caminho do console e do relato de WhatsApp |
| duas visitas no mesmo produtor seguem sendo duas | o freio é o reenvio, não o produtor: passar duas vezes é trabalho de verdade |

### O que o formulário não pede

Estádio é **toque**, nunca digitado — 16 chips de VE a R8. Teclado de celular no
meio da lavoura é o atrito que mata a H1 sozinho. Tocar de novo desmarca: errar o
chip e não poder voltar atrás faria o consultor gravar um estádio errado só para
sair da tela.

O cronômetro para no toque em Registrar, **não** quando a rede responde: a
duração é do registro, que é o que a hipótese afirma. Medir o envio junto
misturaria sinal de celular com atrito de formulário.

A hora da visita sai do relógio do celular. Visitada às seis da manhã e
sincronizada às seis da tarde é uma visita da manhã.

### Nada fica invisível

| Situação | O que o consultor vê |
|---|---|
| sem sinal | quantas visitas estão guardadas, e que saem sozinhas |
| sessão venceu no campo | as visitas ficam na fila; entrar de novo as libera — 401 **não** descarta trabalho |
| servidor recusou (400) | a visita fica marcada na Fila de saída, com o motivo e um botão de descartar; voltar para a fila seria laço infinito |
| navegador sem IndexedDB | aviso de que sem sinal o registro se perde |
| service worker não registrou | aviso de que registrar sem sinal funciona, mas só com o app já aberto |

Esse último existe porque falha silenciosa ali seria a pior de todas: o app
prometeria trabalhar sem sinal e só quebraria no talhão, onde não há como
descobrir por quê.

A fila do dia vem do cache quando não há rede, e a tela **diz** que é lista
guardada. Fila de ontem passando por fila de hoje é pior que fila nenhuma: o
consultor dirige até um produtor que o colega já visitou.

### A foto do talhão

É a única parte do registro que o texto não substitui. "Estande irregular na
bordadura" e a foto da bordadura irregular não são o mesmo dado — e é a foto que
o agrônomo da revenda consegue julgar sem ter ido.

```
câmera → encolhida no aparelho → fila local (com a visita)
       → POST /midia  (uma vez, foto a foto)
       → POST /visitas com os identificadores
```

**Encolher no aparelho é o que faz a coisa existir.** Foto de celular tem 3 a
8 MB; a 1600px e qualidade 0,72 ela cai para ~250 KB e continua dando para ver
lagarta na folha. Numa conexão de fazenda, é a diferença entre subir e não subir.
`imageOrientation: 'from-image'` não é detalhe: sem isso a foto tirada de pé
chega deitada, porque o celular grava a rotação no EXIF em vez de girar os pixels.

**O binário sobe uma vez.** O progresso é gravado foto a foto de volta na fila
local, então cair o sinal na terceira não faz a próxima tentativa remandar as
duas primeiras. E o reenvio da visita carrega identificadores, não arquivos.

**A foto sobe sem dono.** `POST /midia` não aceita `produtorId`: quem carimba é o
vínculo com a visita, onde o produtor já foi conferido contra a carteira. Aceitar
na subida deixaria pendurar foto na lavoura de um produtor alheio. O carimbo só
preenche o que está vazio — remarcar moveria a foto de um produtor para outro, e
o primeiro deixaria de ver no portal o que já via.

É esse carimbo que faz a foto aparecer para o produtor: a lavoura é dele, e a
foto dela também. Vale a mesma régua da visita — o que o consultor anota como
avaliação comercial não mora aqui.

**Tudo é idempotente, e o vínculo roda também no reenvio.** Se o sinal caiu entre
gravar a visita e pendurar as fotos, a segunda tentativa é a única chance de
completar: `visita.cliente_id` devolve a mesma visita, a chave primária de
`visita_midia` absorve o vínculo repetido, e o sha256 por tenant reaproveita o
binário. Há teste para exatamente esse meio-caminho.

Seis fotos por visita, no cliente e no servidor. Mais que isso é álbum, e cada
foto é uma subida a mais numa conexão que já está ruim.

As fotos aparecem em **Visitas**, no console, e na tela de **Visitas** do portal
do produtor — foto que ninguém vê não valia ter sido tirada.

### A safra na mão de quem está no campo

Terceira aba do app. Duas coisas num lugar só, e as duas vêm da mesma pergunta:
**o que saiu de cada talhão**.

**Antes de bater na porteira**, o número que abre a conversa: "José fez 67,6 sc/ha
nesta safra, 18% acima da passada". A carteira inteira na entrada, o produtor
escolhido depois.

**Depois que a colhedora passa**, o talhão que falta fechar vira botão. É o
consultor quem está lá quando o número existe — e até agora só o console
registrava colheita.

A aba fica **fora do caminho da visita**, de propósito: a tela de registro é
medida pela H1 e tem de caber em 60 segundos. Enfiar o histórico da safra nela
seria derrubar a hipótese para ganhar contexto.

### E a vizinhança, que é o que abre a conversa

```
Safra 26/27                                            fechada
68,4 sc/ha
+16,5% sobre a safra 25/26
+12,9% em relação a 6 outros produtores de Sorriso que estão aqui
Média de 6 outros produtores, ponderada pela área — sem nome e
sem número individual.
```

"O senhor fez treze por cento acima da região" diz mais do que qualquer número
sozinho — e a frase da base vai junto porque **é ele quem vai repetir o número ao
produtor**. Sem ela, "a região" vira "o município", que não é.

A região chega na **mesma ida** que a safra, e fica guardada com ela: perder o
sinal no meio do talhão não apaga o número que ele levou até lá.

> **Aqui a exclusão é do produtor consultado, não da carteira dele.**
>
> No painel do gestor a região inclui a carteira, porque ele a controla e a
> exclusão viraria alavanca de diferenciação. O consultor não controla quem mais
> planta em Sorriso: a exclusão é só o produtor da tela, que é a mesma regra do
> portal. Mexer na carteira não move a régua de ninguém — há teste para isso.

### A fila de saída passou a carregar dois tipos

Uma fila só, ordenada por tempo: visita e colheita do mesmo dia saem na ordem em
que aconteceram. O que muda por tipo é só a porta.

E os dois são idempotentes, que é o que torna o reenvio seguro:

| | Como o reenvio não duplica |
|---|---|
| visita | `cliente_id` gerado no celular, `on conflict do nothing` |
| colheita | uma por plantio (`plantio_id unique`), e o insert é upsert |

A colheita **não precisa de chave de cliente**: reenviar grava o mesmo número no
mesmo talhão. A contrapartida é que ela sobrescreve — se o gestor corrigir o
número enquanto um reenvio antigo ainda está na fila, o reenvio vence. A fila
drena em minutos, e o upsert é o comportamento que o caderno já tinha para
replantio e correção.

Perder o sinal **não apaga a tela**: a última leitura da safra fica na memória da
página, e o aviso diz que os números são da última vez que houve sinal. Sem isso,
cortar a conexão no meio do talhão limpava justamente o número que ele tinha
levado até lá.

### O que ficou de fora, e por quê

**Background Sync.** O reenvio mora na página, não no service worker. Levá-lo
para lá significaria guardar o token de sessão onde o botão Sair não alcança. O
consultor volta ao sinal com o app aberto ou reabre o app, e o escoamento roda
nos dois casos — além de no evento `online`.

**Áudio.** Continua só pelo WhatsApp, onde já tem armazenamento, política e
extração. Gravar áudio aqui seria uma segunda porta para o mesmo dado, e o
formulário se afastaria dos 60 segundos sem ganhar nada.

Cada app tem seu service worker: `sw.js` para o portal (leitura e push),
`consultor-sw.js` para o campo (casca e fila do dia). Dois mexendo no mesmo
cache seria um limpando o que o outro acabou de guardar.

## A área da empresa

O console de gestor e consultor, em `/empresa`. Mesma origem, mesmos tokens
(`web/base.css`), layout diferente: o portal é de bolso, este é de mesa.

| Aba | O que faz |
|---|---|
| **Painel** | o painel do gestor — ver [abaixo](#o-painel-do-gestor) |
| **Pedidos** | lista, abre, avança, retrocede com motivo, muda crédito, lança nota |
| **Carteira** | produtores, novo cadastro e o convite de acesso |
| **Do campo** | o que chegou pelo WhatsApp, para o consultor validar ou descartar |
| **Equipe** | usuários da empresa, senha e quem cada consultor atende |

A regra da etapa 4 aparece aqui como ela é: o cartão da nota diz que o
faturamento não passa sem ela, e tentar avançar devolve a mensagem da API.

### A equipe, e o que ficou fora do console

Até esta tela, usuário e carteira se criavam com `insert` direto no banco — todo
seed e todo teste desta base fez assim, e passou despercebido porque o caminho
do dado sempre existiu. **Ninguém subia um cliente sem um DBA ao lado.**

| Decisão | Por quê |
|---|---|
| usuário nasce **sem senha** | gerar uma e mostrá-la seria pôr credencial numa tela que alguém fotografa; a linha fica âmbar até alguém abrir o acesso |
| **desativa**, não apaga | visita, pedido e relato apontam para a pessoa — apagar o autor reescreveria a história de quem esteve na lavoura |
| o **e-mail não muda** | é a chave de acesso; trocá-la é criar outro usuário |
| o último **gestor ativo** não sai nem vira consultor | senão a empresa fica sem quem crie usuário, e a saída seria o psql de novo |
| a ação da linha chama **"Quem atende"** | a aba lateral já se chama "Carteira" e é outra coisa — lá são os produtores da empresa |

**"Só gestor" saiu do JavaScript e foi para o banco.** A política de `usuario`
ganhou `with check (… and app.e_gestor())`, e `app.autorizar_consultor` — que é
`security definer` e a política não alcança — checa por dentro. Uma rota nova que
esquecesse de olhar o papel não abriria buraco; há teste que tenta o `insert`
direto com uma sessão de consultor e é recusado pela RLS.

`app.e_gestor()` **precisa** ser `security definer`: ela é usada na política de
`usuario` e lê `usuario`. Sem bypassar a política, a política chamaria a si mesma
e o Postgres recusaria por recursão. Ela não tem parâmetro — responde sobre a
sessão atual, nunca sobre um terceiro.

> **O que NÃO virou tela: criar empresa, território e rede.**
>
> Nenhum desses atos acontece dentro de um cliente. Viraram `npm run admin`, que
> roda com o papel dono fora de qualquer sessão — o mesmo lugar de `migrar` e do
> despachante de push, e sem rota que alcance.
>
> A alternativa seria inventar um **superadmin**: um papel acima dos tenants,
> com autenticação própria e uma quarta casca para manter. Isso é decisão de
> produto, não consequência técnica — e enquanto ela não for tomada, uma linha de
> comando resolve e não abre superfície nenhuma.

```bash
npm run admin -- empresa "3 Tentos" 11111111000111 distribuidor "Marina" marina@3t.com
npm run admin -- territorio Sorriso MT <id do franqueado>
npm run admin -- rede <id do franqueado> <id da franqueadora>
npm run admin -- senha marina@3t.com
npm run admin -- empresas
```

A empresa e o primeiro gestor nascem na **mesma transação** — empresa sem gestor
é empresa que ninguém abre. O que sai é um **link**, não uma senha: nem o comando
nem quem o rodou chega a saber a senha de ninguém.

Redesenhar território **não reescreve o passado**: `pedido.franqueado_id` é
carimbo da criação, e o comando diz isso na saída.

O service worker **deixa `/empresa` de fora**. É aplicação de mesa, com conexão —
guardar a casca só serviria para servir versão velha a quem trabalha o dia
inteiro nela.

### Recuperação de senha — uma peça, três portas

O produtor não aparece aqui: ele **nunca teve senha**. Telefone e código pelo
WhatsApp já são o caminho de volta dele desde o começo, e aquela porta se
recupera sozinha. O buraco era do lado da empresa — e o fundo dele era o único
gestor de um cliente esquecendo a senha, sem ninguém a quem pedir.

O que circula em todas as portas é o mesmo **bilhete de uma viagem só**: 256
bits sorteados, guardados só como hash, que servem para *escolher* uma senha e
morrem no uso. O que muda entre elas é quem prova a identidade.

| Porta | Quem prova | Prazo | Precisa de quê |
|---|---|---|---|
| `POST /auth/esqueci` | a caixa de e-mail — que é a própria chave de acesso | 30 min | SMTP configurado |
| **Equipe → "Abrir acesso"** | o gestor, entregando o link em mãos | 24 h | nada |
| `npm run admin -- senha` | o papel dono, na máquina do servidor | 24 h | nada |

O correio nasce desligado, como o extrator, e a recuperação **não depende
dele** — sem isto abaixo as outras duas portas continuam abertas, e o que falta
é só o autoatendimento:

```bash
APP_URL=https://app.exemplo.com    # obrigatório junto com o SMTP; ver abaixo
SMTP_HOST=smtp.exemplo.com
SMTP_PORTA=587                     # 465 é TLS desde o primeiro byte; 587 sobe com STARTTLS
SMTP_USUARIO=                      # vazio = servidor sem autenticação
SMTP_SENHA=
SMTP_DE=colheit.ai <nao-responda@exemplo.com>
```

`SMTP_HOST=registro` imprime a mensagem no log em vez de mandar. **É de
desenvolvimento**, e serve para dar para ver o autoatendimento e a recuperação
funcionando antes de existir um servidor de e-mail — o link sai em texto puro
num log que costuma ser coletado e lido por quem não é dono da conta, e a subida
avisa isso em voz alta.

**O gestor deixou de definir a senha de alguém.** A rota
`POST /auth/usuarios/:id/senha` saiu, e `app.definir_senha` perdeu o `execute`
do papel de aplicação. Senha que duas pessoas conhecem não é senha: quem
reaproveita a mesma em outro sistema passa a ter esse sistema conhecido também
— e no caminho até a pessoa ela ainda passaria por uma mensagem em texto puro.

Três prazos e três detalhes que não são estilo:

- **O bilhete viaja no fragmento** (`/empresa#senha=…`), nunca na busca. O que
  vem depois do `?` chega ao servidor, entra no log de acesso e sai no `Referer`
  de qualquer imagem que a página carregue. O que vem depois do `#` fica no
  navegador — e a tela o apaga da barra de endereço assim que o lê.
- **`APP_URL` é obrigatório junto com o SMTP.** Sem ele a API teria de adivinhar
  o próprio endereço pelo cabeçalho `Host`, que quem faz a requisição escolhe: um
  `Host` forjado mandaria para a caixa da vítima um link legítimo apontando para
  o servidor de outra pessoa.
- **O freio de "esqueci" é próprio, e não o do login.** Se um pedido de
  recuperação contasse como falha de senha, qualquer um trancaria a conta alheia
  só apertando o botão — a recuperação viraria a negação do serviço. O que existe
  é um pedido por minuto por pessoa, e a resposta é a mesma de qualquer jeito.

Trocar a senha **destranca o login**: quem esqueceu errou cinco vezes antes de
lembrar que existe "esqueci", e sem isso acabaria de escolher uma senha nova
para continuar bloqueado quinze minutos.

Sem correio configurado a frase da tela muda, e tem de mudar: dizer "o e-mail
chega em instantes" numa instalação que não manda e-mail é mandar a pessoa
esperar por algo que não vem. O que ela ouve é por onde ir — o gestor.

> **Duas coisas que esta parte NÃO faz.**
>
> A entrega por SMTP **nunca foi exercitada contra um servidor de e-mail de
> verdade**. O fluxo do bilhete está testado ponta a ponta, com um entregador
> falso; a entrega em si, não.
>
> Redefinir a senha **não derruba as sessões abertas**. O token é JWT e vale até
> 12 h; conferir a cada requisição se a senha mudou depois dele significa uma
> leitura no banco no caminho quente, que é decisão de arquitetura própria. Para
> quem esqueceu a senha isso não muda nada — para quem foi invadido, muda.

### Autoatendimento de cadastro — a empresa abrindo a própria conta

Era o último ato que ainda exigia alguém na máquina do servidor. `POST
/conta/cadastro` é a **única rota pública da API** — a única que alguém alcança
sem ter conta.

**Nada nasce no envio do formulário.** O que nasce é um pedido à espera do
e-mail; a empresa só existe quando alguém abre o link. Não é cerimônia: `tenant.
documento` é único, então criar no envio deixaria qualquer um plantar o CNPJ de
uma empresa de verdade e **trancar a porta dela para sempre**, sem precisar
receber e-mail nenhum, sem precisar de nada além de um POST.

**Uma resposta, três desfechos.** A tela responde exatamente igual sempre; quem
conta o que aconteceu é o e-mail, que só chega a quem controla o endereço
digitado:

| Desfecho | O e-mail diz |
|---|---|
| `nova` | o link de confirmação, 48 h, uma vez só |
| `empresa_existe` | "esse CNPJ já tem conta; peça acesso a quem administra" — sem link, sem nomear ninguém |
| `email_existe` | "você já tem conta; entre, ou use 'Esqueci minha senha'" |

Dizer isso **na tela** entregaria, a quem for tentando um CNPJ de cada vez, a
lista de quem é cliente da plataforma. O aviso não leva link nem nome porque
saber que a empresa já é cliente basta para procurar quem administra — um nome
a mais seria um nome entregue a quem digitou um CNPJ.

A confirmação cria empresa, primeiro gestor e o bilhete de senha **na mesma
transação**, e emenda direto na escolha da senha: quem acabou de confirmar o
e-mail não deve ter de clicar num segundo link para entrar. O gestor nasce sem
senha, como todo usuário desta base.

**Só `revenda` e `distribuidor` se cadastram sozinhos.** Franqueadora,
franqueado e indústria existem dentro de uma rede que alguém precisa ligar com
`admin -- rede` ou `admin -- territorio` de qualquer jeito: são conversa, não
formulário. E vale dizer o que *não* depende disso — `tenant.tipo` **não manda
em visibilidade nenhuma**. Quem enxerga a rede é a tabela `rede`, quem enxerga o
território é a `territorio`, e só o papel dono escreve nas duas. Há teste de que
uma franqueadora sem rede não enxerga rede nenhuma.

O que segura abuso, em ordem de quanto pega: o **dígito verificador do CNPJ**
(derruba robô que sorteia número), **um pedido por minuto por endereço**, o
prazo de 48 h, e a confirmação por e-mail — que é o que separa "sabe fazer um
POST" de "controla uma caixa de entrada".

O freio mora em `cadastro_tentativa`, uma tabela própria, e não numa contagem
de pendências. A diferença não é arrumação: dos três desfechos só um cria
pendência, e **os três mandam e-mail** — para o endereço que quem preenche o
formulário escolheu. Um freio que contasse só pendência deixaria qualquer um
despejar avisos de "essa empresa já tem conta" na caixa de outra pessoa, sem
limite nenhum. O que se mede é o pedido, dê ele no que der.

> **O limite que sobra, e não tem conserto bonito.** Quem confirmar primeiro
> fica com o CNPJ. Alguém de má-fé que controle um e-mail pode tomar o CNPJ de
> um concorrente e obrigar a empresa de verdade a ligar para o suporte. Exigir
> e-mail de domínio próprio resolveria — e barraria metade das revendas do
> interior, que usam gmail. A saída é operacional: `npm run admin -- empresas`
> marca **"pela tela"** quem nasceu assim, que é o primeiro dado a olhar quando
> essa ligação chegar.

Nada disso funciona sem correio: sem como confirmar, o autoatendimento
simplesmente não existe naquela instalação, e a tela diz isso em vez de aceitar
um formulário que não leva a lugar nenhum.

## Registro de visita — e a H1 medida

A H1 diz que o consultor registra a visita se for rápido o bastante, com mediana
abaixo de 60 segundos, e que sem isso não há dado nem produto. É a hipótese que
mata o projeto sozinha.

Por isso `visita` guarda **`duracao_seg` e `canal`**: a H1 deixa de depender de um
dia de campo com cronômetro e passa a ser medida em toda visita, comparando o áudio
no WhatsApp com o formulário do aplicativo.

```
GET  /visitas            histórico (o produtor vê as da lavoura dele)
GET  /visitas/fila       a fila do dia — só empresa
GET  /visitas/h1         mediana e p90 por canal, com o veredito — só empresa
POST /visitas            registra; aceita `clienteId` (ver o app do consultor)
```

O console cronometra a si mesmo: o relógio começa quando a janela abre e para no
envio. Vem do cliente, então é indicativo — serve para ver tendência e comparar
canais, não para cobrar ninguém. Registro acima de trinta minutos é descartado: é
aba esquecida aberta, e envenenaria a mediana que decide o produto.

### A fila do dia

Ordena por tempo sem visita **pesado pela área**, com corte em 15 dias — o mesmo
que o bench encontrou no concorrente, e a tradução do "82 nunca acessados" da
planilha de origem. Quem nunca foi visitado vem primeiro: o produtor grande que
ninguém nunca procurou é o pior caso da carteira.

### O áudio e o formulário na mesma régua

Relato de tipo `visita` validado pelo consultor **vira visita de verdade**, com
`canal = 'whatsapp'`. Sem isso os dois caminhos nunca seriam comparáveis — e é
exatamente a comparação que a H1 revisada pede.

## Catálogo

Produto, preço por safra e canal, royalties. O bench classificou royalties como
**requisito de entrada**, não diferencial: sem eles não se vende para quem
trabalha com semente certificada.

```
GET   /catalogo/produtos              com o preço vigente de cada canal
POST  /catalogo/produtos
PATCH /catalogo/produtos/:id/arquivar
GET   /catalogo/produtos/:id/precos   o histórico completo
POST  /catalogo/produtos/:id/precos   nova vigência — nunca sobrescreve
GET   /catalogo/resumo                volume, receita e o custo da bonificada
```

### Categoria genérica desde o primeiro dia

`produto.categoria` já aceita defensivo e fertilizante mesmo entregando só
semente. É a decisão da seção 18 do desenho, e a diferença entre **acrescentar
uma linha e migrar a base com cliente rodando**.

### Preço não se sobrescreve

Cada vigência é uma linha, e o item do pedido **carimba o valor e os royalties da
hora da venda** — mesma razão do carimbo de território. "Por que este pedido saiu
por outro preço" é a primeira pergunta do financeiro, e ela só tem resposta se o
número ficar guardado na linha.

O catálogo não é obrigatório: item digitado à mão continua abrindo pedido.

### A bonificada, que faz o número mentir

Semente de geração de demanda entra no volume e não entra na receita. O resumo
mostra **dois preços médios** — o cobrado e o efetivo —, e a diferença entre eles
é o que a GD custou.

O saco não é cobrado, mas **o royalty do detentor da tecnologia continua devido**.
É o que torna a geração de demanda cara de verdade.

## Funil de prospecção — e o laço

Uma oportunidade por produtor por safra: é assim que a operação pensa. Duas para
o mesmo produtor na mesma safra seriam a mesma conversa contada duas vezes.

```
GET   /funil                  lista, por safra e estágio
GET   /funil/resumo           os seis estágios, na ordem da conversa
GET   /funil/penetracao       o laço: área → potencial → venda → lacuna
POST  /funil                  abre em prospecção
POST  /funil/:id/mover        perder exige motivo
PATCH /funil/:id/potencial    informado manda sobre estimado
```

### O laço é o que diferencia isto de um CRM qualquer

O bench mostrou que funil todo mundo tem. O que o desenho chama de fosso é **"o
laço que devolve o dado do campo ao funil"** — e é isto:

> **área cadastrada → potencial → comparada com o que foi vendido → a lacuna**

O potencial sai da área que o campo já registrou, sem ninguém digitar. Quem
souber o número informa, e aí o informado manda — a coluna ao lado diz qual dos
dois foi.

A taxa de sacos por hectare **se declara como padrão** quando ninguém informou,
em vez de fingir precisão que a agronomia ainda não deu.

A lista ordena pela **lacuna em sacos, não pelo percentual**: o produtor de
18.000 ha com 25% de penetração vale mais atenção que o de 400 ha com 5%.

### O que a penetração não diz

A lacuna mostra **onde** o concorrente está, não **qual marca** o ocupa. Isso só o
talhão conta, e quem traz o talhão é o caderno de campo. Dizer a marca sem ele
seria inventar.

### A camada comercial não atravessa

`oportunidade` **não tem política de produtor** — nenhuma. Motivo de perda,
concorrente e potencial ficam do lado de dentro, e a ausência de política é a
forma mais difícil de desfazer por engano. Se vazar, o consultor deixa de
registrar a verdade e a base perde o valor.

## O painel do gestor

`GET /painel` — uma chamada, e a tela de abertura da área da empresa sai dela.

### Um módulo sem tabela, e sem SQL

`modulos/painel/` não tem `repository.js`. Ele compõe o que os outros módulos
já respondem, **pelos services deles**, que é a regra da seção 13. Quando um
número do painel precisa de SQL novo, ele nasce no módulo dono do dado — foi o
que aconteceu com o gargalo, que é de pedidos.

E ele não recalcula o que o dono já calculou. `nossoShare`, `lacunaSc` e a
frase que diz de que base o número saiu chegam prontos de caderno e funil.
Refazer a conta aqui criaria dois números com o mesmo nome, que divergem no dia
em que alguém corrigir só um dos dois.

O que **mora** no painel são os cortes de leitura: quantos itens cabem numa tela
de abertura, e o que é destaque. Régua de negócio não fica na tela — lá ela
vira decoração que cada um reajusta sem perceber.

### O mesmo painel para gestor e consultor

`soEmpresa` e nada mais. Quem enxerga a empresa inteira e quem enxerga só a
própria carteira recebem **a mesma resposta**, com números diferentes, porque a
política decide. Um `if` de papel aqui seria uma segunda regra de visibilidade
para manter em dia com a primeira. Há teste conferindo que nenhum campo aparece
ou some por papel.

⚠️ Ressalva honesta: hoje só o vínculo com o produtor é estreitado por carteira.
Pedido e visita são do tenant inteiro para os dois papéis.

### O gargalo é tempo, não contagem

"8 pedidos na etapa 3" não diz nada — pode ser operação andando. **"8 pedidos
parados há 20 dias na etapa 3"** é o gestor tendo um problema e não sabendo. O
painel mostra mediana de dias parado e o pior caso por etapa, com o número do
pedido mais antigo, porque quem gerencia vai atrás do pedido e não da média.

`app.gargalo_por_etapa()` mede o tempo desde o **último movimento de qualquer
tipo** — avanço, crédito, nota. Medir só o avanço de etapa marcaria como parado
o pedido em que se trabalhou ontem, e o gestor aprenderia a ignorar o
indicador. O corte (`DIAS_PARADO_DEMAIS`, 7) vem de pedidos, não do CSS.

Uma operação saudável **não aponta gargalo nenhum**: destacar "o pior" quando
nada está travado ensina a ignorar o painel.

### A safra sai do dado

Não há constante de safra na API. Ela vem do pedido mais recente; sem venda
nenhuma, do calendário (de julho em diante já se fala da safra que vem). A
resposta diz de onde veio, em `safraVeioDe`.

No console, `SAFRA_ATUAL = '26/27'` deixou de ser constante e virou
`safraAtual()`, alimentada pelo painel. Como constante ela estava errada desde
o dia em que foi escrita: viraria o ano, as telas ficariam vazias, e ninguém
ligaria uma coisa à outra.

### Cada número carrega o que ele não é

| Número | O que vai junto |
|---|---|
| volume da safra | a fatia bonificada, que entra no volume e **não** na receita |
| receita | o preço médio **efetivo**, que é o que a bonificada de fato deixou |
| lacuna da carteira | a taxa de sc/ha e `padrão — confirmar com a agronomia` |
| share por marca | `área que registramos — não o mercado do território` |
| produtividade da safra | `média ponderada pela área colhida — não é a média dos talhões` |
| nossa semente × concorrente | `não é ensaio comparativo — são lavouras diferentes, em solos, datas e manejos diferentes` |

O share é o caso mais perigoso: 54% lido como share de mercado é outra ordem de
grandeza. A frase vem da API justamente para não depender de alguém lembrar de
escrevê-la na tela.

### O fechamento da safra

O fim do laço, agora no painel: a semente que saiu do pedido virou saco por
hectare, e o número volta ao funil da safra seguinte. Produtividade ponderada
pela área, variação contra a última safra que produziu número, e os talhões que
fugiram da média **para os dois lados** — é onde há decisão a tomar; no meio da
distribuição não há.

Nada disso é recalculado aqui. O caderno já entrega a ponderada, a variação e a
separação por origem, com as frases que dizem de que base cada número saiu; o
painel escolhe o que cabe na abertura e leva as frases junto.

> **Nossa semente contra a do concorrente** é o número mais perigoso do sistema.
>
> Ele mistura semente, solo, data de plantio e manejo, e quem lê num painel
> atribui a diferença inteira à semente. A ressalva vem colada ao número, não num
> rodapé. Ele vive em `/caderno/resultado-por-origem`, `soEmpresa` — **fora** do
> `/caderno/resultado`, que o portal do produtor também lê. É a mesma razão pela
> qual `nossa` não aparece na tela dele: ali seria marketing com número que não é
> de ensaio.

Sem talhão plantado o cartão não aparece, em vez de mostrar `0 sc/ha` — número
que parece resultado ruim quando é ausência de registro.

### O mesmo painel serve ao franqueado

Ele não tem carteira, não tem fila de visita e não tem funil: enxerga a cadeia
que desce do território dele, e só. O painel serve a ele **sem um `if` de papel
em lugar nenhum** — o bloco sem dado vem `null` e a tela não o desenha.

> Zero não é o mesmo que ausência. "0 produtores atrasados" descreve um problema
> que não existe; a ausência descreve o negócio dele. Vale igual para a revenda
> no primeiro dia.

E a regra olha o **dado**, não o tipo do tenant. Um `if` de papel aqui seria uma
segunda regra de visibilidade para manter em dia com a política — que é
justamente o que este módulo evita.

**Quanto do território passou por terceiro** é o número dele, e é o que ele não
descobre de outro jeito: ele não operou aquela venda, enxerga porque o pedido
carimbou o município. `pedido.canal` já existia na criação, mas só para achar o
preço, e então se perdia — agora fica carimbado, como `franqueado_id` e
`municipio`, e pelo mesmo motivo.

O melhor e o pior talhão vêm com o **nome da fazenda**: "Gleba 1" é o nome de
talhão mais comum do país, e num painel com várias o melhor e o pior sairiam
como a mesma linha. A 030 abre a relação produtor↔propriedade pela mesma porta
das outras — o pedido que carimbou o território —, e não revela nada novo: o
próprio pedido que ele lê já traz os dois lados na mesma linha.

### E ao topo da cadeia: a franqueadora

`franqueadora` existia só como valor do enum de tipo desde a 012 — a
visibilidade dela nunca tinha sido construída. A 031 constrói.

`rede` liga franqueado a franqueadora, com **chave primária no franqueado**: a
exclusividade da franquia é a própria restrição de unicidade, como o território
na 012. Um franqueado servindo duas franqueadoras é estado que o banco não
permite existir.

> **Uma franqueadora não pode saber das transações de outra.**
>
> Cada política dela pendura no **pedido**, que já carrega o carimbo do
> franqueado. O alcance é "pedido cujo franqueado é meu" — nunca "tudo que
> aconteceu no município", que pegaria a venda da concorrente na mesma cidade.
> Há teste com duas franqueadoras e franqueados vizinhos em Mato Grosso: a rival
> vê 367 sc e 1.100 ha, e nada dos 3.301 sc da outra rede.

Tudo de leitura, como o franqueado: ela não opera venda nenhuma. E
`pedido_item`, `nota`, `plantio` e `colheita` passam a valer para ela **sem uma
linha a mais** — foram escritas em cima de `app.pedido_visivel` e
`app.talhao_visivel`, que perguntam o que o chamador enxerga em vez de fixar um
tenant.

`rede` tem leitura aberta, como `territorio` e pelo mesmo motivo: a forma da
rede não é segredo — uma loja franqueada exibe a marca na fachada. O que é
confidencial são as transações.

**A rede, por franqueado** é o cartão que só ela vê, e o recorte que não existe
em nenhuma outra tela: qual franqueado está entregando lavoura melhor. Aparece
quando há mais de um — não por tipo de tenant, mas porque quem enxerga um só não
tem comparação a fazer.

### E a ressalva que tornava o ranking quase inútil

O cartão nascia dizendo *"territórios diferentes, com solo, clima e manejo
diferentes — quem está no topo pode apenas ter a melhor terra"*. A ressalva é
verdadeira, e por isso o ranking sozinho decidia pouco.

**Comparar cada franqueado com o território DELE** tira o terroir da conta:

```
A REDE, CADA UM CONTRA O TERRITÓRIO DELE
FS Mato Grosso  ██████████████▕  +6,3%
  69,4 sc/ha em 3.400 ha · território: 65,3 sc/ha em 2 município(s)
FS Bahia        █████████▕       -9,6%
  47 sc/ha em 3.500 ha · território: 52 sc/ha em 2 município(s)
Cada um comparado com o próprio território, que inclui quem não
comprou da rede. Assim o solo e o clima saem da conta, e o que
sobra é o que depende de quem trabalha ali.
```

O ranking cru dizia que Mato Grosso estava 22 sacas à frente da Bahia. O honesto
diz que **Mato Grosso está à frente da própria região e a Bahia está atrás da
dela** — que é o fato sobre o qual ela pode agir.

`app.benchmark_do_territorio` segue a mesma disciplina da 032: `security
definer`, agregado só, e o piso de `app.benchmark_minimo()` dentro da função. O
território vem de `territorio`, que já é público.

**Ninguém é excluído do território**, e aí não há alavanca: ela não controla quem
planta num município. O que ela controla é a **rede**, e a rede não entra no
recorte — ao contrário do painel do gestor, onde a carteira entraria.

O denominador vem da função, não do que ela alcança: no teste ela enxerga **uma**
lavoura pela rede e o território tem muitas. É esse o ponto — comparar o que ela
vendeu com tudo que foi plantado ali, inclusive pelo concorrente.

### E a distribuidora, que compra de vários

O painel dela **já funcionava**: ela opera as vendas dela, então tem carteira,
fila de campo e fechamento de safra como qualquer revenda. Não havia camada a
construir — havia um vazamento de enquadramento a consertar e um recorte a dar.

**O vazamento.** Ela compra de vários franqueados, então enxerga vários
`franqueado_id` nos pedidos dela — e o cartão "a rede, por franqueado" aparecia
para ela, comparando fornecedores como **"sem nome"**, já que o nome do tenant só
abre para a franqueadora. Agora a consulta junta com `rede`: a pergunta "qual é o
melhor franqueado" é de quem tem rede.

Repare que a correção não é um `if` de tipo — é uma junção. Quem não tem linha em
`rede` como franqueadora não tem cartão de rede, e isso vale para a revenda, para
o franqueado e para ela.

**O recorte que é dela**: a safra por **município**. Vende em vários territórios,
não tem rede a comparar, e o que quer saber é de qual região vem a melhor
lavoura.

E ele **não nomeia franqueado nenhum**. O município está na propriedade que ela
mesma cadastrou — é dado dela. A confidencialidade da cadeia não é ferida por um
agrupamento de vendas próprias.

```
A CARTEIRA CONTRA A REGIÃO
Sorriso/MT             ██████████████▕  +9,6%
Lucas do Rio Verde/MT  ████████████▕     +2,4% vs MT
Sinop/MT               ██████▕          -12,9%
A região inclui a sua carteira, e só aparece com pelo menos cinco
produtores. Solo, clima e manejo mudam de um município para o
outro — a diferença não é só de quem plantou.
```

A barra é a carteira dela; o traço é a região. Duas barras por linha em oito
municípios viram um gráfico que ninguém lê.

`vs MT` na terceira linha não é detalhe: aquele município não alcançou o piso, a
comparação subiu para o estado, e sem dizer isso "+2,4% em Lucas do Rio Verde"
seria lido como se fosse contra Lucas do Rio Verde.

> **A região aqui INCLUI a carteira dela, e isso é decisão.**
>
> O produtor é excluído da própria comparação porque ele **não escolhe** quem
> mais está no grupo. A revenda escolhe: a carteira é dela. Se a região fosse
> "todos menos a minha carteira", mover um produtor para dentro da carteira
> mudaria o número da região, e a diferença entre as duas consultas revelaria a
> lavoura daquele produtor. **Um piso de anonimato não protege contra quem
> controla o recorte** — por isso não há recorte a controlar.

E fica calada onde a carteira dela é praticamente o município inteiro: a
diferença seria contra si mesma, e zero não diz nada.

Acima de oito municípios a tela para: cada linha é uma ida ao banco, e a tela de
abertura não é relatório.

## Caderno de campo — e o share por marca

O último item de fosso. O share do concorrente **só pode vir do talhão**: a
distribuidora não o entregaria, e o franqueado, sendo exclusivo, não o tem.
Aqui ele finalmente tem de onde sair.

```
GET  /caderno/plantios              o que foi plantado (o produtor vê o dele)
GET  /caderno/desempenho            como cada cultivar se saiu
GET  /caderno/resultado             o fechamento da safra, ponderado pela área
                                    (?produtorId= para um produtor só)
GET  /caderno/resultado-por-origem  nossa semente × concorrente — só empresa
GET  /caderno/resultado-por-franqueado  a safra de cada franqueado da rede
GET  /caderno/rede-contra-regiao    cada franqueado contra o território dele
GET  /caderno/meu-territorio        o que desceu de mim contra o território
GET  /caderno/resultado-por-municipio   a safra por região, sem nomear franqueado
GET  /caderno/benchmark             a região do produtor, com ele de FORA
GET  /caderno/benchmark-por-municipio  a carteira contra a região, ela INCLUÍDA
GET  /caderno/share                 share por marca — só empresa
POST /caderno/plantios              registra ou corrige
POST /caderno/plantios/:id/colheita fecha o laço
```

### A marca é obrigatória, sempre

Nossa ou de terceiro. **É a coluna que responde a H5**, e ela só existe porque
alguém esteve no talhão. Se o cultivar está no catálogo, o vínculo é feito
sozinho — é assim que "nossa ou deles" se calcula sem ninguém classificar à mão.

### Safra e safrinha convivem

Um talhão tem dois plantios no mesmo ano agrícola, e a chave é
`(talhao, safra, ciclo)`. A planilha que deu origem ao projeto era de **milho
safrinha** — tratar as duas como uma só apagaria metade do negócio.

### O share diz de que base saiu

O denominador é a **área plantada que nós registramos**, não o mercado do
território. A resposta e a tela dizem isso junto com o número: share que se
apresenta como absoluto vira decisão errada na reunião seguinte.

### Camada técnica: o produtor vê

Ler segue o talhão, inclusive para ele — a lavoura é dele, e o histórico
atravessa revenda. **Escrever exige sessão de empresa**: quem fecha o registro é
o consultor. E o franqueado alcança o talhão pelos pedidos que carimbam o
território dele, porque o que foi plantado é justamente o que ele está comprando.

## O gateway do WhatsApp (Baileys)

Processo separado, em `gateway/`. Sobe sob demanda:

```bash
docker compose --profile whatsapp up gateway
```

Na primeira vez ele imprime um QR por número no log — alguém precisa parear. A
sessão fica no volume `colheitai-whatsapp`; perder o volume significa parear de
novo.

### Por que fica fora da API

Um travamento ou bloqueio aqui **não derruba o resto**. E é o que permite trocar
o Baileys pela API oficial depois sem tocar no módulo de captura.

### A decisão fica em `laco.js`, a biblioteca em `whatsapp.js`

`laco.js` não tem uma linha de Baileys — roda em teste com um WhatsApp de
mentira, e é por isso que o comportamento inteiro é coberto sem número nenhum.
`whatsapp.js` é a única parte que o CI **não** cobre, e a única que não decide
nada.

| O gateway | Por quê |
|---|---|
| descarta grupo, status e mensagem nossa | responder num grupo seria disparo aos olhos de quem só estava lendo |
| ignora id repetido | reconexão reentrega, e relato duplicado é pior que nenhum |
| pausa entre envios | rajada é o que chama atenção, e atenção vira bloqueio |
| não marca como enviada se falhar | continua na fila e sai na próxima volta |
| não reconecta em bloqueio definitivo | o número foi embora; insistir só queima o próximo |

Ele **nunca decide o que enviar**: a API só cria saída atrelada a uma entrada, e
o banco recusa o contrário. Aqui não há o que julgar.

⚠️ Baileys é biblioteca não oficial. É contra os termos do WhatsApp, e quando o
bloqueio vier não haverá a quem recorrer. Um número por tenant existe para o
estrago parar num cliente, e o portal continua de pé sozinho.

## Armazenamento de mídia

Áudio de produtor descrevendo a própria lavoura é o dado mais sensível que o
projeto captura. Ele não fica em disco de contêiner, e **nunca** tem URL
pública.

```
gateway        --(bytes crus)-->  POST /captura/midia  -->  armazém
app do campo   --(bytes crus)-->  POST /midia                  |
                                          |             tabela `midia`
                                          +-------------  (tenant, produtor,
                                                            política)
                                                               |
navegador  <--(blob)--  GET /midia/:id  <-- a política decide antes do byte sair
```

Duas portas de entrada, uma implementação. O **gateway** não diz de quem é o
arquivo: manda o canal e o remetente, e a API resolve o tenant pelo canal e o
produtor pelo telefone. O **app do campo** entra pela sessão, e aí o tenant vem
do contexto e a política confere o carimbo no `with check`. Nenhum dos dois
escolhe em nome de quem guarda.

### Dois armazéns atrás da mesma porta

| `ARMAZEM` | Onde | Para quê |
|---|---|---|
| `s3` (padrão) | MinIO do compose, ou S3 de verdade | o caminho de produção |
| `disco` | `MIDIA_DIR` | para quem não quiser subir contêiner |

O MinIO sobe junto com o banco, de propósito: um backend exercitado só em
produção é um backend não testado. O teste roda o mesmo guardar/baixar nos
dois.

### O que o módulo decide

| Regra | Por quê |
|---|---|
| lista fechada de MIME, 12 MB | o canal não pode virar porta de entrada de arquivo qualquer |
| `audio/ogg; codecs=opus` vira `audio/ogg` | o parâmetro é codificação, não tipo — separaria o mesmo formato em duas famílias |
| mesmo sha256 no mesmo tenant reaproveita a linha | reconexão do gateway reentrega o áudio, e duas cópias do mesmo minuto são só custo |
| se o `insert` falhar, o objeto é apagado | senão fica lixo que ninguém alcança e ninguém apagaria |
| `cache-control: private` | cache compartilhado guardando áudio de produtor é o mesmo vazamento por outro caminho |
| chave é normalizada antes de virar caminho | `../` escrevendo fora do lugar é o erro clássico do adaptador de disco |

A política é a de sempre: a empresa vê o que é do tenant dela, o produtor
alcança o que ele mesmo mandou (`with check (false)` — ele lê, não escreve), e
mais ninguém.

Se a subida falhar, a **mensagem vai mesmo assim**. O produtor mandou e vai
cobrar; o consultor ao menos vê que chegou algo dele, o que é melhor do que o
silêncio de uma mensagem descartada.

## Extrator de IA

Transcreve o áudio do campo e estrutura o relato. É o que transforma "o
produtor mandou um áudio" em cultivar, marca, lote e estande dentro do caderno
de campo — e é também a peça que mexe com o dado mais sensível do projeto.

### A trava é dupla, e a segunda não é técnica

```bash
IA_CHAVE=...            # a chave do provedor
IA_PLANO=sem-treino     # a declaração de que o contrato proíbe treinar no que sobe
```

Faltando qualquer uma, **fica desligado**. `IA_PLANO` não tem efeito nenhum no
código, e é exatamente por isso que existe: quem liga a leitura automática
precisa afirmar por escrito, num arquivo que alguém revisa, que o plano do
provedor proíbe treino. O caso que importa não é a chave ausente — é a chave
presente com o contrato esquecido, e esse sai no log da subida:

```
extrator DESLIGADO: há IA_CHAVE, mas IA_PLANO não declara `sem-treino`.
Áudio de produtor não sobe para provedor que pode treinar nele.
```

### O que sobe, e o que não sobe

Sobe o áudio (ou a foto, e a legenda dela — é onde costuma vir o número do
lote) mais um glossário de safra, talhão, estande e estádio fenológico.

**Não sobe** nome, telefone, propriedade nem tenant. O provedor não precisa
saber de quem é a voz para transcrever o que ela diz, e o que ele não recebe não
vaza. Existe teste que falha se algum desses campos aparecer no que é enviado.

### A saída é esquematizada, não lida de prosa

`responseSchema` do próprio provedor, `temperature: 0`. Campo de negócio
extraído de texto livre por expressão regular é a receita de número errado com
cara de número certo; e variação de temperatura produziria campo diferente para
o mesmo áudio, que ninguém consegue conferir duas vezes.

Os nomes do esquema **são o contrato** com os outros módulos: `cultivar`,
`marca`, `lote`, `safra`, `ciclo`, `areaHa` e `populacao` são lidos por
`caderno.registrarDePlanteRelato`; `estagio` e `estande`, por
`visitas.registrarDeRelato`. Renomear um deles quebraria o laço em silêncio —
por isso há teste amarrando os dois lados.

### A regra número um é não inventar

Campo que não foi dito fica `null`, e `null` é descartado antes de guardar. O
consultor confere o que a IA escreveu: **um campo plausível e errado passa; um
campo vazio ele preenche.** Deduzir a marca pelo prefixo da cultivar, ou
adivinhar qual talhão cadastrado é a "Gleba 4" falada, são exatamente os erros
que o prompt proíbe — quem aponta o talhão é o consultor, ao validar.

A leitura vem com `confianca` de 0 a 1, e a tela "Do campo" a mostra como
etiqueta. Abaixo de 60% ela fica âmbar e diz `confira`.

### Quando dá errado, o relato não se perde

| Situação | O que acontece |
|---|---|
| 429 ou 5xx | tenta mais uma vez, com pausa |
| 403 ou 400 (chave, cota, esquema) | **não** repete — só gastaria; sai no log |
| tempo esgotado (`IA_TIMEOUT_MS`, 20s) | devolve `null` |
| resposta vazia, bloqueada ou que não é JSON | devolve `null`, com o motivo no log |

`null` nunca é erro: o relato continua em `aguardando_extracao` e entra na
próxima volta do leitor. Falha aqui jamais derruba a mensagem que o produtor
mandou.

### Drenar a fila

```bash
docker compose exec -w /app/api api npm run ler
```

Roda com o papel dono e não é rota — a fila atravessa tenants, é da
plataforma, mesmo motivo do despachante de push. O limite (`IA_LIMITE`, 100) é
proposital: cada item é uma chamada paga, e uma fila de meses lida de uma vez
sem teto é uma conta que ninguém autorizou. Rodar de novo continua de onde
parou.

## O que ainda não está aqui

**O plano sem-treino do provedor.** O extrator está construído e testado, mas
não roda: falta o contrato. É a única pendência que não se resolve em código —
e até ela ser resolvida, a fila fica guardada em `aguardando_extracao`.

Nada do extrator foi exercitado contra o provedor de verdade. O teste cobre o
comportamento inteiro com um provedor de mentira; o que só a primeira chamada
real vai dizer é se a transcrição aguenta áudio de trator em movimento, e se o
esquema sobrevive a sotaque e jargão de região.

`002_exemplo_isolamento.sql` fica: testa `app.aplicar_isolamento` de forma
independente do domínio.

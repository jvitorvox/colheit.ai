// O painel do gestor.
//
// Este módulo NÃO tem tabela e NÃO tem repository — de propósito. Ele não sabe
// SQL nenhum: compõe o que os outros módulos já respondem, pelos SERVICES
// deles, que é a regra da seção 13. Se um número do painel precisar de SQL
// novo, ele nasce no módulo dono do dado (foi o que aconteceu com o gargalo,
// que é de pedidos), nunca aqui.
//
// E não recalcula o que o dono já calculou. `nossoShare`, `lacunaSc` e a frase
// que diz de que base o número saiu vêm prontos de caderno e funil. Refazer a
// conta aqui criaria dois números com o mesmo nome, que divergem no dia em que
// alguém corrigir só um dos dois.
//
// O que MORA aqui são os cortes de leitura: quantos itens cabem numa tela de
// abertura, e o que é destaque. Régua de negócio não pode viver na tela — lá
// ela vira decoração que cada um reajusta sem perceber.
//
// Ele também não filtra por quem está olhando. A política faz isso: o gestor
// enxerga a empresa, o consultor enxerga a carteira dele, e o mesmo painel
// serve aos dois sem um `if` sequer. Com uma ressalva honesta — hoje só o
// vínculo com o produtor é estreitado por carteira; pedido e visita são do
// tenant inteiro para os dois papéis.
import * as pedidos from '../pedidos/service.js';
import * as catalogo from '../catalogo/service.js';
import * as funil from '../funil/service.js';
import * as caderno from '../caderno/service.js';
import * as visitas from '../visitas/service.js';
import * as captura from '../captura/service.js';

/** Quantos itens de cada lista cabem antes de a tela virar relatório. */
const DESTAQUES = 3;

/** Safra padrão quando ainda não se vendeu nada: a que o calendário diz. */
export function safraDoCalendario(hoje = new Date()) {
  const ano = hoje.getFullYear();
  // O plantio da safra principal começa no segundo semestre: de julho em
  // diante já se fala da safra que vem, não da que passou.
  const inicio = hoje.getMonth() >= 6 ? ano : ano - 1;
  return `${String(inicio).slice(2)}/${String(inicio + 1).slice(2)}`;
}

/**
 * Monta o painel.
 *
 * A safra não é constante no código: sai do que foi vendido. Constante
 * envelhece em silêncio — vira o ano, a tela fica vazia, e ninguém liga uma
 * coisa à outra. Quando não há venda nenhuma, o calendário decide, e a
 * resposta diz de onde o valor veio.
 */
export async function montar(ctx, { safra } = {}) {
  const daVenda = safra ? null : await pedidos.safraCorrente(ctx);
  const escolhida = safra || daVenda || safraDoCalendario();

  // Em paralelo: são leituras independentes, e o gestor abre esta tela toda
  // manhã. Em série seriam sete idas ao banco enfileiradas por nada.
  const [lista, gargalo, porCanal, venda, oportunidades, penetracao, share, fila, aValidar,
    resultado, porOrigem, porFranqueado, porMunicipio] =
    await Promise.all([
      pedidos.listar(ctx, { situacao: 'andamento' }),
      pedidos.gargalo(ctx),
      pedidos.vendaPorCanal(ctx, escolhida),
      catalogo.resumoDeVenda(ctx, escolhida),
      funil.resumo(ctx, escolhida),
      funil.penetracao(ctx, { safra: escolhida }),
      caderno.sharePorMarca(ctx, escolhida),
      visitas.fila(ctx),
      captura.relatos(ctx, { situacao: 'pendente' }),
      caderno.resultadoDaSafra(ctx, escolhida),
      caderno.resultadoPorOrigem(ctx, escolhida),
      caderno.safraPorFranqueado(ctx, escolhida),
      caderno.benchmarkPorMunicipio(ctx, escolhida),
    ]);

  // Bloco vazio vira AUSÊNCIA, não uma fileira de zeros.
  //
  // Quem lê isto primeiro é o franqueado: ele não tem carteira, não tem fila de
  // visita e não tem funil — enxerga a cadeia que desce do território dele, e
  // só. Um painel mostrando "0 produtores atrasados" e "0 oportunidades" não
  // estaria descrevendo o negócio dele, estaria descrevendo um erro que não
  // existe. Vale igual para a revenda no primeiro dia.
  //
  // E repare que a regra não olha o TIPO do tenant: olha se há dado. Um `if` de
  // papel aqui seria uma segunda regra de visibilidade para manter em dia com a
  // política, que é justamente o que o resto deste módulo evita.
  const seTiver = (n, bloco) => (n > 0 ? bloco : null);

  return {
    safra: escolhida,
    safraVeioDe: safra ? 'pedida' : (daVenda ? 'última venda' : 'calendário'),
    venda: resumirVenda(venda, porCanal),
    operacao: seTiver(lista.length, { emAndamento: lista.length, ...gargalo }),
    carteira: seTiver(penetracao.linhas.length, resumirCarteira(penetracao)),
    campo: seTiver(fila.length, resumirCampo(fila, aValidar)),
    mercado: seTiver(share.marcas.length, resumirShare(share)),
    funil: seTiver(oportunidades.reduce((s, e) => s + e.quantas, 0),
      resumirFunil(oportunidades)),
    resultado: resumirResultado(resultado, porOrigem),
    // A rede só diz algo a quem enxerga mais de um franqueado: a franqueadora.
    rede: porFranqueado.length > 1 ? porFranqueado : null,
    // Município a município, com a região ao lado quando ela existe. Aparece
    // com mais de um município — e também com um só, se houver região a
    // comparar: aí já não é ranking interno, é a carteira contra a vizinhança.
    territorios: porMunicipio.length > 1 || porMunicipio.some((m) => m.regiao)
      ? porMunicipio
      : null,
  };
}

/* ------------------------------------------------------------- a safra */

/**
 * O fechamento da safra, do lado de quem vendeu.
 *
 * Nada é recalculado: caderno já entrega a ponderada pela área, a variação
 * contra a safra anterior e a separação entre a nossa semente e a do
 * concorrente — com as frases que dizem de que base cada número saiu. O painel
 * escolhe o que cabe na tela de abertura, e carrega as frases junto.
 */
function resumirResultado(r, porOrigem) {
  // Sem talhão plantado não há safra a fechar. Devolver zeros seria um cartão
  // dizendo "0 sc/ha" para quem ainda não plantou nada — número que parece
  // resultado ruim quando é ausência de registro.
  if (!r?.safra || r.talhoes === 0) return null;
  return {
    colhidos: r.colhidos,
    talhoes: r.talhoes,
    fechada: r.fechada,
    areaColhidaHa: r.areaColhidaHa,
    totalSc: r.totalSc,
    mediaPonderadaScHa: r.mediaPonderadaScHa,
    base: r.base,
    anterior: r.anterior,
    // Os três melhores e os três piores. No meio não há decisão a tomar — o
    // gestor vai atrás do talhão que fugiu da média, para os dois lados.
    melhores: r.porTalhao.filter((t) => t.produtividadeScHa !== null).slice(0, DESTAQUES),
    piores: r.porTalhao.filter((t) => t.produtividadeScHa !== null).slice(-DESTAQUES).reverse(),
    porOrigem,
  };
}

/* ------------------------------------------------------------------ venda */

/**
 * O que a safra vendeu — e o quanto disso não é dinheiro.
 *
 * A bonificada entra no volume e não entra na receita. Um painel que mostrasse
 * só o volume faria a safra parecer maior do que a venda foi, e é justamente o
 * cuidado que o catálogo já toma: aqui ele é repetido em vez de esquecido.
 */
function resumirVenda(linhas, porCanal) {
  const soma = (campo) => linhas.reduce((s, l) => s + Number(l[campo] ?? 0), 0);
  const quantidade = soma('quantidade');
  const bonificada = soma('bonificada');
  const receita = soma('receita');

  return {
    quantidadeSc: quantidade,
    bonificadaSc: bonificada,
    bonificadaPct: quantidade > 0 ? arredondar((bonificada / quantidade) * 100) : null,
    receita,
    royalties: soma('royalties'),
    // O preço que a bonificada de fato deixou, não o que o comercial pratica.
    precoMedioEfetivo: quantidade > 0 ? receita / quantidade : null,
    produtos: linhas.length,
    topo: linhas.slice(0, DESTAQUES).map((l) => ({
      produto: l.produto, quantidadeSc: l.quantidade, bonificadaSc: l.bonificada,
    })),
    // Direto e pela distribuidora. Para a revenda é curiosidade; para o
    // franqueado é o negócio dele — quanto do território dele passou por
    // terceiro é a única coisa que ele não descobre de outro jeito.
    porCanal,
  };
}

/* --------------------------------------------------------------- carteira */

/** Quem da carteira ainda não comprou, e o tamanho da lacuna em sacos. */
function resumirCarteira({ linhas, scPorHa, origemDaTaxa }) {
  return {
    produtores: linhas.length,
    semCompra: linhas.filter((l) => l.compradoSc === 0).length,
    lacunaSc: linhas.reduce((s, l) => s + l.lacunaSc, 0),
    // Já vem ordenada pela lacuna em sacos, e não pelo percentual: o produtor
    // de 18.000 ha com 10% vale mais atenção que o de 400 ha com 5%.
    maioresLacunas: linhas.slice(0, DESTAQUES).map((l) => ({
      produtor: l.produtor, lacunaSc: l.lacunaSc, penetracao: l.penetracao,
    })),
    scPorHa,
    origemDaTaxa,
  };
}

/* ------------------------------------------------------------------ campo */

function resumirCampo(fila, aValidar) {
  const atrasados = fila.filter((f) => f.atrasado);
  return {
    naFila: fila.length,
    atrasados: atrasados.length,
    nuncaVisitados: fila.filter((f) => f.nunca).length,
    corteDias: fila[0]?.corteDias ?? null,
    relatosAValidar: aValidar.length,
    proximos: atrasados.slice(0, DESTAQUES).map((f) => ({
      produtor: f.produtor, dias: f.dias, nunca: f.nunca,
    })),
  };
}

/* ---------------------------------------------------------------- mercado */

/**
 * Share por marca, com o denominador vindo junto.
 *
 * O número responde "de tudo que enxergamos plantado, quanto é nosso" — não
 * responde share de mercado, e a diferença entre as duas leituras é de ordem
 * de grandeza. Por isso `base` viaja colada ao número até a tela.
 */
function resumirShare({ marcas, nossoShare, areaObservadaHa, base }) {
  return {
    nossoShare,
    areaObservadaHa,
    marcas: marcas.length,
    topo: marcas.slice(0, DESTAQUES + 1).map((m) => ({
      marca: m.marca, nossa: m.nossa, share: m.share,
    })),
    base,
  };
}

/* ------------------------------------------------------------------ funil */

function resumirFunil(estagios) {
  const abertos = estagios.filter((e) => e.aberto);
  return {
    abertas: abertos.reduce((s, e) => s + e.quantas, 0),
    potencialSc: abertos.reduce((s, e) => s + e.potencialSc, 0),
    porEstagio: estagios,
  };
}

const arredondar = (n) => Math.round(n * 10) / 10;

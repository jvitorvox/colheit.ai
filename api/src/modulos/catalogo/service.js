import { comContexto } from '../../contexto.js';
import { ErroDeUso, NaoEncontrado } from '../../http/erros.js';
import * as repo from './repository.js';
import { textoObrigatorio, umDe, uuidValido, areaValida } from '../cadastro/validar.js';

const CATEGORIAS = ['semente', 'defensivo', 'fertilizante', 'outro'];
const CANAIS = ['direto', 'distribuidor'];

export function criarProduto(ctx, corpo = {}) {
  const p = {
    nome: textoObrigatorio(corpo.nome, 'nome', 80),
    categoria: umDe(corpo.categoria, CATEGORIAS, 'categoria', 'semente'),
    cultura: corpo.cultura ? textoObrigatorio(corpo.cultura, 'cultura', 40) : null,
    unidade: corpo.unidade ? textoObrigatorio(corpo.unidade, 'unidade', 6) : 'sc',
    embalagem: corpo.embalagem ? textoObrigatorio(corpo.embalagem, 'embalagem', 60) : null,
  };
  return comContexto(ctx, async (cx) => {
    const id = await repo.criarProduto(cx, p);
    return repo.buscarProduto(cx, id);
  });
}

export function listarProdutos(ctx, filtros = {}) {
  if (filtros.categoria) umDe(filtros.categoria, CATEGORIAS, 'categoria');
  return comContexto(ctx, (cx) => repo.listarProdutos(cx, {
    categoria: filtros.categoria,
    safra: filtros.safra,
    incluirInativos: filtros.incluirInativos === '1',
  }));
}

export function arquivarProduto(ctx, id, ativo) {
  uuidValido(id, 'id');
  return comContexto(ctx, async (cx) => {
    if (!(await repo.buscarProduto(cx, id))) throw new NaoEncontrado('produto');
    await repo.arquivarProduto(cx, id, ativo);
    return repo.buscarProduto(cx, id);
  });
}

/**
 * Define preço. Nunca sobrescreve o passado: cada vigência é uma linha.
 *
 * Reajustar apagando o valor anterior deixaria pedido antigo sem explicação —
 * e "por que este pedido saiu por outro preço" é a primeira pergunta que o
 * financeiro faz.
 */
export function definirPreco(ctx, produtoId, corpo = {}) {
  uuidValido(produtoId, 'produtoId');
  const p = {
    produtoId,
    safra: textoObrigatorio(corpo.safra, 'safra', 10),
    canal: umDe(corpo.canal, CANAIS, 'canal', 'direto'),
    valor: areaValida(corpo.valor, 'valor'),
    royaltiesSc: corpo.royaltiesSc === undefined || corpo.royaltiesSc === null
      ? 0 : areaValida(corpo.royaltiesSc, 'royaltiesSc') ?? 0,
    vigenteDe: corpo.vigenteDe ?? null,
  };
  if (p.valor === null) throw new ErroDeUso('valor é obrigatório', 'valor');

  return comContexto(ctx, async (cx) => {
    if (!(await repo.buscarProduto(cx, produtoId))) throw new NaoEncontrado('produto');
    await repo.definirPreco(cx, p);
    return repo.historicoDePreco(cx, produtoId);
  });
}

export function historicoDePreco(ctx, produtoId) {
  uuidValido(produtoId, 'produtoId');
  return comContexto(ctx, (cx) => repo.historicoDePreco(cx, produtoId));
}

/**
 * O preço a carimbar num item de pedido.
 *
 * Chamado pelo módulo de pedidos — pelo service, nunca pelo repository. Devolve
 * também o nome, porque o item guarda o cultivar por escrito: é o que o
 * produtor vê, e ele não pode depender de o catálogo ainda existir amanhã.
 */
export function precoParaVenda(ctx, { produtoId, safra, canal = 'direto' }) {
  uuidValido(produtoId, 'produtoId');
  return comContexto(ctx, async (cx) => {
    const produto = await repo.buscarProduto(cx, produtoId);
    if (!produto) throw new NaoEncontrado('produto');
    if (!produto.ativo) throw new ErroDeUso('produto arquivado', 'produtoId');

    const preco = await repo.precoVigente(cx, { produtoId, safra, canal });
    return {
      nome: produto.nome,
      unidade: produto.unidade,
      valor: preco ? Number(preco.valor) : null,
      royaltiesSc: preco ? Number(preco.royalties_sc) : null,
      temPreco: Boolean(preco),
    };
  });
}

/** Volume, receita e royalties — com a bonificada separada, que é o ponto. */
export function resumoDeVenda(ctx, safra) {
  return comContexto(ctx, async (cx) => {
    const linhas = await repo.resumoDeVenda(cx, safra);
    return linhas.map((l) => {
      const quantidade = Number(l.quantidade ?? 0);
      const bonificada = Number(l.bonificada ?? 0);
      const receita = Number(l.receita ?? 0);
      const cobrada = quantidade - bonificada;
      return {
        produto: l.produto,
        quantidade,
        bonificada,
        receita,
        royalties: Number(l.royalties ?? 0),
        // Dois preços médios: o que o comercial acha que pratica, e o que a
        // bonificada de fato deixou. A diferença é o custo da geração de demanda.
        precoMedioCobrado: cobrada > 0 ? receita / cobrada : 0,
        precoMedioEfetivo: quantidade > 0 ? receita / quantidade : 0,
      };
    });
  });
}

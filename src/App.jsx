import { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { EVENTO_ID, supabase } from './lib/supabaseClient';

const BluetoothPrinter = registerPlugin('BluetoothPrinter');
const APP_NATIVO = Capacitor.isNativePlatform();

// converte o payload ESC/POS (1 caractere = 1 byte) para base64, pra enviar ao plugin nativo
function escposParaBase64(texto) {
  let bin = '';
  for (let i = 0; i < texto.length; i += 1) bin += String.fromCharCode(texto.charCodeAt(i) & 0xff);
  return btoa(bin);
}

const CATEGORIAS_FIXAS = ['Salgados', 'Doces', 'Bebidas', 'Brincadeiras', 'Geral'];

const moeda = (valor) =>
  Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function ePromo(linhaProduto, produtos) {
  const produto = produtos.find((p) => p.nome === linhaProduto.nome);
  if (!produto) return false;
  return Number(linhaProduto.precoUnit).toFixed(2) !== Number(produto.preco).toFixed(2);
}

function fiadoPorPessoa(vendas) {
  const grupos = vendas
    .filter((v) => v.status !== 'cancelada' && v.forma_pagamento === 'Fiado')
    .reduce((acc, v) => {
      const chave = v.pessoa_fiado || 'Sem nome';
      if (!acc[chave]) acc[chave] = { nome: chave, qtdVendas: 0, total: 0, vendas: [] };
      acc[chave].qtdVendas += 1;
      acc[chave].total += Number(v.total || 0);
      acc[chave].vendas.push(v);
      return acc;
    }, {});
  return Object.values(grupos).sort((a, b) => b.total - a.total);
}

function totalPorCaixa(vendas, caixas) {
  const validas = vendas.filter((v) => v.status !== 'cancelada');
  return caixas.map((c) => {
    const doCaixa = validas.filter((v) => v.caixa_id === c.id);
    const fichas = doCaixa.reduce((s, v) => s + (v.itens || []).reduce((a, i) => a + Number(i.quantidade || 0), 0), 0);
    return {
      nome: c.nome,
      operador: c.operador || '-',
      vendas: doCaixa.length,
      fichas,
      total: doCaixa.reduce((s, v) => s + Number(v.total || 0), 0),
    };
  }).sort((a, b) => b.total - a.total);
}

const numero = (n) => String(n || 0).padStart(3, '0');
const ficha = (n) => String(n || 0).padStart(4, '0');
const normalizarNumero = (valor) => {
  if (typeof valor === 'number') return valor;
  if (!valor) return 0;
  return Number(String(valor).replace(',', '.')) || 0;
};

// Busca TODAS as linhas em blocos — o Supabase corta em ~1000 por consulta.
// `monta(de, ate)` deve devolver a query já com .range(de, ate).
async function buscarTudo(monta, tamanho = 1000) {
  let de = 0;
  let todos = [];
  for (;;) {
    const { data, error } = await monta(de, de + tamanho - 1);
    if (error) throw error;
    const bloco = data || [];
    todos = todos.concat(bloco);
    if (bloco.length < tamanho) break;
    de += tamanho;
  }
  return todos;
}

const hojeBR = () =>
  new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

const formas = ['Pix', 'Dinheiro', 'Débito', 'Crédito', 'Fiado', 'Cortesia'];

const AGENDO_LOGO = '/agendo-logo.png';
const AGENDO_TEXTO = '/agendo-texto.png';
const CAPETTE_LOGO = '/logo.png';
const MENU_ICONS = {
  painel: 'layout-dashboard',
  vender: 'ticket',
  produtos: 'packages',
  vendas: 'list-details',
  fechamento: 'checkup-list',
  movimentacoes: 'arrows-exchange',
  relatorios: 'report-analytics',
  dados: 'building-community',
  impressora: 'printer',
  caixas: 'users-group',
  fiado: 'users',
  backup: 'database-export',
  config: 'settings',
  'minhas-vendas': 'receipt-2',
  caixasfin: 'cash-register',
  'meu-caixa': 'wallet',
};

export default function App() {
  const [pagina, setPagina] = useState('painel');
  const [evento, setEvento] = useState(null);
  const [produtos, setProdutos] = useState([]);
  const [caixas, setCaixas] = useState([]);
  const [fiadoPessoas, setFiadoPessoas] = useState([]);
  const [novaPessoaFiado, setNovaPessoaFiado] = useState('');
  const [pessoaFiadoSelecionada, setPessoaFiadoSelecionada] = useState('');
  const [vendas, setVendas] = useState([]);
  const [movimentacoes, setMovimentacoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [mensagem, setMensagem] = useState('');
  const [erro, setErro] = useState('');

  const [usuario, setUsuario] = useState(null);
  const [authCarregando, setAuthCarregando] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginSenha, setLoginSenha] = useState('');
  const [loginErro, setLoginErro] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [recuperacaoMsg, setRecuperacaoMsg] = useState('');

  const [novoProduto, setNovoProduto] = useState({ nome: '', preco: '', estoque: '', categoria: '' });
  const [movimento, setMovimento] = useState({ tipo: 'Reforço', valor: '', motivo: '' });
  const [carrinho, setCarrinho] = useState([]);
  const [pagamento, setPagamento] = useState('Pix');
  const [valorRecebido, setValorRecebido] = useState('');
  const [salvandoVenda, setSalvandoVenda] = useState(false);
  const [vendaImpressaoId, setVendaImpressaoId] = useState(null);
  const [vendaImpressaoDireta, setVendaImpressaoDireta] = useState(null);
  const [vendaConcluida, setVendaConcluida] = useState(null);

  const [colapsado, setColapsado] = useState(() => localStorage.getItem('agendo_eventos_menu_colapsado') === '1');
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1000);
  const [online, setOnline] = useState(() => typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [menuAberto, setMenuAberto] = useState(false);
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [termoBusca, setTermoBusca] = useState('');
  const [secFechadas, setSecFechadas] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('agendo_eventos_sec_fechadas') || '["Configurações"]')); }
    catch { return new Set(['Configurações']); }
  });
  const [modoAcesso, setModoAcesso] = useState(() => localStorage.getItem('agendo_eventos_modo') || 'principal');
  const [acessoConfirmado, setAcessoConfirmado] = useState(() => localStorage.getItem('agendo_eventos_acesso_confirmado') === 'sim');
  const [caixaSelecionadoId, setCaixaSelecionadoId] = useState(() => localStorage.getItem('agendo_eventos_caixa_id') || '');
  const [papelImpressao, setPapelImpressao] = useState(() => localStorage.getItem('agendo_eventos_papel') || '58');
  const [impressaoRawBT, setImpressaoRawBT] = useState(() => localStorage.getItem('agendo_eventos_rawbt') === '1');
  const [impressoraBt, setImpressoraBt] = useState(() => localStorage.getItem('agendo_eventos_impressora_bt') || '');
  const [impressoraBtNome, setImpressoraBtNome] = useState(() => localStorage.getItem('agendo_eventos_impressora_bt_nome') || '');
  const [impressorasBt, setImpressorasBt] = useState([]);
  const recargaRef = useRef(null);
  const [fundoAbertura, setFundoAbertura] = useState('');
  const [eventoForm, setEventoForm] = useState({ nome: '', instituicao: '', local_evento: '', data_evento: '', sorteio_valor_por_numero: '' });
  const [novoCaixa, setNovoCaixa] = useState({ nome: '', operador: '', tipo: 'secundario' });

  async function carregarTudo() {
    setErro('');
    try {
      const { data: eventoData, error: eventoError } = await supabase
        .from('eventos')
        .select('*')
        .eq('id', EVENTO_ID)
        .maybeSingle();
      if (eventoError) throw eventoError;
      setEvento(eventoData);

      const { data: produtosData, error: produtosError } = await supabase
        .from('produtos')
        .select('*')
        .eq('evento_id', EVENTO_ID)
        .order('nome', { ascending: true });
      if (produtosError) throw produtosError;
      setProdutos(produtosData || []);

      const { data: caixasData, error: caixasError } = await supabase
        .from('caixas')
        .select('*')
        .eq('evento_id', EVENTO_ID)
        .order('nome', { ascending: true });
      if (caixasError) throw caixasError;
      setCaixas(caixasData || []);

      const { data: fiadoData, error: fiadoError } = await supabase
        .from('fiado_pessoas')
        .select('*')
        .eq('evento_id', EVENTO_ID)
        .order('nome', { ascending: true });
      if (fiadoError) throw fiadoError;
      setFiadoPessoas(fiadoData || []);

      await carregarVendas(caixasData || []);
      await carregarMovimentacoes(caixasData || []);
    } catch (e) {
      setErro(e.message || 'Erro ao carregar dados do Supabase.');
    } finally {
      setCarregando(false);
    }
  }

  async function carregarVendas(caixasBase = caixas) {
    try {
      // caminho normal: pagina as vendas com itens/sorteio embutidos (sem teto de 1000)
      const data = await buscarTudo((de, ate) => supabase
        .from('vendas')
        .select('*, caixa:caixas(id,nome,operador), itens:venda_itens(*), sorteio:sorteio_numeros(numero)')
        .eq('evento_id', EVENTO_ID)
        .order('criada_em', { ascending: false })
        .range(de, ate));
      setVendas(data);
      return;
    } catch {
      // fallback (ex.: sorteio_numeros ainda não existe): pagina o básico + itens em lotes
      const vendasBase = await buscarTudo((de, ate) => supabase
        .from('vendas').select('*').eq('evento_id', EVENTO_ID).order('criada_em', { ascending: false }).range(de, ate));
      const ids = vendasBase.map((v) => v.id);
      let itens = [];
      for (let i = 0; i < ids.length; i += 200) {
        const lote = ids.slice(i, i + 200);
        const parte = await buscarTudo((de, ate) => supabase.from('venda_itens').select('*').in('venda_id', lote).range(de, ate));
        itens = itens.concat(parte);
      }
      setVendas(vendasBase.map((v) => ({
        ...v,
        caixa: caixasBase.find((c) => c.id === v.caixa_id) || null,
        itens: itens.filter((it) => it.venda_id === v.id),
      })));
    }
  }

  async function carregarMovimentacoes(caixasBase = caixas) {
    const data = await buscarTudo((de, ate) => supabase
      .from('movimentacoes_caixa')
      .select('*')
      .eq('evento_id', EVENTO_ID)
      .order('criada_em', { ascending: false })
      .range(de, ate));
    setMovimentacoes(data.map((m) => ({
      ...m,
      caixa: caixasBase.find((c) => c.id === m.caixa_id) || null,
    })));
  }

  // Debounce: em vez de recarregar tudo a cada venda, junta as mudanças e recarrega
  // no máximo a cada 1,5s — bem mais leve com vários caixas vendendo ao mesmo tempo.
  function agendarRecarga() {
    if (recargaRef.current) clearTimeout(recargaRef.current);
    recargaRef.current = setTimeout(() => { carregarTudo(); }, 1500);
  }

  useEffect(() => {
    let ativo = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!ativo) return;
      setUsuario(data.session?.user || null);
      setAuthCarregando(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUsuario(session?.user || null);
      if (!session?.user) {
        setAcessoConfirmado(false);
        localStorage.removeItem('agendo_eventos_acesso_confirmado');
      }
    });

    return () => {
      ativo = false;
      listener?.subscription?.unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!usuario) {
      setCarregando(false);
      return;
    }

    setCarregando(true);
    carregarTudo();

    const canal = supabase
      .channel('agendo-eventos-principal')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vendas', filter: `evento_id=eq.${EVENTO_ID}` }, agendarRecarga)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'produtos', filter: `evento_id=eq.${EVENTO_ID}` }, agendarRecarga)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'caixas', filter: `evento_id=eq.${EVENTO_ID}` }, agendarRecarga)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'movimentacoes_caixa', filter: `evento_id=eq.${EVENTO_ID}` }, agendarRecarga)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sorteio_numeros', filter: `evento_id=eq.${EVENTO_ID}` }, agendarRecarga)
      .subscribe();

    return () => supabase.removeChannel(canal);
  }, [usuario?.id]);

  useEffect(() => {
    localStorage.setItem('agendo_eventos_modo', modoAcesso);
  }, [modoAcesso]);

  useEffect(() => {
    if (acessoConfirmado) {
      localStorage.setItem('agendo_eventos_acesso_confirmado', 'sim');
    } else {
      localStorage.removeItem('agendo_eventos_acesso_confirmado');
    }
  }, [acessoConfirmado]);

  useEffect(() => {
    localStorage.setItem('agendo_eventos_caixa_id', caixaSelecionadoId || '');
  }, [caixaSelecionadoId]);

  useEffect(() => {
    localStorage.setItem('agendo_eventos_papel', papelImpressao);
  }, [papelImpressao]);

  useEffect(() => {
    localStorage.setItem('agendo_eventos_rawbt', impressaoRawBT ? '1' : '0');
  }, [impressaoRawBT]);

  useEffect(() => {
    if (!evento) return;
    setEventoForm({
      nome: evento.nome || '',
      instituicao: evento.instituicao || '',
      local_evento: evento.local_evento || '',
      data_evento: evento.data_evento || '',
      sorteio_valor_por_numero: evento.sorteio_valor_por_numero ?? 10,
    });
  }, [evento?.id, evento?.nome, evento?.instituicao, evento?.local_evento, evento?.data_evento, evento?.sorteio_valor_por_numero]);

  const vendasValidas = useMemo(
    () => vendas.filter((v) => v.status !== 'cancelada'),
    [vendas]
  );

  const resumo = useMemo(() => {
    const totalVendido = vendasValidas.reduce((s, v) => s + Number(v.total || 0), 0);
    const totalCancelado = vendas.filter((v) => v.status === 'cancelada').reduce((s, v) => s + Number(v.total || 0), 0);
    const porForma = formas.reduce((acc, f) => ({ ...acc, [f]: 0 }), {});
    vendasValidas.forEach((v) => {
      porForma[v.forma_pagamento] = Number(porForma[v.forma_pagamento] || 0) + Number(v.total || 0);
    });

    const fichas = vendasValidas.reduce((s, v) =>
      s + (v.itens || []).reduce((a, i) => a + Number(i.quantidade || 0), 0), 0);

    const porProduto = {};
    vendasValidas.forEach((v) => {
      (v.itens || []).forEach((i) => {
        const precoUnit = Number(i.preco_unitario || 0);
        const chave = `${i.nome_produto}__${precoUnit.toFixed(2)}`;
        if (!porProduto[chave]) {
          porProduto[chave] = { nome: i.nome_produto, precoUnit, qtd: 0, valor: 0 };
        }
        porProduto[chave].qtd += Number(i.quantidade || 0);
        porProduto[chave].valor += Number(i.subtotal || 0);
      });
    });

    const reforcos = movimentacoes
      .filter((m) => m.tipo === 'Reforço')
      .reduce((s, m) => s + Number(m.valor || 0), 0);
    const sangrias = movimentacoes
      .filter((m) => m.tipo === 'Sangria')
      .reduce((s, m) => s + Number(m.valor || 0), 0);
    const dinheiroVendas = Number(porForma.Dinheiro || 0);
    const dinheiroEsperado = dinheiroVendas + reforcos - sangrias;
    const totalFiado = Number(porForma.Fiado || 0);
    const totalCortesia = Number(porForma.Cortesia || 0);

    return {
      totalVendido,
      totalCancelado,
      porForma,
      fichas,
      porProduto: Object.values(porProduto).sort((a, b) => b.valor - a.valor),
      reforcos,
      sangrias,
      dinheiroEsperado,
      dinheiroVendas,
      totalFiado,
      totalCortesia,
    };
  }, [vendas, vendasValidas, movimentacoes]);

  const estoqueTotal = produtos.reduce((s, p) => s + Number(p.estoque_atual || 0), 0);
  const produtosAtivos = produtos.filter((p) => p.ativo).length;
  const caixaFechado = evento?.status === 'fechado';
  const temCaixaPrincipalReal = caixas.some((c) => c.tipo === 'principal');
  const caixaPrincipal = caixas.find((c) => c.tipo === 'principal') || caixas[0] || null;
  const caixasAtivos = caixas.filter((c) => c.ativo !== false);
  const primeiroCaixaOperador = caixasAtivos.find((c) => c.tipo !== 'principal') || caixasAtivos[0] || caixaPrincipal;
  const caixaAtual = modoAcesso === 'principal'
    ? caixaPrincipal
    : (caixasAtivos.find((c) => c.id === caixaSelecionadoId) || primeiroCaixaOperador || caixaPrincipal);
  const finCaixaAtual = financeiroCaixa(caixaAtual);
  const caixaAbertoParaVenda = !!finCaixaAtual.aberto;
  const produtosVendaveis = produtos.filter((p) => p.ativo);
  const categoriasProduto = useMemo(() => {
    const set = new Set(produtosVendaveis.map((p) => p.categoria || 'Geral'));
    return ['Todas', ...CATEGORIAS_FIXAS.filter((c) => set.has(c))];
  }, [produtosVendaveis]);
  const [categoriaAtiva, setCategoriaAtiva] = useState('Todas');
  const produtosFiltrados = categoriaAtiva === 'Todas'
    ? produtosVendaveis
    : produtosVendaveis.filter((p) => (p.categoria || 'Geral') === categoriaAtiva);
  const vendasDaTela = modoAcesso === 'principal' ? vendas : vendas.filter((v) => v.caixa_id === caixaAtual?.id);
  const vendasValidasDaTela = vendasDaTela.filter((v) => v.status !== 'cancelada');
  const totalDaTela = vendasValidasDaTela.reduce((s, v) => s + Number(v.total || 0), 0);
  const fichasDaTela = vendasValidasDaTela.reduce((s, v) => s + (v.itens || []).reduce((a, i) => a + Number(i.quantidade || 0), 0), 0);
  const totalCarrinho = carrinho.reduce((s, item) => s + normalizarNumero(item.preco) * item.quantidade, 0);
  const qtdCarrinho = carrinho.reduce((s, item) => s + item.quantidade, 0);
  const troco = pagamento === 'Dinheiro' ? Math.max(normalizarNumero(valorRecebido) - totalCarrinho, 0) : 0;
  const podeFinalizarVenda = carrinho.length > 0 && caixaAtual && !caixaFechado && caixaAbertoParaVenda && !salvandoVenda
    && (pagamento !== 'Dinheiro' || normalizarNumero(valorRecebido) >= totalCarrinho)
    && (pagamento !== 'Fiado' || pessoaFiadoSelecionada);
  const papeisImpressao = {
    '58': { nome: '58mm / 57,5mm', largura: '58mm', descricao: 'Padrão para impressora térmica 58mm.' },
    '80': { nome: '80mm / 79,5mm', largura: '80mm', descricao: 'Mais largo, bom para recibos maiores.' },
    '110': { nome: '110mm', largura: '110mm', descricao: 'Uso especial, não recomendado para ficha simples.' },
  };
  const papelAtual = papeisImpressao[papelImpressao] || papeisImpressao['58'];
  const vendaParaImprimir = vendaImpressaoDireta || vendas.find((v) => v.id === vendaImpressaoId) || null;
  const fichasParaImprimir = [];
  if (vendaParaImprimir) {
    (vendaParaImprimir.itens || []).forEach((item) => {
      const inicio = Number(item.ficha_inicio || 0);
      const fim = Number(item.ficha_fim || inicio);
      for (let n = inicio; n <= fim; n += 1) {
        fichasParaImprimir.push({ numero: n, produto: item.nome_produto, valor: Number(item.preco_unitario || 0) });
      }
    });
  }
  const numerosSorteioImprimir = (vendaParaImprimir?.sorteio || [])
    .map((s) => Number(s.numero))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  function toggleColapsado() {
    setColapsado((v) => {
      localStorage.setItem('agendo_eventos_menu_colapsado', v ? '0' : '1');
      return !v;
    });
  }

  function toggleSec(nome) {
    setSecFechadas((prev) => {
      const novo = new Set(prev);
      novo.has(nome) ? novo.delete(nome) : novo.add(nome);
      localStorage.setItem('agendo_eventos_sec_fechadas', JSON.stringify([...novo]));
      return novo;
    });
  }
  const secVisivel = (nome) => colapsado || !secFechadas.has(nome);

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 1000);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setBuscaAberta((v) => !v);
        setTermoBusca('');
      }
      if (e.key === 'Escape') setBuscaAberta(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function aviso(texto) {
    setMensagem(texto);
    setTimeout(() => setMensagem(''), 3500);
  }


  function adicionarAoCarrinho(produto) {
    if (caixaFechado) return aviso('Evento fechado. Não é possível vender.');
    if (!caixaAbertoParaVenda) return aviso('Abra o caixa (informe o fundo de troco) antes de vender.');
    setErro('');
    setMensagem('');
    setCarrinho((atual) => {
      const existe = atual.find((item) => item.id === produto.id);
      const qtdAtual = existe ? existe.quantidade : 0;
      if (qtdAtual + 1 > produto.estoque_atual) {
        aviso(`Atenção: vendendo "${produto.nome}" sem estoque registrado.`);
      }
      if (existe) {
        return atual.map((item) => item.id === produto.id ? { ...item, quantidade: item.quantidade + 1 } : item);
      }
      // Usa o preço promocional quando a promoção está ativa, pra bater com o que o
      // servidor grava e com o que sai impresso na ficha (senão o caixa cobra cheio
      // e o sistema registra o promocional).
      const emPromo = produto.promocao_ativa && produto.preco_promocional != null;
      const precoVenda = emPromo ? Number(produto.preco_promocional || 0) : Number(produto.preco || 0);
      return [...atual, { id: produto.id, nome: produto.nome, preco: precoVenda, quantidade: 1 }];
    });
  }

  function removerDoCarrinho(produtoId) {
    setCarrinho((atual) => atual.map((item) => item.id === produtoId ? { ...item, quantidade: item.quantidade - 1 } : item).filter((item) => item.quantidade > 0));
  }

  function limparVendaPrincipal() {
    setCarrinho([]);
    setPagamento('Pix');
    setValorRecebido('');
    setPessoaFiadoSelecionada('');
    setErro('');
    setMensagem('');
  }

  function ehAndroid() {
    return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
  }

  function paraTextoTermico(texto) {
    return String(texto || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos (á->a, ç->c, etc.)
      .replace(/\u00a0/g, ' ')   // espaço "não-quebra-linha" -> espaço normal
      .replace(/[^\x00-\x7F]/g, ''); // remove qualquer outro caractere fora do padrão ASCII (evita lixo na térmica)
  }

  function montarFichaEscPos(item, vendaRef) {
    const ESC = '\x1B';
    const GS = '\x1D';
    const nomeCaixa = paraTextoTermico(vendaRef?.caixa?.nome || caixaAtual?.nome || caixaPrincipal?.nome || 'Caixa');
    const numeroVenda = numero(vendaRef?.numero);
    const tituloFicha = paraTextoTermico(evento?.nome || 'Evento');   // topo = nome do evento (editável)
    const instituicao = paraTextoTermico(evento?.instituicao || '');
    const linha = '--------------------------------';
    let cmd = '';
    cmd += ESC + '@';                 // inicializa impressora
    cmd += ESC + 'a' + '\x01';        // centraliza tudo
    cmd += `${linha}\n`;              // marca de início da ficha
    cmd += GS + '!' + '\x00';         // tamanho normal
    cmd += ESC + 'E' + '\x01';        // negrito on
    cmd += `${tituloFicha}\n`;        // nome do evento
    cmd += ESC + 'E' + '\x00';        // negrito off
    if (instituicao) cmd += `${instituicao}\n`;
    cmd += GS + '!' + '\x11';         // dobro altura+largura
    cmd += ESC + 'E' + '\x01';        // negrito on
    cmd += `${paraTextoTermico(item.produto)}\n`.toUpperCase();
    cmd += GS + '!' + '\x01';         // dobro altura só (valor)
    cmd += `${paraTextoTermico(moeda(item.valor))}\n`;
    cmd += ESC + 'E' + '\x00';        // negrito off
    cmd += GS + '!' + '\x00';         // tamanho normal
    cmd += `${nomeCaixa} - Venda ${numeroVenda}\n`;
    cmd += 'AGENDO EVENTOS\n';        // marca (rodape)
    cmd += `${linha}\n`;              // marca de fim da ficha
    cmd += '\n\n\n';                  // espaço pra rasgar (bem menor)
    cmd += GS + 'V' + '\x00';         // corta papel
    return cmd;
  }

  function montarFichasDeVenda(vendaRef) {
    const itens = [];
    (vendaRef?.itens || []).forEach((item) => {
      const inicio = Number(item.ficha_inicio || 0);
      const fim = Number(item.ficha_fim || inicio);
      for (let n = inicio; n <= fim; n += 1) {
        itens.push({ numero: n, produto: item.nome_produto, valor: Number(item.preco_unitario || 0) });
      }
    });
    return itens;
  }

  function numerosSorteioDaVenda(vendaRef) {
    return (vendaRef?.sorteio || [])
      .map((s) => Number(s.numero))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }

  function montarCupomSorteioEscPos(numeros, vendaRef) {
    if (!numeros || !numeros.length) return '';
    const ESC = '\x1B';
    const GS = '\x1D';
    const nomeCaixa = paraTextoTermico(vendaRef?.caixa?.nome || caixaAtual?.nome || caixaPrincipal?.nome || 'Caixa');
    const numeroVenda = numero(vendaRef?.numero);
    const linha = '--------------------------------';
    let cmd = '';
    cmd += ESC + '@';                 // inicializa
    cmd += ESC + 'a' + '\x01';        // centraliza
    cmd += `${linha}\n`;              // início do cupom
    cmd += GS + '!' + '\x01';         // dobro de altura
    cmd += ESC + 'E' + '\x01';        // negrito
    cmd += 'CUPOM DE SORTEIO\n';
    cmd += ESC + 'E' + '\x00';
    cmd += GS + '!' + '\x00';         // tamanho normal
    cmd += 'Guarde para o sorteio!\n';
    cmd += GS + '!' + '\x11';         // dobro altura+largura
    cmd += ESC + 'E' + '\x01';        // negrito
    numeros.forEach((n) => { cmd += `${ficha(n)}\n`; });
    cmd += ESC + 'E' + '\x00';
    cmd += GS + '!' + '\x00';
    cmd += `${paraTextoTermico(evento?.nome || 'Evento')}\n`;
    cmd += `${nomeCaixa} - Venda ${numeroVenda}\n`;
    cmd += 'AGENDO EVENTOS\n';        // marca (rodape)
    cmd += `${linha}\n`;              // fim do cupom
    cmd += '\n\n\n';                  // espaço pra rasgar (bem menor)
    cmd += GS + 'V' + '\x00';         // corta papel
    return cmd;
  }

  function payloadEscPos(vendaRef) {
    const fichas = montarFichasDeVenda(vendaRef);
    const numeros = numerosSorteioDaVenda(vendaRef);
    if (!fichas.length && !numeros.length) return '';
    let payload = fichas.map((item) => montarFichaEscPos(item, vendaRef)).join('');
    payload += montarCupomSorteioEscPos(numeros, vendaRef);
    return payload;
  }

  function imprimirViaRawBT(vendaRef) {
    const payload = payloadEscPos(vendaRef);
    if (!payload) return;
    const intentUrl = `intent:${encodeURI(payload)}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
    window.location.href = intentUrl;
  }

  // Impressão direta na impressora Bluetooth quando roda dentro do APK (sem RawBT, sem telinha).
  async function imprimirNativo(vendaRef) {
    const payload = payloadEscPos(vendaRef);
    if (!payload) return;
    if (!impressoraBt) {
      setErro('Escolha a impressora Bluetooth em "Config. impressora" antes de imprimir.');
      setPagina('impressora');
      return;
    }
    try {
      await BluetoothPrinter.connect({ address: impressoraBt });
      await BluetoothPrinter.write({ data: escposParaBase64(payload) });
      // Não fecha o socket aqui de propósito: fechar logo após o envio pode cortar
      // a impressão no meio. A próxima impressão reconecta (o plugin fecha o antigo).
    } catch (e) {
      setErro(`Não consegui imprimir na Bluetooth: ${e?.message || e}. Confira se a impressora está ligada e pareada.`);
    }
  }

  async function listarImpressorasBt() {
    setErro('');
    try {
      const res = await BluetoothPrinter.list();
      const devs = res?.devices || [];
      setImpressorasBt(devs);
      if (!devs.length) aviso('Nenhuma impressora pareada encontrada. Pareie a impressora no Bluetooth do celular primeiro.');
    } catch (e) {
      setErro(`Não consegui listar as impressoras: ${e?.message || e}`);
    }
  }

  function selecionarImpressoraBt(d) {
    setImpressoraBt(d.address);
    setImpressoraBtNome(d.name || d.address);
    localStorage.setItem('agendo_eventos_impressora_bt', d.address);
    localStorage.setItem('agendo_eventos_impressora_bt_nome', d.name || d.address);
    aviso(`Impressora "${d.name || d.address}" escolhida.`);
  }

  async function testarImpressaoBt() {
    if (!impressoraBt) { setErro('Escolha a impressora primeiro.'); return; }
    setErro('');
    const ESC = '\x1B'; const GS = '\x1D';
    const teste = ESC + '@' + ESC + 'a' + '\x01'
      + ESC + 'E' + '\x01' + 'AGENDO EVENTOS\n' + ESC + 'E' + '\x00'
      + 'Teste de impressao\n' + paraTextoTermico(hojeBR()) + '\n\n\n\n' + GS + 'V' + '\x00';
    try {
      await BluetoothPrinter.connect({ address: impressoraBt });
      await BluetoothPrinter.write({ data: escposParaBase64(teste) });
      aviso('Teste enviado! Saiu na impressora?');
    } catch (e) {
      setErro(`Falha no teste: ${e?.message || e}`);
    }
  }

  function abrirImpressaoFichas(vendaRef) {
    const ref = vendaRef || vendaParaImprimir;
    if (APP_NATIVO && impressoraBt) {
      imprimirNativo(ref);
      return;
    }
    if (ehAndroid() && impressaoRawBT) {
      imprimirViaRawBT(ref);
      return;
    }
    document.body.classList.remove('imprimindo-relatorio');
    document.body.classList.add('imprimindo-fichas');
    const limparModo = () => document.body.classList.remove('imprimindo-fichas');
    window.addEventListener('afterprint', limparModo, { once: true });
    setTimeout(() => window.print(), 250);
  }

  async function buscarVendaParaImpressao(vendaId) {
    // Garante que os números do sorteio já foram emitidos (a cada R$10 = 1 número).
    // É idempotente no servidor: chamar de novo numa reimpressão não gera número extra,
    // só devolve os que já existem — então a reimpressão também "conserta" venda sem número.
    try { await supabase.rpc('emitir_numeros_sorteio', { p_venda_id: vendaId }); }
    catch { /* não bloqueia a impressão da venda */ }

    const { data, error } = await supabase
      .from('vendas')
      .select('*, caixa:caixas(id,nome,operador), itens:venda_itens(*)')
      .eq('id', vendaId)
      .maybeSingle();

    if (error) throw error;

    let sorteio = [];
    try {
      const { data: numeros } = await supabase
        .from('sorteio_numeros')
        .select('numero')
        .eq('venda_id', vendaId)
        .order('numero', { ascending: true });
      sorteio = numeros || [];
    } catch { /* tabela pode não existir ainda; segue sem cupom de sorteio */ }

    return { ...(data || {}), sorteio };
  }

  async function finalizarVendaPrincipal() {
    if (!podeFinalizarVenda) return;
    try {
      setSalvandoVenda(true);
      setErro('');
      setMensagem('');

      const itens = carrinho.map((item) => ({ produto_id: item.id, quantidade: item.quantidade }));
      const { data, error } = await supabase.rpc('finalizar_venda_evento', {
        p_evento_id: EVENTO_ID,
        p_caixa_id: caixaAtual.id,
        p_forma_pagamento: pagamento,
        p_valor_recebido: pagamento === 'Dinheiro' ? normalizarNumero(valorRecebido) : null,
        p_itens: itens,
        p_pessoa_fiado: pagamento === 'Fiado' ? pessoaFiadoSelecionada : null,
      });

      if (error) throw error;
      const resultado = Array.isArray(data) ? data[0] : data;
      const vendaId = resultado?.venda_id || null;
      let vendaCompleta = null;

      if (vendaId) {
        vendaCompleta = await buscarVendaParaImpressao(vendaId);
        setVendaImpressaoDireta(vendaCompleta);
        setVendaImpressaoId(vendaId);
        // Não imprime automático: abre a confirmação com o botão "Imprimir".
        // O toque no botão é um gesto do usuário, então o navegador do celular
        // libera a impressão (o print automático depois do await era bloqueado).
        setVendaConcluida(vendaCompleta);
      }

      const qtdSorteio = (vendaCompleta?.sorteio || []).length;
      const avisoSorteio = qtdSorteio > 0 ? ` Cupom de sorteio: ${qtdSorteio} número(s).` : '';
      setMensagem(`Venda ${numero(resultado?.numero)} finalizada.${avisoSorteio}`);
      setCarrinho([]);
      setPagamento('Pix');
      setValorRecebido('');
      setPessoaFiadoSelecionada('');
      await carregarTudo();
    } catch (e) {
      setErro(e.message || 'Erro ao finalizar venda.');
    } finally {
      setSalvandoVenda(false);
    }
  }

  async function imprimirVenda(vendaId) {
    try {
      setErro('');
      const vendaCompleta = await buscarVendaParaImpressao(vendaId);
      setVendaImpressaoDireta(vendaCompleta);
      setVendaImpressaoId(vendaId);
      abrirImpressaoFichas(vendaCompleta);
    } catch (e) {
      setErro(e.message || 'Erro ao preparar impressão da venda.');
    }
  }

  async function adicionarProduto(e) {
    e.preventDefault();
    if (caixaFechado) return aviso('Evento fechado. Não é possível alterar produtos.');
    const nome = novoProduto.nome.trim();
    const preco = Number(String(novoProduto.preco).replace(',', '.'));
    const estoque = Number(novoProduto.estoque || 0);
    if (!nome || !preco) return aviso('Informe nome e preço.');

    const { data, error } = await supabase.from('produtos').insert({
      evento_id: EVENTO_ID,
      nome,
      preco,
      estoque_inicial: estoque,
      estoque_atual: estoque,
      categoria: novoProduto.categoria.trim() || 'Geral',
      ativo: true,
    }).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Produto não foi salvo (possível bloqueio de permissão). Tente novamente.');
    setNovoProduto({ nome: '', preco: '', estoque: '', categoria: '' });
    aviso(`Produto "${nome}" adicionado.`);
    carregarTudo();
  }

  async function atualizarProduto(id, campo, valor) {
    if (caixaFechado) return aviso('Evento fechado. Não é possível alterar produtos.');
    const camposTexto = ['nome', 'categoria'];
    const payload = { [campo]: valor === null ? null : camposTexto.includes(campo) ? valor : Number(String(valor).replace(',', '.')) };
    const { data, error } = await supabase.from('produtos').update(payload).eq('id', id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('A alteração não foi salva (possível bloqueio de permissão). Tente novamente.');
    carregarTudo();
  }

  async function alternarProduto(produto) {
    if (caixaFechado) return aviso('Evento fechado. Não é possível alterar produtos.');
    const { data, error } = await supabase.from('produtos').update({ ativo: !produto.ativo }).eq('id', produto.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('A alteração não foi salva (possível bloqueio de permissão).');
    aviso(produto.ativo ? 'Produto desativado.' : 'Produto ativado.');
    carregarTudo();
  }

  async function alternarPromocao(produto) {
    if (caixaFechado) return aviso('Evento fechado. Não é possível alterar produtos.');
    if (!produto.preco_promocional && !produto.promocao_ativa) return aviso('Defina o preço promocional antes de ativar.');
    const { data, error } = await supabase.from('produtos').update({ promocao_ativa: !produto.promocao_ativa }).eq('id', produto.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('A alteração não foi salva (possível bloqueio de permissão).');
    aviso(produto.promocao_ativa ? `Promoção de "${produto.nome}" desativada.` : `Promoção de "${produto.nome}" ativada!`);
    carregarTudo();
  }

  async function registrarMovimentacao(e) {
    e.preventDefault();
    if (caixaFechado) return aviso('Evento fechado. Não é possível registrar movimentação.');
    const valor = Number(String(movimento.valor).replace(',', '.'));
    if (!valor || valor <= 0) return aviso('Informe o valor.');

    const { data, error } = await supabase.rpc('registrar_movimentacao_evento', {
      p_evento_id: EVENTO_ID,
      p_caixa_id: caixaAtual?.id || null,
      p_tipo: movimento.tipo,
      p_valor: valor,
      p_motivo: movimento.motivo || null,
      p_operador: caixaAtual?.operador || caixaAtual?.nome || 'Caixa',
    });

    if (error) return setErro(error.message);
    if (data === null || data === undefined) return setErro('Movimentação não confirmada pelo servidor. Verifique antes de continuar.');
    setMovimento({ tipo: 'Reforço', valor: '', motivo: '' });
    aviso('Movimentação registrada.');
    carregarTudo();
  }

  async function removerMovimentacao(id) {
    if (caixaFechado) return aviso('Evento fechado. Não é possível remover movimentação.');
    if (!confirm('Remover esta movimentação?')) return;
    const { data, error } = await supabase.from('movimentacoes_caixa').delete().eq('id', id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível remover (possível bloqueio de permissão).');
    carregarTudo();
  }

  async function fecharEvento() {
    if (!confirm('Fechar o caixa geral do evento? Isso trava alterações.')) return;

    const { data, error } = await supabase.rpc('fechar_evento_geral', {
      p_evento_id: EVENTO_ID,
      p_fechado_por: caixaPrincipal?.operador || 'Caixa Principal',
    });

    if (error) return setErro(error.message);
    if (data === null || data === undefined) return setErro('Fechamento não confirmado pelo servidor. Verifique antes de continuar.');
    aviso('Evento fechado.');
    carregarTudo();
  }

  async function reabrirEvento() {
    if (!confirm('Reabrir o evento? Use apenas para correção.')) return;
    const { data, error } = await supabase
      .from('eventos')
      .update({ status: 'aberto', fechado_em: null })
      .eq('id', EVENTO_ID)
      .select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Reabertura não foi salva (possível bloqueio de permissão).');
    aviso('Evento reaberto.');
    carregarTudo();
  }

  async function marcarImpressa(venda) {
    const { error } = await supabase.rpc('marcar_venda_impressa', {
      p_venda_id: venda.id,
      p_impresso: true,
    });
    if (error) return setErro(error.message);
    aviso('Venda marcada como impressa.');
    carregarTudo();
  }

  async function cancelarVenda(venda) {
    if (caixaFechado) return aviso('Evento fechado. Não é possível cancelar venda.');
    if (venda.status === 'cancelada') return aviso('Venda já cancelada.');
    const motivo = prompt(`Motivo do cancelamento da venda ${numero(venda.numero)}:`);
    if (motivo === null) return;

    const { error } = await supabase.rpc('cancelar_venda_evento', {
      p_venda_id: venda.id,
      p_motivo: motivo,
    });

    if (error) return setErro(error.message);
    aviso(`Venda ${numero(venda.numero)} cancelada. Estoque devolvido.`);
    carregarTudo();
  }

  async function marcarFiadoRecebido(venda) {
    const opcoes = ['Pix', 'Dinheiro', 'Débito', 'Crédito'];
    const resposta = prompt(`Como a venda ${numero(venda.numero)} foi paga agora? Digite: ${opcoes.join(', ')}`);
    if (!resposta) return;
    const formaEscolhida = opcoes.find((o) => o.toLowerCase() === resposta.trim().toLowerCase());
    if (!formaEscolhida) return aviso('Forma de pagamento não reconhecida. Tente de novo digitando exatamente uma das opções.');
    const { data, error } = await supabase.from('vendas').update({ forma_pagamento: formaEscolhida }).eq('id', venda.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível atualizar (possível bloqueio de permissão).');
    aviso(`Venda ${numero(venda.numero)} marcada como recebida via ${formaEscolhida}.`);
    carregarTudo();
  }

  async function adicionarPessoaFiado(e) {
    e.preventDefault();
    const nome = novaPessoaFiado.trim();
    if (!nome) return aviso('Digite o nome da pessoa.');
    const { data, error } = await supabase.from('fiado_pessoas').insert({ evento_id: EVENTO_ID, nome, ativo: true }).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível salvar (possível bloqueio de permissão).');
    setNovaPessoaFiado('');
    aviso(`"${nome}" cadastrado(a) para fiado.`);
    carregarTudo();
  }

  async function alternarPessoaFiado(pessoa) {
    const { data, error } = await supabase.from('fiado_pessoas').update({ ativo: !pessoa.ativo }).eq('id', pessoa.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível atualizar (possível bloqueio de permissão).');
    carregarTudo();
  }

  async function alternarMeuCaixa() {
    if (!caixaAtual) return;
    const fechando = caixaAtual.ativo !== false;
    if (fechando && !confirm(`Fechar o ${caixaAtual.nome}? Ele vai parar de aparecer na tela de acesso até ser reaberto.`)) return;
    const { data, error } = await supabase.from('caixas').update({ ativo: !fechando }).eq('id', caixaAtual.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível atualizar (possível bloqueio de permissão).');
    aviso(fechando ? `${caixaAtual.nome} fechado.` : `${caixaAtual.nome} reaberto.`);
    carregarTudo();
  }

  function imprimirRelatorio() {
    document.body.classList.remove('imprimindo-fichas');
    document.body.classList.add('imprimindo-relatorio');
    const limparModo = () => document.body.classList.remove('imprimindo-relatorio');
    window.addEventListener('afterprint', limparModo, { once: true });
    setMensagem('Na janela de impressão, escolha Salvar como PDF em A4.');
    setTimeout(() => window.print(), 150);
  }

  function exportarCsv() {
    const linhas = [
      ['Venda', 'Data', 'Caixa', 'Operador', 'Pagamento', 'Status', 'Total', 'Itens'].join(';'),
      ...vendas.map((v) => [
        numero(v.numero),
        new Date(v.criada_em).toLocaleString('pt-BR'),
        v.caixa?.nome || '',
        v.caixa?.operador || '',
        v.forma_pagamento,
        v.status,
        String(Number(v.total || 0)).replace('.', ','),
        (v.itens || []).map((i) => `${i.quantidade}x ${i.nome_produto}`).join(' | '),
      ].join(';')),
    ].join('\n');

    const blob = new Blob([linhas], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vendas-agendo-eventos-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }



  async function fazerLogin(e) {
    e.preventDefault();
    setLoginErro('');
    setRecuperacaoMsg('');
    setLoginLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail.trim(),
      password: loginSenha,
    });

    if (error) {
      setLoginErro('E-mail ou senha incorretos.');
    }

    setLoginLoading(false);
  }

  async function recuperarSenha() {
    setLoginErro('');
    setRecuperacaoMsg('');
    if (!loginEmail.trim()) {
      setLoginErro('Informe o e-mail no campo acima para recuperar a senha.');
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(loginEmail.trim(), {
      redirectTo: window.location.origin,
    });

    if (error) setLoginErro('Não foi possível enviar a recuperação de senha.');
    else setRecuperacaoMsg('E-mail de recuperação enviado. Verifique a caixa de entrada.');
  }

  async function sairSistema() {
    setAcessoConfirmado(false);
    setModoAcesso('principal');
    setCaixaSelecionadoId('');
    limparVendaPrincipal();
    await supabase.auth.signOut();
  }

  function entrarComoPrincipal() {
    setModoAcesso('principal');
    setCaixaSelecionadoId('');
    setAcessoConfirmado(true);
    setPagina('painel');
    limparVendaPrincipal();
  }

  function entrarComoCaixa(caixaId) {
    const escolhido = caixasAtivos.find((c) => c.id === caixaId) || primeiroCaixaOperador;
    setModoAcesso('caixa');
    if (escolhido?.id) setCaixaSelecionadoId(escolhido.id);
    setAcessoConfirmado(true);
    setPagina('vender');
    limparVendaPrincipal();
  }

  function sairAcesso() {
    setAcessoConfirmado(false);
    setPagina('vender');
    limparVendaPrincipal();
  }


  async function salvarDadosEvento(e) {
    e.preventDefault();
    const payload = {
      nome: eventoForm.nome.trim() || 'Evento',
      instituicao: eventoForm.instituicao.trim() || 'Instituição',
      local_evento: eventoForm.local_evento.trim() || null,
      data_evento: eventoForm.data_evento || null,
      sorteio_valor_por_numero: Math.max(0, Number(String(eventoForm.sorteio_valor_por_numero).replace(',', '.')) || 0),
    };
    const { data, error } = await supabase.from('eventos').update(payload).eq('id', EVENTO_ID).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Dados não foram salvos (possível bloqueio de permissão).');
    aviso('Dados do evento salvos.');
    carregarTudo();
  }

  async function atualizarCaixa(id, campo, valor) {
    const payload = { [campo]: campo === 'ativo' ? Boolean(valor) : valor };
    const { data, error } = await supabase.from('caixas').update(payload).eq('id', id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('A alteração não foi salva (possível bloqueio de permissão). Tente novamente.');
    carregarTudo();
  }

  async function adicionarCaixa(e) {
    e.preventDefault();
    const nome = novoCaixa.nome.trim();
    if (!nome) return aviso('Informe o nome do caixa.');
    const { data, error } = await supabase.from('caixas').insert({
      evento_id: EVENTO_ID,
      nome,
      operador: novoCaixa.operador.trim() || null,
      tipo: novoCaixa.tipo || 'secundario',
      ativo: true,
    }).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Caixa não foi salvo (possível bloqueio de permissão).');
    setNovoCaixa({ nome: '', operador: '', tipo: 'secundario' });
    aviso('Caixa adicionado.');
    carregarTudo();
  }

  // Resumo de dinheiro de um caixa (pra abertura/fechamento).
  function financeiroCaixa(caixa) {
    const cid = caixa?.id;
    const vendasDin = vendas
      .filter((v) => v.caixa_id === cid && v.status !== 'cancelada' && v.forma_pagamento === 'Dinheiro')
      .reduce((s, v) => s + Number(v.total || 0), 0);
    const reforcos = movimentacoes.filter((m) => m.caixa_id === cid && m.tipo === 'Reforço').reduce((s, m) => s + Number(m.valor || 0), 0);
    const sangrias = movimentacoes.filter((m) => m.caixa_id === cid && m.tipo === 'Sangria').reduce((s, m) => s + Number(m.valor || 0), 0);
    const fundo = Number(caixa?.fundo_troco || 0);
    const esperado = fundo + vendasDin + reforcos - sangrias;
    const contado = caixa?.valor_contado != null ? Number(caixa.valor_contado) : null;
    return {
      fundo, vendasDin, reforcos, sangrias, esperado, contado,
      diferenca: contado != null ? contado - esperado : null,
      aberto: !!caixa?.aberto_em && !caixa?.fechado_em,
      fechado: !!caixa?.fechado_em,
    };
  }

  async function abrirCaixaSessao(caixa, fundoStr) {
    const fundo = normalizarNumero(fundoStr);
    const { data, error } = await supabase.from('caixas')
      .update({ fundo_troco: fundo, aberto_em: new Date().toISOString(), valor_contado: null, fechado_em: null })
      .eq('id', caixa.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível abrir o caixa (rodou o SQL da abertura/fechamento?).');
    aviso(`${caixa.nome} aberto com fundo de ${moeda(fundo)}.`);
    carregarTudo();
  }

  async function fecharCaixaSessao(caixa, contadoStr) {
    const contado = normalizarNumero(contadoStr);
    const { data, error } = await supabase.from('caixas')
      .update({ valor_contado: contado, fechado_em: new Date().toISOString() })
      .eq('id', caixa.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível fechar o caixa.');
    aviso(`${caixa.nome} fechado.`);
    carregarTudo();
  }

  async function reabrirCaixaSessao(caixa) {
    if (!confirm(`Reabrir o ${caixa.nome} pra corrigir? Volta pro estado "aberto".`)) return;
    const { data, error } = await supabase.from('caixas')
      .update({ fechado_em: null, valor_contado: null })
      .eq('id', caixa.id).select();
    if (error) return setErro(error.message);
    if (!data || !data.length) return setErro('Não foi possível reabrir.');
    aviso(`${caixa.nome} reaberto.`);
    carregarTudo();
  }

  function exportarBackupJson() {
    const payload = {
      gerado_em: new Date().toISOString(),
      evento,
      produtos,
      caixas,
      vendas,
      movimentacoes,
      observacao: 'Backup de leitura do AGENDO Eventos. Para restaurar em produção, importar com acompanhamento técnico para evitar duplicidade.',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-agendo-eventos-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const [zerando, setZerando] = useState(false);
  async function zerarDadosTeste() {
    const resp = prompt('Isto APAGA todas as vendas, movimentações e números de sorteio deste evento (produtos e caixas continuam). Use só antes da festa começar.\n\nDigite ZERAR para confirmar:');
    if (resp === null) return;
    if (resp.trim().toUpperCase() !== 'ZERAR') return aviso('Cancelado — nada foi apagado.');
    try {
      setZerando(true);
      setErro('');
      const { error } = await supabase.rpc('zerar_dados_teste_evento', { p_evento_id: EVENTO_ID });
      if (error) throw error;
      aviso('Tudo zerado! Pode começar a festa do zero — o sorteio recomeça no nº 1.');
      await carregarTudo();
    } catch (e) {
      setErro(`Não consegui zerar: ${e.message || e}. (Rodou o SQL "2026-zerar-botao.sql" no Supabase?)`);
    } finally {
      setZerando(false);
    }
  }

  const menuPrincipalSecoes = [
    { titulo: 'Início', itens: [['painel', 'Painel geral']] },
    { titulo: 'Operação', itens: [['vender', 'Vender fichas'], ['vendas', 'Vendas realizadas'], ['produtos', 'Produtos e estoque']] },
    { titulo: 'Financeiro', itens: [['caixasfin', 'Abertura/fechamento de caixa'], ['fechamento', 'Fechamento do evento'], ['movimentacoes', 'Sangria / reforço'], ['fiado', 'Fiado (a receber)']] },
    { titulo: 'Relatórios', itens: [['relatorios', 'Relatórios e exportações']] },
    { titulo: 'Configurações', itens: [['dados', 'Dados do evento'], ['impressora', 'Impressora'], ['caixas', 'Caixas e operadores'], ['config', 'Sistema']] },
  ];
  const menuCaixaSecoes = [
    { titulo: 'Operação', itens: [['vender', 'Vender fichas'], ['minhas-vendas', 'Minhas vendas'], ['meu-caixa', 'Meu caixa']] },
    { titulo: 'Configurações', itens: [['impressora', 'Impressora']] },
  ];
  const menuSecoes = modoAcesso === 'principal' ? menuPrincipalSecoes : menuCaixaSecoes;
  const menu = menuSecoes.flatMap((sec) => sec.itens);
  const itensBusca = menu.map(([id, label]) => ({ id, label, icon: MENU_ICONS[id] || 'circle' }));
  const resultadosBusca = termoBusca
    ? itensBusca.filter((i) => i.label.toLowerCase().includes(termoBusca.toLowerCase()))
    : itensBusca.slice(0, 8);

  function irPara(id) {
    setBuscaAberta(false);
    setTermoBusca('');
    setPagina(id);
    setMenuAberto(false);
  }

  function fecharMenu() {
    if (isMobile) setMenuAberto(false);
  }

  useEffect(() => {
    if (!menu.some(([id]) => id === pagina)) {
      setPagina(menu[0]?.[0] || 'vender');
    }
  }, [modoAcesso, pagina]);

  if (authCarregando) {
    return <><style>{css}</style><div className="tela-carregando">Carregando AGENDO Eventos...</div></>;
  }

  if (!usuario) {
    return (
      <>
        <style>{css}</style>
        <TelaLogin
          email={loginEmail}
          senha={loginSenha}
          setEmail={setLoginEmail}
          setSenha={setLoginSenha}
          erro={loginErro}
          loading={loginLoading}
          recuperarSenha={recuperarSenha}
          recuperacaoMsg={recuperacaoMsg}
          onSubmit={fazerLogin}
        />
      </>
    );
  }

  if (carregando) {
    return <><style>{css}</style><div className="tela-carregando">Carregando AGENDO Eventos...</div></>;
  }

  if (!acessoConfirmado) {
    return (
      <>
        <style>{css}</style>
        <TelaAcesso
          evento={evento}
          caixas={caixasAtivos.filter((c) => c.tipo !== 'principal')}
          entrarComoPrincipal={entrarComoPrincipal}
          entrarComoCaixa={entrarComoCaixa}
          usuario={usuario}
          sairSistema={sairSistema}
        />
      </>
    );
  }

  const colapsadoEfetivo = colapsado && !isMobile;
  const sidebarMarkup = (
    <aside className="sidebar no-print">
      <div className="brand">
        {!colapsadoEfetivo && (
          <>
            <img className="brand-logo" src={AGENDO_LOGO} alt="AGENDO" />
            <div>
              <strong>AGENDO Eventos</strong>
              <span>Gestão integrada para eventos</span>
            </div>
          </>
        )}
        {colapsadoEfetivo && !isMobile && <img className="brand-logo" src={AGENDO_LOGO} alt="AGENDO" />}
        {!isMobile && (
          <button className="colapsar-btn" onClick={toggleColapsado} title={colapsadoEfetivo ? 'Expandir menu' : 'Recolher menu'}>
            <i className={`ti ti-layout-sidebar-left-${colapsadoEfetivo ? 'expand' : 'collapse'}`} />
          </button>
        )}
        {isMobile && (
          <button className="colapsar-btn" onClick={() => setMenuAberto(false)} title="Fechar menu">
            <i className="ti ti-x" />
          </button>
        )}
      </div>

      {!colapsadoEfetivo && (
        <div className="evento-card evento-oscard">
          <img src={CAPETTE_LOGO} alt={evento?.instituicao || 'Instituição'} />
          <small>EVENTO</small>
          <strong>{evento?.instituicao || 'CAPETTE'}</strong>
          <span>{evento?.nome || 'Festa Junina'}</span>
        </div>
      )}
      {!colapsadoEfetivo && (
        <div className="evento-card sessao-card">
          <small>ACESSO</small>
          <strong>{caixaAtual?.nome || (modoAcesso === 'principal' ? 'Caixa Principal' : 'Caixa')}</strong>
          <span>{modoAcesso === 'principal' ? 'Administração e vendas' : caixaAtual?.operador || 'Operador'}</span>
        </div>
      )}

      <nav className="sidebar-scroll">
        {menuSecoes.map((secao) => (
          <div className="nav-secao" key={secao.titulo}>
            <div
              className="nav-secao-titulo"
              onClick={colapsadoEfetivo ? undefined : () => toggleSec(secao.titulo)}
              style={{ cursor: colapsadoEfetivo ? 'default' : 'pointer' }}
            >
              {!colapsadoEfetivo && secao.titulo}
              {!colapsadoEfetivo && (
                <i className={`ti ti-chevron-${secVisivel(secao.titulo) ? 'down' : 'right'}`} />
              )}
            </div>
            {secVisivel(secao.titulo) && secao.itens.map(([id, label]) => (
              <button key={id} className={pagina === id ? 'ativo' : ''} title={colapsadoEfetivo ? label : undefined} onClick={() => { setPagina(id); fecharMenu(); }}>
                <i className={`ti ti-${MENU_ICONS[id] || 'circle'} nav-icone`} />
                {!colapsadoEfetivo && <span>{label}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="rodape-side">
        <div className="user-badge">{modoAcesso === 'principal' ? 'CP' : (caixaAtual?.nome || 'CX').slice(-2)}</div>
        {!colapsadoEfetivo && (
          <div className="user-info">
            <span>{modoAcesso === 'principal' ? 'Principal' : caixaAtual?.operador || 'Operador'}</span>
            <strong>{evento?.status === 'fechado' ? 'Fechado' : 'Aberto'}</strong>
          </div>
        )}
        {!colapsadoEfetivo && (
          <div className="side-actions">
            <button className="sair-acesso" onClick={sairAcesso} title="Trocar acesso"><i className="ti ti-replace" /></button>
            <button className="sair-acesso danger" onClick={sairSistema} title="Sair"><i className="ti ti-logout" /></button>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <>
      <style>{css}</style>
      <style>{cssImpressao(papelAtual.largura)}</style>
      <div className={`app-shell ${colapsado ? 'colapsado' : ''}`}>
        {buscaAberta && (
          <div className="busca-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) setBuscaAberta(false); }}>
            <div className="busca-modal">
              <div className="busca-input-linha">
                <i className="ti ti-search" />
                <input
                  autoFocus
                  value={termoBusca}
                  onChange={(e) => setTermoBusca(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && resultadosBusca[0]) irPara(resultadosBusca[0].id); }}
                  placeholder="Ir para... (digite o nome da tela)"
                />
                <span className="busca-esc">Esc</span>
              </div>
              <div className="busca-resultados">
                {resultadosBusca.length === 0 ? (
                  <div className="busca-vazio">Nenhuma tela encontrada.</div>
                ) : resultadosBusca.map((item) => (
                  <div key={item.id} className="busca-item" onClick={() => irPara(item.id)}>
                    <i className={`ti ti-${item.icon}`} />
                    {item.label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {vendaConcluida && (
          <div className="pos-venda-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) setVendaConcluida(null); }}>
            <div className="pos-venda-card">
              <div className="pos-venda-check"><i className="ti ti-check" /></div>
              <h2>Venda Nº {numero(vendaConcluida.numero)} concluída!</h2>
              <div className="pos-venda-total">{moeda(vendaConcluida.total)} · {vendaConcluida.forma_pagamento}</div>
              <div className="pos-venda-chips">
                <span className="pos-venda-chip"><i className="ti ti-ticket" /> {(vendaConcluida.itens || []).reduce((a, i) => a + Number(i.quantidade || 0), 0)} ficha(s)</span>
                {(vendaConcluida.sorteio || []).length > 0 && (
                  <span className="pos-venda-chip sorteio"><i className="ti ti-gift" /> Sorteio: {(vendaConcluida.sorteio || []).map((s) => ficha(s.numero)).join(', ')}</span>
                )}
              </div>
              <button className="botao verde pos-venda-imprimir" autoFocus onClick={() => abrirImpressaoFichas(vendaConcluida)}>
                <i className="ti ti-printer" /> Imprimir fichas
              </button>
              <button className="pos-venda-nova" onClick={() => { setVendaConcluida(null); setMensagem(''); }}>
                Fechar e fazer nova venda
              </button>
            </div>
          </div>
        )}

        {!isMobile && sidebarMarkup}

        {isMobile && menuAberto && (
          <>
            <div className="drawer-overlay" onClick={() => setMenuAberto(false)} />
            <div className="drawer-mobile">
              <div className="drawer-mobile-inner">{sidebarMarkup}</div>
            </div>
          </>
        )}

        <main className="conteudo">
          {isMobile && modoAcesso === 'caixa' && (
            <div className="tabs-caixa no-print">
              <button className={pagina === 'vender' ? 'ativo' : ''} onClick={() => setPagina('vender')}>
                <i className="ti ti-ticket" /> Vender
              </button>
              <button className={pagina === 'minhas-vendas' ? 'ativo' : ''} onClick={() => setPagina('minhas-vendas')}>
                <i className="ti ti-receipt-2" /> Vendas
              </button>
              <button className="tabs-caixa-mais" onClick={() => setMenuAberto(true)} title="Mais opções">
                <i className="ti ti-dots" />
              </button>
            </div>
          )}
          {isMobile && modoAcesso !== 'caixa' && (
            <div className="topo-mobile no-print">
              <button onClick={() => setMenuAberto(true)}><i className="ti ti-menu-2" /></button>
              <img src={AGENDO_LOGO} alt="AGENDO" />
              <div style={{ flex: 1 }} />
              <button onClick={() => setBuscaAberta(true)}><i className="ti ti-search" /></button>
            </div>
          )}
          <div className="topo no-print">
            <div>
              <span className="eyebrow">AGENDO Eventos</span>
              <h1>{tituloPagina(pagina)}</h1>
              <p>{evento?.nome} • {modoAcesso === 'principal' ? 'Caixa Principal' : caixaAtual?.nome || 'Caixa Rápido'}</p>
            </div>
            <div className="topo-acoes">
              {!(isMobile && modoAcesso === 'caixa') && (
                <button className="topo-btn" onClick={() => setPagina('relatorios')}>Relatórios</button>
              )}
              {!(isMobile && (pagina === 'vender' || modoAcesso === 'caixa')) && (
                <button className="topo-btn principal" onClick={() => setPagina('vender')}>Nova venda</button>
              )}
            </div>
          </div>

          {!online && (
            <div className="mensagem erro no-print">
              <i className="ti ti-wifi-off" /> Sem conexão com a internet — nada vai salvar até a conexão voltar. Tenta trocar de wifi/dados, ou aguarda reconectar.
            </div>
          )}

          {mensagem && (
            <div className="mensagem ok no-print mensagem-com-acao">
              <span>{mensagem}</span>
              {vendaImpressaoDireta && (
                <button className="botao verde mini-print" onClick={() => abrirImpressaoFichas(vendaImpressaoDireta)}>
                  <i className="ti ti-printer" /> Imprimir agora
                </button>
              )}
            </div>
          )}
          {erro && <div className="mensagem erro no-print">{erro}</div>}

          {modoAcesso === 'principal' && !temCaixaPrincipalReal && caixaAtual && (
            <div className="mensagem aviso no-print" style={{ cursor: 'pointer' }} onClick={() => setPagina('caixas')}>
              <i className="ti ti-alert-triangle" /> Não há um <b>Caixa Principal</b> cadastrado — suas vendas estão caindo no <b>{caixaAtual.nome}</b>. Toque pra criar um caixa do tipo <b>Principal</b> em Caixas e operadores.
            </div>
          )}

          {!(isMobile && modoAcesso === 'caixa' && pagina === 'vender') && (
            <div className="resumo-faixa no-print">
              <span>{modoAcesso === 'principal' ? 'Total geral' : 'Meu caixa'}: <b>{moeda(modoAcesso === 'principal' ? resumo.totalVendido : totalDaTela)}</b></span>
              <span>Vendas: <b>{modoAcesso === 'principal' ? vendasValidas.length : vendasValidasDaTela.length}</b></span>
              <span>Fichas: <b>{modoAcesso === 'principal' ? resumo.fichas : fichasDaTela}</b></span>
              {!(isMobile && modoAcesso === 'caixa') && (
                <>
                  <span>Produtos ativos: <b>{produtosAtivos}</b></span>
                  <span>Estoque: <b>{estoqueTotal}</b></span>
                </>
              )}
            </div>
          )}

          {pagina === 'painel' && (
            <section className="acoes-rapidas no-print">
              <button className="acao-grande" onClick={() => setPagina('vender')}>
                <i className="ti ti-ticket" />
                <div>
                  <strong>Vender fichas</strong>
                  <span>Abrir tela de venda rápida</span>
                </div>
              </button>
              <div className="acoes-medias">
                <button className="acao-media" onClick={() => setPagina('relatorios')}>
                  <i className="ti ti-report-analytics" />
                  <span>Relatórios</span>
                </button>
                {modoAcesso === 'principal' && (
                  <button className="acao-media" onClick={() => setPagina('fechamento')}>
                    <i className="ti ti-checkup-list" />
                    <span>Fechamento</span>
                  </button>
                )}
              </div>
              {modoAcesso === 'principal' && (
                <div className="acoes-chips">
                  <button className="chip" onClick={() => setPagina('produtos')}><i className="ti ti-packages" />Produtos</button>
                  <button className="chip" onClick={() => setPagina('movimentacoes')}><i className="ti ti-arrows-exchange" />Sangria/reforço</button>
                  <button className="chip" onClick={() => setPagina('caixas')}><i className="ti ti-users-group" />Caixas</button>
                  <button className="chip" onClick={() => setPagina('dados')}><i className="ti ti-building-community" />Dados do evento</button>
                  <button className="chip" onClick={() => setPagina('impressora')}><i className="ti ti-printer" />Impressora</button>
                  <button className="chip" onClick={() => setPagina('backup')}><i className="ti ti-database-export" />Backup</button>
                </div>
              )}
            </section>
          )}

          {pagina === 'painel' && (
            <section className="grid painel-grid">
              <Card titulo="Total vendido" valor={moeda(resumo.totalVendido)} texto="Somente vendas finalizadas" />
              <Card titulo="Dinheiro esperado" valor={moeda(resumo.dinheiroEsperado)} texto="Dinheiro + reforço - sangria" />
              <Card titulo="Fichas geradas" valor={resumo.fichas} texto="Numeração contínua" />
              <Card titulo="Canceladas" valor={moeda(resumo.totalCancelado)} texto="Não entram no fechamento" />
              <Card titulo="A receber (fiado)" valor={moeda(resumo.totalFiado)} texto="Ainda não recebido em caixa" />
              <div className="card span2">
                <h2>Por forma de pagamento</h2>
                <Tabela linhas={formas.filter((f) => resumo.porForma[f]).map((f) => [f, moeda(resumo.porForma[f])])} />
              </div>
              <div className="card span2">
                <h2>Por produto</h2>
                <Tabela linhas={resumo.porProduto.map((p) => [`${p.nome} (${moeda(p.precoUnit)} cada)`, `${p.qtd} ficha(s)`, moeda(p.valor)])} vazio="Nenhum produto vendido ainda." />
              </div>
            </section>
          )}


          {pagina === 'vender' && !caixaAbertoParaVenda && (
            <section className="stack">
              <div className="card">
                <div className="cabecalho-card">
                  <div>
                    <h2>Abra o caixa pra vender</h2>
                    <p>{finCaixaAtual.fechado
                      ? `O ${caixaAtual?.nome || 'caixa'} foi fechado. Reabra pra vender de novo.`
                      : `Informe o fundo de troco pra abrir o ${caixaAtual?.nome || 'caixa'} e começar.`}</p>
                  </div>
                  <span className="pill">Fechado</span>
                </div>
                {finCaixaAtual.fechado ? (
                  <div className="botoes-finalizar"><button className="botao verde" disabled={!caixaAtual} onClick={() => reabrirCaixaSessao(caixaAtual)}><i className="ti ti-lock-open" /> Reabrir caixa</button></div>
                ) : (
                  <>
                    <label className="label">Fundo de troco (R$)</label>
                    <input inputMode="decimal" value={fundoAbertura} onChange={(e) => setFundoAbertura(e.target.value)} placeholder="Ex.: 100 (ou 0 se não tem troco)" />
                    <div className="botoes-finalizar"><button className="botao verde" disabled={fundoAbertura === '' || !caixaAtual} onClick={() => { abrirCaixaSessao(caixaAtual, fundoAbertura); setFundoAbertura(''); }}><i className="ti ti-lock-open" /> Abrir caixa e começar</button></div>
                  </>
                )}
              </div>
            </section>
          )}

          {pagina === 'vender' && caixaAbertoParaVenda && (
            <section className="grid-venda">
              <div className="card">
                <div className="cabecalho-card">
                  <div className="hide-mobile-caixa">
                    <h2>Vender fichas</h2>
                    <p>{modoAcesso === 'principal' ? 'Venda feita pelo Caixa Principal. Também entra no fechamento geral.' : 'Venda rápida do caixa selecionado.'}</p>
                  </div>
                  {!(isMobile && modoAcesso === 'caixa') && <span className="pill ok">{caixaAtual?.nome || 'Caixa'}</span>}
                </div>
                {categoriasProduto.length > 2 && (
                  <div className="categorias-tabs no-print">
                    {categoriasProduto.map((c) => (
                      <button key={c} className={categoriaAtiva === c ? 'ativo' : ''} onClick={() => setCategoriaAtiva(c)}>{c}</button>
                    ))}
                  </div>
                )}
                <div className="produtos-grid">
                  {produtosFiltrados.map((produto) => {
                    const emPromo = produto.promocao_ativa && produto.preco_promocional != null;
                    return (
                      <button key={produto.id} className={`produto-btn ${emPromo ? 'em-promocao' : ''}`} onClick={() => adicionarAoCarrinho(produto)} disabled={caixaFechado}>
                        {emPromo && <span className="selo-promo">PROMOÇÃO</span>}
                        <strong>{produto.nome}</strong>
                        {emPromo ? (
                          <span className="preco-promo">
                            <s>{moeda(produto.preco)}</s> {moeda(produto.preco_promocional)}
                          </span>
                        ) : (
                          <span>{moeda(produto.preco)}</span>
                        )}
                        <small>Estoque: {Math.max(0, produto.estoque_atual)}{produto.estoque_atual <= 0 ? ' • SEM ESTOQUE' : ''}</small>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="card carrinho-card">
                <div className="cabecalho-card">
                  <div>
                    <h2>Venda atual</h2>
                    <p>{qtdCarrinho} ficha(s) selecionada(s)</p>
                  </div>
                  <strong className="total-grande">{moeda(totalCarrinho)}</strong>
                </div>

                {carrinho.length === 0 ? (
                  <p className="vazio">Nenhum item no carrinho.</p>
                ) : (
                  <div className="lista-carrinho">
                    {carrinho.map((item) => (
                      <div className="linha-carrinho" key={item.id}>
                        <div>
                          <strong>{item.nome}</strong>
                          <small>{item.quantidade} × {moeda(item.preco)}</small>
                        </div>
                        <div className="qtd-actions">
                          <button onClick={() => removerDoCarrinho(item.id)}>-</button>
                          <span>{item.quantidade}</span>
                          <button onClick={() => adicionarAoCarrinho(item)}>+</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <label className="label">Pagamento</label>
                <div className="pagamentos">
                  {['Pix', 'Dinheiro', 'Débito', 'Crédito', 'Fiado', 'Cortesia'].map((forma) => (
                    <button key={forma} className={pagamento === forma ? 'ativo' : ''} onClick={() => setPagamento(forma)}>{forma}</button>
                  ))}
                </div>
                {pagamento === 'Fiado' && (
                  <div className="fiado-pessoa-box">
                    <label className="label">De quem é o fiado?</label>
                    <select value={pessoaFiadoSelecionada} onChange={(e) => setPessoaFiadoSelecionada(e.target.value)}>
                      <option value="">Selecione a pessoa...</option>
                      {fiadoPessoas.filter((p) => p.ativo).map((p) => <option key={p.id} value={p.nome}>{p.nome}</option>)}
                    </select>
                    {fiadoPessoas.filter((p) => p.ativo).length === 0 && (
                      <p className="aviso-pagamento">Nenhuma pessoa cadastrada ainda. Peça pro Caixa Principal cadastrar em "Pessoas do fiado".</p>
                    )}
                    <p className="aviso-pagamento">A venda entra no total, mas não soma no "dinheiro esperado" do fechamento até ser recebida. Marque como recebida em "Vendas" quando a pessoa pagar.</p>
                  </div>
                )}
                {pagamento === 'Cortesia' && (
                  <p className="aviso-pagamento">Venda registrada como cortesia: fichas saem com valor R$ 0,00 e não entram no total vendido.</p>
                )}

                {pagamento === 'Dinheiro' && (
                  <div className="troco-box">
                    <label className="label">Valor recebido</label>
                    <input value={valorRecebido} onChange={(e) => setValorRecebido(e.target.value)} placeholder="Ex.: 20" inputMode="decimal" />
                    <div className="troco-linha"><span>Troco</span><strong>{moeda(troco)}</strong></div>
                  </div>
                )}

                <div className="botoes-finalizar">
                  <button className="botao" onClick={limparVendaPrincipal}>Limpar</button>
                  <button className="botao verde" disabled={!podeFinalizarVenda} onClick={finalizarVendaPrincipal}>{salvandoVenda ? 'Finalizando...' : 'Finalizar venda'}</button>
                </div>
              </div>
            </section>
          )}

          {pagina === 'produtos' && (
            <section className="stack">
              <div className="card no-print">
                <h2>Adicionar produto</h2>
                <form className="linha-form" onSubmit={adicionarProduto}>
                  <input placeholder="Nome do produto" value={novoProduto.nome} onChange={(e) => setNovoProduto({ ...novoProduto, nome: e.target.value })} disabled={caixaFechado} />
                  <input placeholder="Preço" inputMode="decimal" value={novoProduto.preco} onChange={(e) => setNovoProduto({ ...novoProduto, preco: e.target.value })} disabled={caixaFechado} />
                  <input placeholder="Estoque" inputMode="numeric" value={novoProduto.estoque} onChange={(e) => setNovoProduto({ ...novoProduto, estoque: e.target.value })} disabled={caixaFechado} />
                  <select value={novoProduto.categoria} onChange={(e) => setNovoProduto({ ...novoProduto, categoria: e.target.value })} disabled={caixaFechado}>
                    <option value="">Categoria...</option>
                    {CATEGORIAS_FIXAS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button className="botao verde" disabled={caixaFechado}>Adicionar</button>
                </form>
              </div>
              <div className="card">
                <h2>Produtos e estoque</h2>
                <div className="tabela-scroll">
                  <table>
                    <thead><tr><th>Produto</th><th>Categoria</th><th>Preço</th><th>Promoção</th><th>Estoque</th><th>Status</th><th>Ação</th></tr></thead>
                    <tbody>
                      {produtos.map((p) => (
                        <tr key={p.id}>
                          <td><input value={p.nome} disabled={caixaFechado} onChange={(e) => setProdutos(produtos.map((x) => x.id === p.id ? { ...x, nome: e.target.value } : x))} onBlur={(e) => atualizarProduto(p.id, 'nome', e.target.value)} /></td>
                          <td>
                            <select value={p.categoria || 'Geral'} disabled={caixaFechado} onChange={(e) => { setProdutos(produtos.map((x) => x.id === p.id ? { ...x, categoria: e.target.value } : x)); atualizarProduto(p.id, 'categoria', e.target.value); }}>
                              {CATEGORIAS_FIXAS.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </td>
                          <td><input value={p.preco} disabled={caixaFechado} onChange={(e) => setProdutos(produtos.map((x) => x.id === p.id ? { ...x, preco: e.target.value } : x))} onBlur={(e) => atualizarProduto(p.id, 'preco', e.target.value)} /></td>
                          <td>
                            <div className="promo-celula">
                              <input className="promo-preco" placeholder="Preço promo" inputMode="decimal" value={p.preco_promocional ?? ''} disabled={caixaFechado} onChange={(e) => setProdutos(produtos.map((x) => x.id === p.id ? { ...x, preco_promocional: e.target.value } : x))} onBlur={(e) => atualizarProduto(p.id, 'preco_promocional', e.target.value === '' ? null : e.target.value)} />
                              <button className={`mini ${p.promocao_ativa ? 'verde' : ''}`} disabled={caixaFechado || !p.preco_promocional} onClick={() => alternarPromocao(p)}>
                                {p.promocao_ativa ? 'Promo ativa' : 'Ativar promo'}
                              </button>
                            </div>
                          </td>
                          <td><input value={p.estoque_atual} disabled={caixaFechado} onChange={(e) => setProdutos(produtos.map((x) => x.id === p.id ? { ...x, estoque_atual: e.target.value } : x))} onBlur={(e) => atualizarProduto(p.id, 'estoque_atual', e.target.value)} /></td>
                          <td><span className={p.ativo ? 'pill ok' : 'pill'}>{p.ativo ? 'Ativo' : 'Inativo'}</span></td>
                          <td><button className="mini" disabled={caixaFechado} onClick={() => alternarProduto(p)}>{p.ativo ? 'Desativar' : 'Ativar'}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {pagina === 'vendas' && (
            <section className="card">
              <div className="cabecalho-card">
                <div>
                  <h2>Vendas realizadas</h2>
                  <p>Todas as vendas de todos os caixas.</p>
                </div>
                <button className="botao" onClick={carregarTudo}>Atualizar</button>
              </div>
              <TabelaVendas vendas={vendas} marcarImpressa={marcarImpressa} imprimirVenda={imprimirVenda} cancelarVenda={cancelarVenda} caixaFechado={caixaFechado} isMobile={isMobile} marcarFiadoRecebido={marcarFiadoRecebido} />
            </section>
          )}


          {pagina === 'minhas-vendas' && (
            <section className="card">
              <div className="cabecalho-card">
                <div>
                  <h2>Vendas</h2>
                  <p>{caixaAtual?.nome || 'Caixa'} • apenas vendas deste caixa.</p>
                </div>
                <div className="acoes">
                  <button className={`botao ${caixaAtual?.ativo === false ? 'verde' : ''}`} onClick={alternarMeuCaixa}>
                    {caixaAtual?.ativo === false ? 'Abrir meu caixa' : 'Fechar meu caixa'}
                  </button>
                  <button className="botao" onClick={() => setPagina('impressora')}><i className="ti ti-printer" /> Config. impressão</button>
                  <button className="botao" onClick={carregarTudo}>Atualizar</button>
                </div>
              </div>
              <TabelaVendas vendas={vendasDaTela} marcarImpressa={marcarImpressa} imprimirVenda={imprimirVenda} cancelarVenda={cancelarVenda} caixaFechado={caixaFechado} permitirCancelar={true} isMobile={isMobile} marcarFiadoRecebido={marcarFiadoRecebido} />
            </section>
          )}

          {pagina === 'dados' && (
            <section className="stack">
              <div className="card">
                <h2>Dados do evento</h2>
                <p>Essas informações aparecem no sistema, nas fichas e no relatório PDF.</p>
                <form className="form-grid" onSubmit={salvarDadosEvento}>
                  <label><span>Instituição</span><input value={eventoForm.instituicao} onChange={(e) => setEventoForm({ ...eventoForm, instituicao: e.target.value })} /></label>
                  <label><span>Nome do evento</span><input value={eventoForm.nome} onChange={(e) => setEventoForm({ ...eventoForm, nome: e.target.value })} /></label>
                  <label><span>Local</span><input value={eventoForm.local_evento} onChange={(e) => setEventoForm({ ...eventoForm, local_evento: e.target.value })} /></label>
                  <label><span>Data</span><input type="date" value={eventoForm.data_evento || ''} onChange={(e) => setEventoForm({ ...eventoForm, data_evento: e.target.value })} /></label>
                  <button className="botao verde">Salvar dados do evento</button>
                </form>
              </div>

              <div className="card">
                <h2>🎟️ Sorteio da festa</h2>
                <p>A cada valor em compras, o cliente ganha um número para o sorteio. Você pode mudar a regra a qualquer momento — vale para as próximas vendas.</p>
                <form className="form-grid" onSubmit={salvarDadosEvento}>
                  <label><span>A cada R$ ___ em compras = 1 número</span><input inputMode="decimal" placeholder="10" value={eventoForm.sorteio_valor_por_numero} onChange={(e) => setEventoForm({ ...eventoForm, sorteio_valor_por_numero: e.target.value })} /></label>
                  <button className="botao verde">Salvar regra do sorteio</button>
                </form>
                <div className="nota-config">
                  Exemplos: <b>10</b> → a cada R$10; <b>20</b> → a cada R$20 (compra de R$50 gera 2 números). Coloque <b>0</b> para <b>desligar</b> o sorteio. Cortesia não gera número.
                </div>
              </div>

              <div className="card">
                <h2><i className="ti ti-building-bank" /> Integração com o CAPETTE</h2>
                <p>Pra levar o dinheiro da festa pro CAPETTE (contabilidade): lá você cadastra o evento, cola o ID abaixo no <b>vínculo</b> e clica <b>“Importar vendas do AGENDO”</b>. Aqui é só copiar o ID desta festa.</p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                  <code style={{ fontSize: 12, background: '#F3F2EE', padding: '7px 10px', borderRadius: 6, userSelect: 'all' }}>{EVENTO_ID}</code>
                  <button className="botao" onClick={() => { try { navigator.clipboard?.writeText(EVENTO_ID); aviso('ID copiado!'); } catch { aviso('Copie o código ao lado.'); } }}><i className="ti ti-copy" /> Copiar ID</button>
                </div>
              </div>
            </section>
          )}

          {pagina === 'impressora' && (
            <section className="stack">
              {APP_NATIVO && (
                <div className="card">
                  <h2><i className="ti ti-bluetooth" /> Impressora Bluetooth (direto no app)</h2>
                  <p>No app instalado, imprime <strong>direto</strong> na impressora Bluetooth — sem RawBT e sem telinha. Pareie a impressora no Bluetooth do celular, depois procure e escolha ela aqui.</p>
                  <div className="nota-config">
                    {impressoraBtNome
                      ? <>Impressora escolhida: <b>{impressoraBtNome}</b></>
                      : 'Nenhuma impressora escolhida ainda.'}
                  </div>
                  <div className="acoes">
                    <button className="botao" onClick={listarImpressorasBt}><i className="ti ti-refresh" /> Procurar impressoras pareadas</button>
                    <button className="botao verde" disabled={!impressoraBt} onClick={testarImpressaoBt}><i className="ti ti-printer" /> Imprimir teste</button>
                  </div>
                  {impressorasBt.length > 0 && (
                    <div className="opcoes-grid" style={{ marginTop: 12 }}>
                      {impressorasBt.map((d) => (
                        <button key={d.address} className={`opcao-card ${impressoraBt === d.address ? 'ativa' : ''}`} onClick={() => selecionarImpressoraBt(d)}>
                          <strong>{d.name || 'Sem nome'}</strong>
                          <span>{d.address}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="card">
                <h2>Configuração da impressora</h2>
                <p>Configuração local deste computador/celular. O banco continua igual para todos os caixas.</p>
                <div className="opcoes-grid">
                  {Object.entries(papeisImpressao).map(([id, papel]) => (
                    <button key={id} className={`opcao-card ${papelImpressao === id ? 'ativa' : ''}`} onClick={() => setPapelImpressao(id)}>
                      <strong>{papel.nome}</strong>
                      <span>{papel.descricao}</span>
                    </button>
                  ))}
                </div>
                <div className="nota-config">
                  <b>Atual:</b> {papelAtual.nome} • largura CSS: {papelAtual.largura}. No Chrome, use margens nenhuma, escala 100% e desative cabeçalho/rodapé.
                </div>
              </div>

              <div className="card">
                <h2>Impressão direta no Android (RawBT)</h2>
                <p>
                  Imprime direto na impressora Bluetooth, <strong>sem abrir a telinha de impressão</strong>.
                  É o jeito mais rápido no celular. Em iPhone não tem efeito (usa a tela normal).
                </p>
                <div className="rawbt-passos">
                  <strong>Como configurar (uma vez só, em cada celular):</strong>
                  <ol>
                    <li>Instale o app <strong>RawBT</strong> (botão abaixo).</li>
                    <li>No <strong>Bluetooth do celular</strong>, pareie a impressora.</li>
                    <li>Abra o <strong>RawBT uma vez</strong> e escolha a impressora nas configurações dele.</li>
                    <li>Volte aqui e <strong>ative</strong> o botão abaixo.</li>
                    <li>Ao finalizar a venda, toque em <strong>“Imprimir fichas”</strong> — sai direto. 🎉</li>
                  </ol>
                </div>
                <a className="botao" style={{ textDecoration: 'none' }} href="https://play.google.com/store/apps/details?id=ru.a402d.rawbtprinter" target="_blank" rel="noreferrer">
                  <i className="ti ti-download" /> Instalar RawBT (Play Store)
                </a>
                <label className="opcao-toggle" style={{ marginTop: 12 }}>
                  <input type="checkbox" checked={impressaoRawBT} onChange={(e) => setImpressaoRawBT(e.target.checked)} />
                  Usar impressão direta via RawBT neste aparelho
                </label>
                {impressaoRawBT && !ehAndroid() && (
                  <p className="aviso-pagamento">Esse aparelho não parece ser Android — a opção fica salva, mas só faz efeito em celular Android com o RawBT instalado.</p>
                )}
              </div>
            </section>
          )}

          {pagina === 'caixas' && (
            <section className="stack">
              <div className="card no-print">
                <h2>Adicionar caixa</h2>
                <form className="linha-form" onSubmit={adicionarCaixa}>
                  <input placeholder="Nome do caixa" value={novoCaixa.nome} onChange={(e) => setNovoCaixa({ ...novoCaixa, nome: e.target.value })} />
                  <input placeholder="Operador" value={novoCaixa.operador} onChange={(e) => setNovoCaixa({ ...novoCaixa, operador: e.target.value })} />
                  <select value={novoCaixa.tipo} onChange={(e) => setNovoCaixa({ ...novoCaixa, tipo: e.target.value })}>
                    <option value="secundario">Secundário</option>
                    <option value="principal">Principal</option>
                  </select>
                  <button className="botao verde">Adicionar</button>
                </form>
              </div>
              <div className="card">
                <h2>Caixas / operadores</h2>
                <div className="tabela-scroll">
                  <table>
                    <thead><tr><th>Nome</th><th>Operador</th><th>Tipo</th><th>Status</th></tr></thead>
                    <tbody>
                      {caixas.map((c) => (
                        <tr key={c.id}>
                          <td><input value={c.nome || ''} onChange={(e) => setCaixas(caixas.map((x) => x.id === c.id ? { ...x, nome: e.target.value } : x))} onBlur={(e) => atualizarCaixa(c.id, 'nome', e.target.value)} /></td>
                          <td><input value={c.operador || ''} onChange={(e) => setCaixas(caixas.map((x) => x.id === c.id ? { ...x, operador: e.target.value } : x))} onBlur={(e) => atualizarCaixa(c.id, 'operador', e.target.value)} /></td>
                          <td><select value={c.tipo || 'secundario'} onChange={(e) => atualizarCaixa(c.id, 'tipo', e.target.value)}><option value="principal">Principal</option><option value="secundario">Secundário</option></select></td>
                          <td><button className="mini" onClick={() => atualizarCaixa(c.id, 'ativo', !c.ativo)}>{c.ativo !== false ? 'Ativo' : 'Inativo'}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {pagina === 'fiado' && (
            <section className="stack">
              <div className="card no-print">
                <h2>Cadastrar pessoa para fiado</h2>
                <p>Só quem estiver nesta lista aparece pro caixa escolher na hora de vender fiado.</p>
                <form className="linha-form" onSubmit={adicionarPessoaFiado}>
                  <input placeholder="Nome da pessoa" value={novaPessoaFiado} onChange={(e) => setNovaPessoaFiado(e.target.value)} />
                  <button className="botao verde">Adicionar</button>
                </form>
              </div>
              <div className="card">
                <h2>Pessoas cadastradas</h2>
                <div className="tabela-scroll">
                  <table>
                    <thead><tr><th>Nome</th><th>Status</th><th>Ação</th></tr></thead>
                    <tbody>
                      {fiadoPessoas.length ? fiadoPessoas.map((p) => (
                        <tr key={p.id}>
                          <td>{p.nome}</td>
                          <td><span className={p.ativo ? 'pill ok' : 'pill'}>{p.ativo ? 'Ativo' : 'Inativo'}</span></td>
                          <td><button className="mini" onClick={() => alternarPessoaFiado(p)}>{p.ativo ? 'Desativar' : 'Ativar'}</button></td>
                        </tr>
                      )) : <tr><td colSpan="3">Nenhuma pessoa cadastrada ainda.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="card">
                <h2>A receber — por pessoa</h2>
                <p>Soma das vendas em fiado ainda não marcadas como recebidas, agrupadas por pessoa.</p>
                <Tabela
                  linhas={fiadoPorPessoa(vendas).map((p) => [p.nome, `${p.qtdVendas} venda(s)`, moeda(p.total)])}
                  vazio="Ninguém deve nada no momento. 🎉"
                />
              </div>
              {fiadoPorPessoa(vendas).map((p) => (
                <div className="card" key={`fiado-detalhe-${p.nome}`}>
                  <h2>{p.nome} — itens pra conferência</h2>
                  <div className="tabela-scroll">
                    <table>
                      <thead><tr><th>Venda</th><th>Horário</th><th>Itens</th><th>Total</th><th>Status</th></tr></thead>
                      <tbody>
                        {p.vendas.map((v) => (
                          <tr key={`fiado-venda-${v.id}`}>
                            <td>#{numero(v.numero)}</td>
                            <td>{new Date(v.criada_em).toLocaleString('pt-BR')}</td>
                            <td>{(v.itens || []).map((i) => `${i.quantidade}× ${i.nome_produto} (${moeda(i.preco_unitario)})`).join(' | ')}</td>
                            <td>{moeda(v.total)}</td>
                            <td><button className="mini verde" onClick={() => marcarFiadoRecebido(v)}>Marcar recebido</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </section>
          )}

          {pagina === 'config' && (
            <section className="stack">
              <div className="card">
                <h2>Configurações do sistema</h2>
                <p>Parâmetros gerais do AGENDO Eventos. O acesso é escolhido na tela inicial para manter a operação limpa.</p>
                <div className="nota-config">Banco online ativo. Os dados deste evento são sincronizados entre todos os caixas pelo Supabase.</div>
              </div>

              <div className="card card-perigo">
                <h2><i className="ti ti-alert-triangle" /> Zerar dados de teste</h2>
                <p>Apaga <strong>todas as vendas, movimentações e números de sorteio</strong> deste evento e zera o estoque. <strong>Mantém</strong> produtos e caixas. Use pra limpar os testes <strong>logo antes da festa começar</strong> — depois disso o sorteio recomeça no nº 1.</p>
                <div className="nota-config">⚠️ Não tem volta. Vai pedir pra você digitar <b>ZERAR</b> pra confirmar.</div>
                <button className="botao perigo" disabled={zerando} onClick={zerarDadosTeste}>
                  <i className="ti ti-trash" /> {zerando ? 'Zerando...' : 'Zerar dados de teste'}
                </button>
              </div>
            </section>
          )}

          {pagina === 'meu-caixa' && (
            <section className="stack">
              <CardCaixaSessao
                caixa={caixaAtual}
                fin={financeiroCaixa(caixaAtual)}
                onAbrir={abrirCaixaSessao}
                onFechar={fecharCaixaSessao}
                onReabrir={reabrirCaixaSessao}
              />
            </section>
          )}

          {pagina === 'caixasfin' && (
            <section className="stack">
              <div className="card no-print">
                <h2>Abertura e fechamento de caixa</h2>
                <p>Cada operador abre o próprio caixa com o fundo de troco e fecha contando o dinheiro. Aqui você acompanha todos.</p>
              </div>
              {caixasAtivos.length === 0 ? (
                <p className="vazio">Nenhum caixa cadastrado.</p>
              ) : caixasAtivos.map((c) => (
                <CardCaixaSessao
                  key={c.id}
                  caixa={c}
                  fin={financeiroCaixa(c)}
                  onAbrir={abrirCaixaSessao}
                  onFechar={fecharCaixaSessao}
                  onReabrir={reabrirCaixaSessao}
                />
              ))}
            </section>
          )}

          {pagina === 'fechamento' && (
            <section className="stack">
              <div className="card fechamento-topo">
                <div>
                  <h2>Fechamento geral</h2>
                  <p>{caixaFechado ? `Evento fechado em ${evento?.fechado_em ? new Date(evento.fechado_em).toLocaleString('pt-BR') : ''}` : 'Evento aberto para vendas.'}</p>
                </div>
                {caixaFechado ? (
                  <button className="botao perigo" onClick={reabrirEvento}>Reabrir evento</button>
                ) : (
                  <button className="botao verde" onClick={fecharEvento}>Fechar evento</button>
                )}
              </div>
              <div className="grid painel-grid">
                <Card titulo="Total vendido" valor={moeda(resumo.totalVendido)} texto="Finalizadas" />
                <Card titulo="Pix" valor={moeda(resumo.porForma.Pix)} texto="Recebido em Pix" />
                <Card titulo="Dinheiro" valor={moeda(resumo.porForma.Dinheiro)} texto="Vendas em dinheiro" />
                <Card titulo="Débito" valor={moeda(resumo.porForma.Débito)} texto="Cartão débito" />
                <Card titulo="Crédito" valor={moeda(resumo.porForma.Crédito)} texto="Cartão crédito" />
                <Card titulo="Dinheiro esperado" valor={moeda(resumo.dinheiroEsperado)} texto="Dinheiro + reforço - sangria" />
              </div>
            </section>
          )}

          {pagina === 'movimentacoes' && (
            <section className="stack">
              <div className="card no-print">
                <h2>Sangria e reforço</h2>
                <p className="nota-config"><b>Reforço</b> = pôr dinheiro no caixa <b>depois</b> que já abriu. <b>Sangria</b> = tirar dinheiro. ⚠️ O <b>troco inicial</b> NÃO entra aqui — ele vai no <b>fundo de troco</b> quando você abre o caixa (em "Abertura/fechamento de caixa"). Se lançar o troco aqui E no fundo, o esperado conta em dobro.</p>
                <form className="linha-form" onSubmit={registrarMovimentacao}>
                  <select value={movimento.tipo} disabled={caixaFechado} onChange={(e) => setMovimento({ ...movimento, tipo: e.target.value })}>
                    <option>Reforço</option>
                    <option>Sangria</option>
                  </select>
                  <input placeholder="Valor" inputMode="decimal" value={movimento.valor} disabled={caixaFechado} onChange={(e) => setMovimento({ ...movimento, valor: e.target.value })} />
                  <input placeholder="Motivo/observação" value={movimento.motivo} disabled={caixaFechado} onChange={(e) => setMovimento({ ...movimento, motivo: e.target.value })} />
                  <button className="botao verde" disabled={caixaFechado}>Registrar</button>
                </form>
              </div>
              <div className="card">
                <h2>Movimentações registradas</h2>
                <Tabela linhas={movimentacoes.map((m) => [m.tipo, moeda(m.valor), m.motivo || '-', new Date(m.criada_em).toLocaleString('pt-BR'), <button className="mini" disabled={caixaFechado} onClick={() => removerMovimentacao(m.id)}>Remover</button>])} vazio="Nenhuma movimentação." />
              </div>
            </section>
          )}

          {pagina === 'relatorios' && (
            <section className="stack">
              <div className="card no-print">
                <div className="cabecalho-card">
                  <div>
                    <h2>Relatórios</h2>
                    <p>Gere PDF ou CSV com os dados atuais do evento.</p>
                  </div>
                  <div className="acoes">
                    <button className="botao" onClick={imprimirRelatorio}>Gerar PDF</button>
                    <button className="botao" onClick={exportarCsv}>Exportar CSV</button>
                    <button className="botao" onClick={exportarBackupJson}>Backup (JSON)</button>
                  </div>
                </div>
              </div>
              <Relatorio evento={evento} vendas={vendas} resumo={resumo} produtos={produtos} caixas={caixas} />
            </section>
          )}

          <div className="rodape-conteudo no-print">
            <span>AGENDO Eventos · {evento?.instituicao || 'CAPETTE'} · {caixaAtual?.nome || (modoAcesso === 'principal' ? 'Caixa Principal' : 'Caixa')}</span>
            <span className="rodape-marca">AGENDO Integra</span>
          </div>
        </main>
      </div>
      <div className="print-only area-impressao">
        {vendaParaImprimir && fichasParaImprimir.length > 0 ? (
          fichasParaImprimir.map((item) => (
            <div className="ficha-termica" key={`${vendaParaImprimir.id}-${item.numero}`}>
              <div className="ficha-topo">{evento?.nome || 'Evento'}</div>
              {evento?.instituicao && <div className="ficha-sub">{evento.instituicao}</div>}
              <h1>{item.produto}</h1>
              <h3>{moeda(item.valor)}</h3>
              <p>{vendaParaImprimir.caixa?.nome || caixaAtual?.nome || caixaPrincipal?.nome || 'Caixa'} • Venda nº {numero(vendaParaImprimir.numero)}</p>
              <div className="ficha-marca">AGENDO EVENTOS</div>
            </div>
          ))
        ) : <div />}
        {vendaParaImprimir && numerosSorteioImprimir.length > 0 && (
          <div className="ficha-termica cupom-sorteio" key={`${vendaParaImprimir.id}-sorteio`}>
            <div className="ficha-topo">CUPOM DE SORTEIO</div>
            <h3>Guarde para o sorteio!</h3>
            <div className="linha-pontilhada" />
            {numerosSorteioImprimir.map((n) => <h1 key={n}>{ficha(n)}</h1>)}
            <div className="linha-pontilhada" />
            <p>{evento?.nome || 'Evento'}</p>
            <p>{vendaParaImprimir.caixa?.nome || caixaAtual?.nome || caixaPrincipal?.nome || 'Caixa'} • Venda nº {numero(vendaParaImprimir.numero)}</p>
            <div className="ficha-marca">AGENDO EVENTOS</div>
          </div>
        )}
      </div>
      <RelatorioPdf
        evento={evento}
        vendas={vendas}
        resumo={resumo}
        produtos={produtos}
        caixas={caixas}
        movimentacoes={movimentacoes}
        caixaFechado={caixaFechado}
      />
    </>
  );
}


function TelaLogin({ email, senha, setEmail, setSenha, erro, loading, onSubmit, recuperarSenha, recuperacaoMsg }) {
  return (
    <div className="login-agendo-page">
      <div className="login-watermark-logo">
        <img src={AGENDO_LOGO} alt="" />
      </div>

      <main className="login-conteudo">
        <header className="login-institucional">
          <div>AGENDO Integra</div>
          <small>Gestão integrada para OSCs, eventos sociais e prestações de contas</small>
        </header>

        <section className="login-grid">
          <article className="login-card login-card-interno">
            <div className="login-card-logo">
              <img src={CAPETTE_LOGO} alt="CAPETTE" />
            </div>

            <div className="login-card-titulo">Área Interna</div>
            <div className="login-card-subtitulo">AGENDO Eventos · Acesso restrito</div>

            <div className="login-divisor" />

            <form className="login-form" onSubmit={onSubmit}>
              <label>
                <span>E-mail</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu@email.com"
                  autoComplete="email"
                  required
                />
              </label>

              <label>
                <span>Senha</span>
                <input
                  type="password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </label>

              {erro && <div className="login-alert erro">{erro}</div>}
              {recuperacaoMsg && <div className="login-alert ok">{recuperacaoMsg}</div>}

              <button className="login-btn-primary" type="submit" disabled={loading}>
                {loading ? 'Entrando...' : 'Entrar'}
              </button>

              <button className="login-link" type="button" onClick={recuperarSenha}>
                Esqueci minha senha
              </button>
            </form>

            <div className="login-restrito">
              <i className="ti ti-lock" />
              Acesso restrito à equipe autorizada.
            </div>
          </article>

          <article className="login-card login-card-publico">
            <div>
              <div className="login-card-titulo">Operação de Eventos</div>
              <div className="login-card-subtitulo">Caixa, fichas, impressão e fechamento</div>

              <div className="login-divisor soft" />

              <p className="login-texto">
                Entre com seu usuário autorizado. Depois do login, o sistema libera o acesso ao Caixa Principal ou aos caixas operadores conforme a operação do evento.
              </p>

              <div className="login-beneficios">
                <div><i className="ti ti-ticket" /> Venda de fichas com impressão automática</div>
                <div><i className="ti ti-printer" /> Configuração de impressora 58mm/80mm</div>
                <div><i className="ti ti-report-analytics" /> Relatório e fechamento do evento</div>
              </div>

              <div className="login-nota">
                O link online só permite operação após login. Não compartilhe usuário e senha fora da equipe autorizada.
              </div>
            </div>

            <div className="login-publico-rodape">
              <i className="ti ti-shield-lock" />
              Ambiente protegido por autenticação
            </div>
          </article>
        </section>

        <footer className="login-footer">
          <img src={AGENDO_TEXTO} alt="AGENDO" />
          <span>Integra · Eventos · Caixa e fichas</span>
        </footer>
      </main>
    </div>
  );
}

function TelaAcesso({ evento, caixas, entrarComoPrincipal, entrarComoCaixa, usuario, sairSistema }) {
  const caixasOperacao = caixas.filter((c) => c.ativo !== false);
  const caixasSecundarios = caixasOperacao.filter((c) => c.tipo !== 'principal');
  const caixasExibir = caixasSecundarios.length ? caixasSecundarios : caixasOperacao;

  return (
    <div className="login-agendo-page">
      <div className="login-watermark-logo">
        <img src={AGENDO_LOGO} alt="" />
      </div>

      <main className="login-conteudo">
        <header className="login-institucional">
          <div>AGENDO Integra</div>
          <small>{usuario?.email || 'Usuário autenticado'} · escolha o acesso do evento</small>
        </header>

        <section className="login-grid">
          <article className="login-card login-card-interno">
            <div className="login-card-logo">
              <img src={CAPETTE_LOGO} alt={evento?.instituicao || 'CAPETTE'} />
            </div>

            <div className="login-card-titulo">Área do Evento</div>
            <div className="login-card-subtitulo">{evento?.nome || 'Sistema de fichas e caixa'}</div>

            <div className="login-divisor" />

            <button className="login-btn-primary" onClick={entrarComoPrincipal}>
              Entrar como Caixa Principal
            </button>

            <div className="login-ajuda">
              Acesso completo para coordenação, fechamento, relatórios, produtos e configurações.
            </div>

            <div className="login-restrito">
              <i className="ti ti-lock" />
              Acesso restrito à equipe autorizada.
            </div>
          </article>

          <article className="login-card login-card-publico">
            <div>
              <div className="login-card-titulo">Caixas Operadores</div>
              <div className="login-card-subtitulo">Venda rápida de fichas e reimpressão</div>

              <div className="login-divisor soft" />

              <p className="login-texto">
                Selecione o caixa de atendimento para iniciar as vendas do evento. As vendas são registradas no sistema central e aparecem automaticamente no Caixa Principal.
              </p>

              <div className="login-caixas-lista">
                {caixasExibir.length ? caixasExibir.map((c) => (
                  <button className="login-caixa-btn" key={c.id} onClick={() => entrarComoCaixa(c.id)}>
                    <span>{c.nome}</span>
                    <strong>{c.operador || 'Operador'}</strong>
                    <small>Venda e reimpressão de fichas</small>
                  </button>
                )) : (
                  <button className="login-caixa-btn" onClick={() => entrarComoCaixa(null)}>
                    <span>Caixa operador</span>
                    <strong>Iniciar atendimento</strong>
                    <small>Venda e reimpressão de fichas</small>
                  </button>
                )}
              </div>

              <div className="login-nota">
                {evento?.instituicao || 'CAPETTE'} · {evento?.local_evento || 'Evento integrado ao AGENDO'}
              </div>
            </div>

            <div className="login-publico-rodape">
              <i className="ti ti-leaf" />
              Operação simples para celular e balcão
            </div>
          </article>
        </section>

        <div className="login-trocar-usuario">
          <button type="button" onClick={sairSistema}>Sair deste usuário</button>
        </div>

        <footer className="login-footer">
          <img src={AGENDO_TEXTO} alt="AGENDO" />
          <span>Integra · Eventos · Caixa e fichas</span>
        </footer>
      </main>
    </div>
  );
}

function CardCaixaSessao({ caixa, fin, onAbrir, onFechar, onReabrir }) {
  const [fundo, setFundo] = useState('');
  const [contado, setContado] = useState('');
  if (!caixa) return <p className="vazio">Nenhum caixa selecionado.</p>;

  const linha = (rot, val, forte) => (
    <div className={`sessao-linha ${forte ? 'forte' : ''}`}><span>{rot}</span><strong>{moeda(val)}</strong></div>
  );
  const blocoDif = (dif) => (
    <div className={`sessao-dif ${dif < 0 ? 'falta' : 'ok'}`}>
      <span>{dif < 0 ? 'Faltou' : dif > 0 ? 'Sobrou' : 'Bateu certinho'}</span>
      <strong>{dif < 0 ? '− ' : dif > 0 ? '+ ' : ''}{moeda(Math.abs(dif || 0))}</strong>
    </div>
  );

  if (!fin.aberto && !fin.fechado) {
    return (
      <div className="card">
        <div className="cabecalho-card"><div><h2>{caixa.nome}</h2><p>Caixa fechado — abra informando o fundo de troco pra começar.</p></div><span className="pill">Fechado</span></div>
        <label className="label">Fundo de troco (R$)</label>
        <input inputMode="decimal" value={fundo} onChange={(e) => setFundo(e.target.value)} placeholder="Ex.: 100" />
        <div className="botoes-finalizar"><button className="botao verde" disabled={fundo === ''} onClick={() => onAbrir(caixa, fundo)}><i className="ti ti-lock-open" /> Abrir caixa</button></div>
      </div>
    );
  }

  if (fin.aberto) {
    const difPrevia = contado !== '' ? normalizarNumero(contado) - fin.esperado : null;
    return (
      <div className="card">
        <div className="cabecalho-card"><div><h2>{caixa.nome}</h2><p>Caixa aberto. No fim, conte o dinheiro da gaveta e feche.</p></div><span className="pill ok">Aberto</span></div>
        <div className="sessao-resumo">
          {linha('Fundo de troco', fin.fundo)}
          {linha('Vendas em dinheiro', fin.vendasDin)}
          {linha('Reforços', fin.reforcos)}
          {linha('Sangrias', -fin.sangrias)}
          {linha('Esperado na gaveta', fin.esperado, true)}
        </div>
        <label className="label">Quanto você contou em dinheiro? (R$)</label>
        <input inputMode="decimal" value={contado} onChange={(e) => setContado(e.target.value)} placeholder="Ex.: 500" />
        {difPrevia != null && blocoDif(difPrevia)}
        <div className="botoes-finalizar"><button className="botao verde" disabled={contado === ''} onClick={() => onFechar(caixa, contado)}><i className="ti ti-lock" /> Fechar caixa</button></div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="cabecalho-card"><div><h2>{caixa.nome}</h2><p>Caixa fechado e conferido.</p></div><span className="pill ok">Fechado ✓</span></div>
      <div className="sessao-resumo">
        {linha('Esperado', fin.esperado)}
        {linha('Contado', fin.contado)}
      </div>
      {blocoDif(fin.diferenca)}
      <div className="botoes-finalizar"><button className="botao" onClick={() => onReabrir(caixa)}><i className="ti ti-lock-open" /> Reabrir (corrigir)</button></div>
    </div>
  );
}

function tituloPagina(pagina) {
  return {
    painel: 'Painel geral',
    vender: 'Vender fichas',
    produtos: 'Produtos e estoque',
    vendas: 'Vendas realizadas',
    'minhas-vendas': 'Minhas vendas',
    'meu-caixa': 'Meu caixa',
    caixasfin: 'Abertura e fechamento de caixa',
    fechamento: 'Fechamento do evento',
    movimentacoes: 'Sangria / reforço',
    relatorios: 'Relatórios e exportações',
    dados: 'Dados do evento',
    impressora: 'Impressora',
    caixas: 'Caixas e operadores',
    fiado: 'Fiado (a receber)',
    backup: 'Backup / exportação',
    config: 'Sistema',
    acesso: 'Trocar acesso',
  }[pagina] || 'AGENDO Eventos';
}

function Card({ titulo, valor, texto }) {
  return <div className="card kpi"><span>{titulo}</span><strong>{valor}</strong><small>{texto}</small></div>;
}

function Tabela({ linhas, vazio }) {
  if (!linhas || !linhas.length) return <p className="vazio">{vazio || 'Sem dados.'}</p>;
  return <div className="tabela-scroll"><table><tbody>{linhas.map((l, idx) => <tr key={idx}>{l.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody></table></div>;
}

function TabelaVendas({ vendas, marcarImpressa, imprimirVenda, cancelarVenda, caixaFechado, permitirCancelar = true, isMobile = false, marcarFiadoRecebido }) {
  if (!vendas.length) return <p className="vazio">Nenhuma venda ainda.</p>;

  if (isMobile) {
    return (
      <div className="lista-vendas-mobile">
        {vendas.map((v) => (
          <div key={v.id} className={`venda-card ${v.status === 'cancelada' ? 'cancelada' : ''}`}>
            <div className="venda-card-topo">
              <strong>#{numero(v.numero)}</strong>
              <span className="venda-card-valor">{moeda(v.total)}</span>
            </div>
            <div className="venda-card-meta">
              <span>{new Date(v.criada_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
              <span>•</span>
              <span>{v.forma_pagamento}</span>
              <span>•</span>
              <span className={v.status === 'cancelada' ? 'pill erro' : 'pill ok'}>{v.status}</span>
            </div>
            <div className="venda-card-itens">
              {(v.itens || []).map((i) => `${i.quantidade}× ${i.nome_produto} (${moeda(i.preco_unitario)})`).join(' · ')}
            </div>
            {(v.sorteio || []).length > 0 && (
              <div className="venda-card-sorteio">🎟️ Sorteio: {(v.sorteio || []).map((s) => ficha(s.numero)).join(', ')}</div>
            )}
            <div className="venda-card-acoes">
              <button className="mini" onClick={() => imprimirVenda(v.id)}>Reimprimir</button>
              {v.forma_pagamento === 'Fiado' && v.status !== 'cancelada' && <button className="mini verde" onClick={() => marcarFiadoRecebido(v)}>Marcar recebido</button>}
              {permitirCancelar && v.status !== 'cancelada' && <button className="mini perigo" disabled={caixaFechado} onClick={() => cancelarVenda(v)}>Cancelar venda</button>}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="tabela-scroll">
      <table>
        <thead><tr><th>Venda</th><th>Horário</th><th>Caixa</th><th>Pagamento</th><th>Itens</th><th>Total</th><th>Sorteio</th><th>Status</th><th>Impressão</th></tr></thead>
        <tbody>
          {vendas.map((v) => (
            <tr key={v.id} className={v.status === 'cancelada' ? 'cancelada' : ''}>
              <td>#{numero(v.numero)}</td>
              <td>{new Date(v.criada_em).toLocaleString('pt-BR')}</td>
              <td>{v.caixa?.nome || '-'}</td>
              <td>{v.forma_pagamento}</td>
              <td>{(v.itens || []).map((i) => `${i.quantidade}× ${i.nome_produto} • fichas ${numero(i.ficha_inicio)}-${numero(i.ficha_fim)}`).join(' | ')}</td>
              <td>{moeda(v.total)}</td>
              <td>{(v.sorteio || []).length ? <span className="badge-sorteio">🎟️ {v.sorteio.map((s) => ficha(s.numero)).join(', ')}</span> : '—'}</td>
              <td><span className={v.status === 'cancelada' ? 'pill erro' : 'pill ok'}>{v.status}</span></td>
              <td><div className="acoes-linha"><button className="mini" onClick={() => imprimirVenda(v.id)}>Reimprimir</button>{v.impresso ? <span className="pill ok">Impresso</span> : <button className="mini" onClick={() => marcarImpressa(v)}>Marcar impresso</button>}{v.forma_pagamento === 'Fiado' && v.status !== 'cancelada' && <button className="mini verde" onClick={() => marcarFiadoRecebido(v)}>Marcar recebido</button>}{permitirCancelar && v.status !== 'cancelada' && <button className="mini perigo" disabled={caixaFechado} onClick={() => cancelarVenda(v)}>Cancelar</button>}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Relatorio({ evento, vendas, resumo, produtos, caixas }) {
  return (
    <div className="card relatorio print-area">
      <h2>Relatório do Evento</h2>
      <p><strong>{evento?.nome}</strong></p>
      <p>{evento?.instituicao} • {evento?.local_evento || 'Local não informado'} • Gerado em {hojeBR()}</p>

      <h3>Resumo financeiro</h3>
      <Tabela linhas={[
        ['Total vendido', moeda(resumo.totalVendido)],
        ['Vendas finalizadas', vendas.filter((v) => v.status !== 'cancelada').length],
        ['Fichas geradas', resumo.fichas],
        ['Pix', moeda(resumo.porForma.Pix)],
        ['Dinheiro', moeda(resumo.porForma.Dinheiro)],
        ['Débito', moeda(resumo.porForma.Débito)],
        ['Crédito', moeda(resumo.porForma.Crédito)],
        ['Reforços', moeda(resumo.reforcos)],
        ['Sangrias', moeda(resumo.sangrias)],
        ['Dinheiro esperado', moeda(resumo.dinheiroEsperado)],
      ]} />

      <h3>Produtos vendidos</h3>
      <Tabela linhas={resumo.porProduto.filter((p) => !ePromo(p, produtos)).map((p) => [p.nome, `${p.qtd} ficha(s)`, moeda(p.valor)])} vazio="Nenhum produto vendido." />

      <h3>Produtos vendidos na promoção</h3>
      <Tabela linhas={resumo.porProduto.filter((p) => ePromo(p, produtos)).map((p) => [`${p.nome} (${moeda(p.precoUnit)} cada)`, `${p.qtd} ficha(s)`, moeda(p.valor)])} vazio="Nenhuma venda em promoção." />

      <h3>Fiado — a receber por pessoa</h3>
      <Tabela linhas={fiadoPorPessoa(vendas).map((p) => [p.nome, `${p.qtdVendas} venda(s)`, moeda(p.total)])} vazio="Ninguém deve nada no momento." />

      <h3>Estoque atual</h3>
      <Tabela linhas={produtos.map((p) => [p.nome, moeda(p.preco), `Estoque: ${Math.max(0, p.estoque_atual)}`, p.ativo ? 'Ativo' : 'Inativo'])} />

      <h3>Total por caixa</h3>
      <Tabela linhas={totalPorCaixa(vendas, caixas).map((c) => [`${c.nome} (${c.operador})`, `${c.vendas} venda(s)`, `${c.fichas} ficha(s)`, moeda(c.total)])} vazio="Nenhuma venda registrada." />
    </div>
  );
}


function RelatorioPdf({ evento, vendas, resumo, produtos, caixas, movimentacoes, caixaFechado }) {
  const vendasFinalizadas = vendas.filter((v) => v.status !== 'cancelada');
  const formasRelatorio = ['Pix', 'Dinheiro', 'Débito', 'Crédito', 'Fiado', 'Cortesia'].filter((f) => Number(resumo.porForma[f] || 0) > 0 || ['Pix', 'Dinheiro', 'Débito', 'Crédito'].includes(f));
  const dataGeracao = hojeBR();
  const statusCaixa = caixaFechado ? `Fechado em ${evento?.fechado_em ? new Date(evento.fechado_em).toLocaleString('pt-BR') : '-'}` : 'Caixa aberto';

  return (
    <div className="relatorio-pdf-hidden" aria-hidden="true">
      <div className="pdf-topo">
        <div>
          <div className="pdf-marca">AGENDO Eventos</div>
          <h1>Relatório Geral do Evento</h1>
          <p>{dataGeracao} • {statusCaixa}</p>
        </div>
        <div className="pdf-selo">Relatório PDF</div>
      </div>

      <section className="pdf-bloco">
        <h2>Dados do evento</h2>
        <table>
          <tbody>
            <tr><th>Instituição</th><td>{evento?.instituicao || '-'}</td><th>Evento</th><td>{evento?.nome || '-'}</td></tr>
            <tr><th>Data</th><td>{evento?.data_evento ? new Date(`${evento.data_evento}T00:00:00`).toLocaleDateString('pt-BR') : '-'}</td><th>Local</th><td>{evento?.local_evento || '-'}</td></tr>
            <tr><th>Status</th><td>{evento?.status || '-'}</td><th>Caixas cadastrados</th><td>{caixas.length}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Resumo geral</h2>
        <div className="pdf-grid">
          <div className="pdf-kpi"><span>Total vendido</span><strong>{moeda(resumo.totalVendido)}</strong></div>
          <div className="pdf-kpi"><span>Vendas finalizadas</span><strong>{vendasFinalizadas.length}</strong></div>
          <div className="pdf-kpi"><span>Fichas geradas</span><strong>{resumo.fichas}</strong></div>
          <div className="pdf-kpi"><span>Canceladas</span><strong>{moeda(resumo.totalCancelado)}</strong></div>
        </div>
      </section>

      <section className="pdf-bloco">
        <h2>Resumo financeiro</h2>
        <table>
          <thead><tr><th>Item</th><th>Total</th></tr></thead>
          <tbody>
            {formasRelatorio.map((f) => <tr key={`pdf-forma-${f}`}><td>{f}</td><td>{moeda(resumo.porForma[f] || 0)}</td></tr>)}
            <tr><td>Reforços de caixa</td><td>{moeda(resumo.reforcos)}</td></tr>
            <tr><td>Sangrias</td><td>{moeda(resumo.sangrias)}</td></tr>
            <tr><th>Dinheiro esperado no caixa</th><th>{moeda(resumo.dinheiroEsperado)}</th></tr>
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Produtos vendidos</h2>
        <table>
          <thead><tr><th>Produto</th><th>Preço</th><th>Qtd.</th><th>Valor vendido</th></tr></thead>
          <tbody>
            {resumo.porProduto.filter((p) => !ePromo(p, produtos)).length ? resumo.porProduto.filter((p) => !ePromo(p, produtos)).map((p) => (
              <tr key={`pdf-produto-${p.nome}-${p.precoUnit}`}><td>{p.nome}</td><td>{moeda(p.precoUnit)}</td><td>{p.qtd}</td><td>{moeda(p.valor)}</td></tr>
            )) : <tr><td colSpan="4">Nenhum produto vendido.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Produtos vendidos na promoção</h2>
        <table>
          <thead><tr><th>Produto</th><th>Preço promo</th><th>Qtd.</th><th>Valor vendido</th></tr></thead>
          <tbody>
            {resumo.porProduto.filter((p) => ePromo(p, produtos)).length ? resumo.porProduto.filter((p) => ePromo(p, produtos)).map((p) => (
              <tr key={`pdf-promo-${p.nome}-${p.precoUnit}`}><td>{p.nome}</td><td>{moeda(p.precoUnit)}</td><td>{p.qtd}</td><td>{moeda(p.valor)}</td></tr>
            )) : <tr><td colSpan="4">Nenhuma venda em promoção.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Fiado — a receber por pessoa</h2>
        <table>
          <thead><tr><th>Pessoa</th><th>Vendas</th><th>Total a receber</th></tr></thead>
          <tbody>
            {fiadoPorPessoa(vendas).length ? fiadoPorPessoa(vendas).map((p) => (
              <tr key={`pdf-fiado-${p.nome}`}><td>{p.nome}</td><td>{p.qtdVendas}</td><td>{moeda(p.total)}</td></tr>
            )) : <tr><td colSpan="3">Ninguém deve nada no momento.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Estoque atual</h2>
        <table>
          <thead><tr><th>Produto</th><th>Preço</th><th>Estoque</th><th>Status</th></tr></thead>
          <tbody>
            {produtos.map((p) => <tr key={`pdf-estoque-${p.id}`}><td>{p.nome}</td><td>{moeda(p.preco)}</td><td>{Math.max(0, p.estoque_atual)}</td><td>{p.ativo ? 'Ativo' : 'Inativo'}</td></tr>)}
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Total por caixa</h2>
        <table>
          <thead><tr><th>Caixa</th><th>Vendas</th><th>Fichas</th><th>Total vendido</th></tr></thead>
          <tbody>
            {totalPorCaixa(vendas, caixas).map((c) => (
              <tr key={`pdf-caixa-${c.nome}`}><td>{c.nome} ({c.operador})</td><td>{c.vendas}</td><td>{c.fichas}</td><td>{moeda(c.total)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Sangrias e reforços</h2>
        <table>
          <thead><tr><th>Tipo</th><th>Valor</th><th>Caixa</th><th>Operador</th><th>Horário</th><th>Motivo</th></tr></thead>
          <tbody>
            {movimentacoes.length ? movimentacoes.map((m) => (
              <tr key={`pdf-mov-${m.id}`}>
                <td>{m.tipo}</td><td>{moeda(m.valor)}</td><td>{m.caixa?.nome || '-'}</td><td>{m.operador || '-'}</td><td>{new Date(m.criada_em).toLocaleString('pt-BR')}</td><td>{m.motivo || '-'}</td>
              </tr>
            )) : <tr><td colSpan="6">Nenhuma movimentação registrada.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="pdf-bloco">
        <h2>Vendas realizadas</h2>
        <table>
          <thead><tr><th>Venda</th><th>Horário</th><th>Caixa</th><th>Pagamento</th><th>Itens / fichas</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>
            {vendas.length ? vendas.map((v) => (
              <tr key={`pdf-venda-${v.id}`} className={v.status === 'cancelada' ? 'pdf-cancelada' : ''}>
                <td>#{numero(v.numero)}</td>
                <td>{new Date(v.criada_em).toLocaleString('pt-BR')}</td>
                <td>{v.caixa?.nome || '-'}</td>
                <td>{v.forma_pagamento}</td>
                <td>{(v.itens || []).map((i) => `${i.quantidade}x ${i.nome_produto} • fichas ${ficha(i.ficha_inicio)}-${ficha(i.ficha_fim)}`).join(' | ')}</td>
                <td>{moeda(v.total)}</td>
                <td>{v.status}{v.status === 'cancelada' && v.motivo_cancelamento ? ` — ${v.motivo_cancelamento}` : ''}</td>
              </tr>
            )) : <tr><td colSpan="7">Nenhuma venda registrada.</td></tr>}
          </tbody>
        </table>
      </section>

      <div className="pdf-rodape">AGENDO Eventos • Documento gerado automaticamente pelo Caixa Principal</div>
    </div>
  );
}

function cssImpressao(largura) {
  return `
@media print {
  @page { size: ${largura} auto; margin: 0; }
  body.imprimindo-fichas .area-impressao { width: ${largura} !important; }
  .ficha-termica { width: ${largura} !important; }
}
`;
}

const css = `
:root {
  --ag-blue: #0E7EA8;
  --ag-blue-dark: #06344F;
  --ag-green: #96C11F;
  --ag-red: #E63214;
  --ag-bg: #F8F7F2;
  --ag-bg-2: #EEF4E8;
  --ag-border: #E0DDD5;
  --ag-text: #2C2C2A;
  --ag-muted: #7D7A72;
  --ag-card: rgba(255,255,255,0.78);
}

* { box-sizing: border-box; }
html, body, #root { width: 100%; min-height: 100%; margin: 0; }
body {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  background: linear-gradient(135deg, var(--ag-bg) 0%, var(--ag-bg-2) 100%);
  color: var(--ag-text);
  font-size: 13px;
  letter-spacing: -0.011em;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}
button, input, select { font: inherit; }
button { cursor: pointer; transition: transform .08s ease, filter .15s ease, border-color .15s ease; }
button:not(:disabled):hover { filter: brightness(.98); }
button:not(:disabled):active { transform: scale(.985); }
button:disabled, input:disabled, select:disabled { cursor: not-allowed; opacity: .55; }

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 228px 1fr;
  position: relative;
  isolation: isolate;
  background: linear-gradient(135deg, var(--ag-bg) 0%, var(--ag-bg-2) 100%);
}
.app-shell::before {
  content: "";
  position: fixed;
  right: -7vw;
  bottom: 3vh;
  width: clamp(230px, 34vw, 520px);
  height: clamp(230px, 34vw, 520px);
  z-index: -1;
  pointer-events: none;
  user-select: none;
  background: url('/agendo-logo.png') center/contain no-repeat;
  opacity: 0.055;
  filter: grayscale(100%);
}

.sidebar {
  height: 100vh;
  position: sticky;
  top: 0;
  background: rgba(255,255,255,0.52);
  border-right: 0.5px solid var(--ag-border);
  backdrop-filter: blur(16px);
  display: flex;
  flex-direction: column;
  box-shadow: none;
  padding: 0;
  gap: 0;
}
.brand {
  min-height: 60px;
  padding: 13px 14px;
  border-bottom: 0.5px solid var(--ag-border);
  display: flex;
  align-items: center;
  gap: 9px;
}
.logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--ag-blue);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
  font-size: 13px;
  letter-spacing: -0.04em;
  flex-shrink: 0;
}
.brand strong {
  display: block;
  font-size: 12.5px;
  font-weight: 750;
  color: var(--ag-blue-dark);
  line-height: 1.2;
  letter-spacing: -0.02em;
}
.brand span {
  display: block;
  font-size: 9.5px;
  color: #9BBFCE;
  margin-top: 1px;
}
.brand::after { display: none; }
.evento-card {
  margin: 10px 12px;
  background: rgba(255,255,255,0.8);
  border: 0.5px solid var(--ag-border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.evento-card small {
  font-size: 9.5px;
  color: #B4B2A9;
  text-transform: uppercase;
  letter-spacing: .09em;
  font-weight: 650;
}
.evento-card strong { font-size: 12px; font-weight: 800; color: var(--ag-blue-dark); }
.evento-card span { font-size: 10.5px; color: var(--ag-muted); }

.sessao-card { gap: 6px; }
.sessao-card select { width: 100%; border: 0.5px solid var(--ag-border); border-radius: 9px; padding: 7px; background: rgba(255,255,255,.85); color: var(--ag-blue-dark); font-size: 11px; margin-top: 4px; }
.acesso-card { gap: 8px; }
.acesso-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.acesso-switch button {
  border: 0.5px solid var(--ag-border);
  background: rgba(255,255,255,0.74);
  border-radius: 9px;
  padding: 7px 8px;
  color: var(--ag-blue-dark);
  font-size: 11px;
  font-weight: 750;
}
.acesso-switch button.ativo { background: rgba(14,126,168,.1); border-color: rgba(14,126,168,.3); color: var(--ag-blue); }
.acesso-card select { width: 100%; border: 0.5px solid var(--ag-border); border-radius: 9px; padding: 7px; background: rgba(255,255,255,.85); color: var(--ag-blue-dark); font-size: 11px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 10px; margin-top: 14px; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; color: var(--ag-muted); font-size: 11px; font-weight: 700; }
.form-grid .botao { align-self: end; }
.opcoes-grid { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 10px; margin-top: 12px; }
.opcao-card { text-align: left; border: 0.5px solid var(--ag-border); border-radius: 14px; background: rgba(255,255,255,.78); padding: 12px; min-height: 84px; display: flex; flex-direction: column; gap: 5px; }
.opcao-card strong { color: var(--ag-blue-dark); font-size: 13px; }
.opcao-card span { color: var(--ag-muted); font-size: 11px; line-height: 1.35; }
.opcao-card.ativa { border-color: rgba(14,126,168,.35); background: rgba(14,126,168,.08); }
.nota-config { margin-top: 12px; padding: 10px 12px; border: 0.5px solid rgba(14,126,168,.14); border-radius: 12px; background: rgba(255,255,255,.65); color: var(--ag-muted); font-size: 12px; }
.opcao-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--ag-text); margin-top: 10px; cursor: pointer; }
.opcao-toggle input { width: 18px; height: 18px; }

nav { display: flex; flex-direction: column; overflow-y: auto; padding: 4px 0 10px; }
nav::before {
  content: "Operação";
  font-size: 9.5px;
  color: #B4B2A9;
  padding: 10px 1.1rem 2px;
  text-transform: uppercase;
  letter-spacing: .09em;
  font-weight: 600;
}
nav button {
  border: none;
  background: transparent;
  color: #5F5E5A;
  text-align: left;
  padding: 8.5px 1.1rem;
  font-size: 12.5px;
  border-left: 2px solid transparent;
  font-weight: 450;
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 0;
}
nav button:hover { background: rgba(14,126,168,0.06); color: var(--ag-blue); }
nav button.ativo { color: var(--ag-blue); background: rgba(14,126,168,0.08); border-left-color: var(--ag-blue); font-weight: 700; }
.rodape-side {
  margin-top: auto;
  border-top: 0.5px solid var(--ag-border);
  padding: 11px 14px;
  color: var(--ag-muted);
  display: flex;
  flex-direction: column;
}
.rodape-side span { display: block; font-size: 10.5px; }
.rodape-side strong { display: block; margin-top: 2px; font-size: 12px; color: var(--ag-blue-dark); }
.sair-acesso { margin-top: 10px; width: 100%; border: 0.5px solid rgba(14,126,168,.18); background: rgba(255,255,255,.66); color: var(--ag-blue-dark); border-radius: 10px; padding: 8px 10px; font-weight: 800; font-size: 11px; text-align: center; }

.conteudo {
  min-width: 0;
  padding: 1.25rem 1.5rem 2.5rem;
  position: relative;
  max-width: 1500px;
  width: 100%;
  margin: 0 auto;
}
.topo {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 14px;
  padding: 4px 2px 12px;
  border-bottom: 0.5px solid var(--ag-border);
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ag-blue);
  font-size: 10.5px;
  font-weight: 800;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: .07em;
}
.eyebrow::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--ag-green);
  box-shadow: 0 0 0 4px rgba(150,193,31,0.16);
}
.topo h1 {
  margin: 0;
  font-size: 25px;
  color: var(--ag-blue-dark);
  letter-spacing: -0.04em;
  line-height: 1.1;
}
.topo p { margin: 6px 0 0; color: var(--ag-muted); font-size: 12px; }

.mensagem {
  border-radius: 12px;
  padding: 10px 12px;
  font-weight: 700;
  margin-bottom: 14px;
  font-size: 12px;
}
.mensagem.ok { background: rgba(150,193,31,0.12); color: #55710B; border: 0.5px solid rgba(150,193,31,0.35); }
.mensagem.erro { background: rgba(230,50,20,0.08); border: 0.5px solid rgba(230,50,20,0.25); color: var(--ag-red); }
.mensagem.aviso { background: #FBF0DA; border: 0.5px solid #EAC77A; color: #854F0B; }
.mensagem-com-acao { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.mini-print { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; font-size: 11.5px; flex-shrink: 0; }
.mini-print i { font-size: 14px; }
.resumo-faixa {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 0.5px solid rgba(14,126,168,0.12);
  border-radius: 14px;
  background: rgba(255,255,255,0.72);
  color: #5F5E5A;
  font-size: 12px;
  backdrop-filter: blur(12px);
}
.resumo-faixa b { color: var(--ag-blue-dark); font-weight: 850; }
.resumo-faixa span { display: inline-flex; align-items: center; gap: 5px; }
.resumo-faixa span + span::before { content: "•"; color: #B8B4AA; margin-right: 3px; }

.grid { display: grid; gap: 10px; }
.painel-grid { grid-template-columns: repeat(4, minmax(130px, 1fr)); }
.span2 { grid-column: span 2; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.card {
  background: var(--ag-card);
  border: 0.5px solid var(--ag-border);
  border-radius: 14px;
  box-shadow: none;
  overflow: hidden;
  backdrop-filter: blur(10px);
  padding: 12px;
}
.card h2 { margin: 0 0 4px; font-size: 15px; color: var(--ag-blue-dark); }
.card h3 { margin: 18px 0 7px; font-size: 13px; color: var(--ag-blue-dark); }
.card p { margin: 4px 0 0; color: var(--ag-muted); font-size: 11.5px; line-height: 1.4; }
.kpi { display: flex; flex-direction: column; gap: 4px; min-height: 88px; }
.kpi span { display: block; color: var(--ag-muted); font-size: 10.5px; margin-bottom: 2px; }
.kpi strong { display: block; color: var(--ag-blue-dark); font-size: 19px; letter-spacing: -0.035em; }
.kpi small { display: block; color: #9A978E; margin-top: 2px; font-size: 10px; }

.cabecalho-card,
.fechamento-topo { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
.acoes, .acoes-linha { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.botao, .mini {
  border: 0.5px solid var(--ag-border);
  background: rgba(255,255,255,0.82);
  color: var(--ag-blue-dark);
  border-radius: 10px;
  padding: 8px 10px;
  font-weight: 750;
  font-size: 11.5px;
}
.botao.verde { background: var(--ag-green); color: #fff; border-color: var(--ag-green); }
.botao.perigo, .mini.perigo { border-color: rgba(230,50,20,0.25); background: rgba(230,50,20,0.08); color: var(--ag-red); }
.mini { padding: 6px 8px; font-size: 10.5px; }

.grid-venda { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, .9fr); gap: 14px; align-items: start; }
.produtos-grid { display: grid; grid-template-columns: repeat(2, minmax(150px, 1fr)); gap: 10px; margin-top: 10px; }
.produto-btn {
  border: 0.5px solid rgba(14,126,168,0.12);
  background: rgba(255,255,255,0.88);
  border-radius: 16px;
  padding: 13px;
  text-align: left;
  min-height: 105px;
  box-shadow: 0 8px 18px rgba(6,52,79,0.035);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.produto-btn:hover { border-color: rgba(14,126,168,0.55); box-shadow: 0 8px 18px rgba(14,126,168,0.08); }
.produto-btn strong { display: block; color: var(--ag-text); font-size: 14px; }
.produto-btn span { display: block; color: var(--ag-blue); font-size: 20px; font-weight: 850; letter-spacing: -0.04em; }
.produto-btn small { display: block; color: var(--ag-muted); font-size: 10.5px; }
.carrinho-card { align-self: start; position: sticky; top: 12px; }
.total-grande { font-size: 22px; color: var(--ag-blue-dark); letter-spacing: -0.04em; }
.lista-carrinho { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.linha-carrinho {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 10px;
  border: 0.5px solid #E8E6DE;
  border-radius: 12px;
  background: rgba(248,247,242,0.65);
}
.linha-carrinho strong { font-size: 13px; color: var(--ag-text); }
.linha-carrinho small { display: block; color: var(--ag-muted); margin-top: 3px; font-size: 10.5px; }
.qtd-actions { display: flex; align-items: center; gap: 8px; }
.qtd-actions button { width: 30px; height: 30px; border: 0.5px solid var(--ag-border); background: #fff; border-radius: 9px; font-weight: 900; }
.label { display: block; font-weight: 850; color: var(--ag-muted); margin: 12px 0 7px; font-size: 11px; }
.pagamentos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.aviso-pagamento { font-size: 11px; color: #7D7A72; background: rgba(255,200,0,.08); border: 0.5px solid rgba(230,150,20,.25); border-radius: 10px; padding: 8px 10px; margin-top: 8px; }
.fiado-pessoa-box { margin-top: 8px; }
.fiado-pessoa-box select { width: 100%; margin-bottom: 6px; }
.pagamentos button {
  border: 0.5px solid var(--ag-border);
  background: rgba(255,255,255,0.82);
  border-radius: 10px;
  padding: 9px 8px;
  font-weight: 750;
  font-size: 11.5px;
}
.pagamentos button.ativo { background: rgba(14,126,168,0.08); border-color: rgba(14,126,168,0.35); color: var(--ag-blue); }
.troco-box { margin-top: 12px; }
.troco-box input,
.linha-form input,
.linha-form select,
td input {
  width: 100%;
  border: 0.5px solid var(--ag-border);
  border-radius: 10px;
  padding: 9px 10px;
  background: rgba(255,255,255,0.86);
  color: var(--ag-text);
}
.troco-linha { display: flex; justify-content: space-between; margin-top: 8px; border: 0.5px solid var(--ag-border); border-radius: 12px; padding: 10px; background: rgba(248,247,242,0.68); }
.botoes-finalizar { display: grid; grid-template-columns: 1fr 1.5fr; gap: 10px; margin-top: 14px; }
.linha-form { display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: 10px; }

.tabela-scroll { overflow: auto; border-radius: 12px; border: 0.5px solid #E8E6DE; background: rgba(255,255,255,0.62); -webkit-overflow-scrolling: touch; }
table { width: 100%; min-width: 640px; border-collapse: collapse; }
th, td { text-align: left; border-bottom: 0.5px solid #E8E6DE; padding: 9px 10px; vertical-align: middle; font-size: 12px; white-space: nowrap; }
th { color: #7D7A72; background: rgba(248,247,242,0.7); font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
tr:last-child td { border-bottom: none; }
.pill { display: inline-flex; border-radius: 999px; padding: 5px 8px; background: #ECECEC; color: #555; font-weight: 850; font-size: 10.5px; }
.pill.ok { background: rgba(150,193,31,0.13); color: #55710B; }
.pill.erro { background: rgba(230,50,20,0.08); color: var(--ag-red); }
.cancelada { opacity: .62; }
.vazio {
  border: 1px dashed #D7D4CA;
  border-radius: 12px;
  padding: 22px 12px;
  color: #8B887F;
  text-align: center;
  background: rgba(248,247,242,0.65);
  font-size: 12px;
}
.tela-carregando { min-height: 100vh; display: grid; place-items: center; font-size: 18px; font-weight: 850; color: var(--ag-blue-dark); background: linear-gradient(135deg, var(--ag-bg), var(--ag-bg-2)); }

.login-agendo-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #F8F7F2 0%, #EEF4E8 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  position: relative;
  overflow: hidden;
}
.login-watermark-logo {
  position: fixed;
  left: -8vw;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  z-index: 0;
  opacity: 0.07;
  filter: grayscale(100%);
}
.login-watermark-logo img {
  width: 38vw;
  max-width: 420px;
  min-width: 240px;
}
.login-conteudo {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 740px;
}
.login-institucional {
  text-align: center;
  margin-bottom: 1rem;
}
.login-institucional div {
  font-size: 12px;
  color: #888780;
  letter-spacing: .05em;
  text-transform: uppercase;
  font-weight: 600;
}
.login-institucional small {
  display: block;
  font-size: 11px;
  color: #B4B2A9;
  margin-top: 2px;
}
.login-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.25rem;
}
.login-card {
  border-radius: 16px;
  border: .5px solid #E8E6DE;
  padding: 1.5rem;
  box-shadow: 0 2px 24px rgba(0,0,0,0.08);
  backdrop-filter: blur(8px);
  min-height: 368px;
}
.login-card-interno {
  background: rgba(255,255,255,0.92);
  display: flex;
  flex-direction: column;
}
.login-card-publico {
  background: linear-gradient(135deg, rgba(234,244,252,0.97) 0%, rgba(236,246,240,0.95) 60%, rgba(240,248,244,0.93) 100%);
  border-color: #C0DD97;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.login-card-logo {
  text-align: center;
  margin-bottom: .85rem;
}
.login-card-logo img {
  height: 44px;
  width: auto;
  max-width: 180px;
  object-fit: contain;
  display: block;
  margin: 0 auto 6px;
}
.login-card-titulo {
  font-size: 16px;
  font-weight: 600;
  color: #2C2C2A;
  margin-bottom: 3px;
  text-align: center;
}
.login-card-publico .login-card-titulo,
.login-card-publico .login-card-subtitulo {
  text-align: left;
}
.login-card-subtitulo {
  font-size: 12px;
  color: #888780;
  text-align: center;
  line-height: 1.45;
}

.login-form { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.login-form label { display: grid; gap: 4px; font-size: 12px; color: #5F5E5A; }
.login-form input {
  width: 100%;
  font-size: 13px;
  padding: 8px 10px;
  border: .5px solid #D3D1C7;
  border-radius: 8px;
  background: #FAFAF8;
  color: #2C2C2A;
}
.login-alert { font-size: 12px; border-radius: 8px; padding: 7px 10px; border: .5px solid transparent; }
.login-alert.erro { color: #E63214; background: #FEF2F2; border-color: #F7C1C1; }
.login-alert.ok { color: #0E7EA8; background: #E6F1FB; border-color: #B5D4F4; }
.login-link { background: none; border: none; font-size: 11px; color: #888780; cursor: pointer; text-decoration: underline; padding: 0; margin-top: 2px; }
.login-beneficios { display: flex; flex-direction: column; gap: 8px; margin: 0 0 1rem; }
.login-beneficios div { display: flex; align-items: center; gap: 8px; color: #0E7EA8; font-size: 12px; }
.login-beneficios i { font-size: 15px; }
.side-actions { display: grid; grid-template-columns: 1fr; gap: 6px; width: 100%; }
.sair-acesso.danger { color: #E63214; border-color: rgba(230,50,20,.2); }

.login-divisor {
  height: .5px;
  background: #E8E6DE;
  margin: 1.25rem 0;
}
.login-divisor.soft {
  background: rgba(0,0,0,0.08);
  margin: 1rem 0;
}
.login-btn-primary {
  width: 100%;
  padding: 10px;
  background: #0E7EA8;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 4px;
  letter-spacing: .02em;
}
.login-btn-primary:hover {
  background: #0B6E93;
}
.login-ajuda {
  margin-top: .75rem;
  font-size: 11px;
  line-height: 1.55;
  color: #888780;
  text-align: center;
}
.login-restrito {
  text-align: center;
  margin-top: auto;
  padding-top: 1rem;
  font-size: 11px;
  color: #B4B2A9;
}
.login-restrito span { margin-right: 4px; }
.login-texto {
  font-size: 12px;
  color: #5F5E5A;
  line-height: 1.7;
  margin: 0 0 1rem;
}
.login-caixas-lista {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 1rem;
}
.login-caixa-btn {
  width: 100%;
  background: rgba(255,255,255,.72);
  border: .5px solid rgba(14,126,168,.18);
  border-radius: 8px;
  padding: 9px 10px;
  text-align: left;
  cursor: pointer;
  display: grid;
  grid-template-columns: 1fr;
  gap: 2px;
}
.login-caixa-btn:hover {
  border-color: #0E7EA8;
  background: #fff;
}
.login-caixa-btn span {
  font-size: 12px;
  color: #0E7EA8;
  font-weight: 700;
}
.login-caixa-btn strong {
  font-size: 13px;
  color: #2C2C2A;
  font-weight: 600;
}
.login-caixa-btn small {
  font-size: 10.5px;
  color: #888780;
}
.login-nota {
  font-size: 10px;
  color: #888780;
  line-height: 1.6;
  padding: 8px 10px;
  background: rgba(255,255,255,0.5);
  border-radius: 8px;
}
.login-publico-rodape {
  text-align: center;
  margin-top: 1rem;
  font-size: 11px;
  color: #0E7EA8;
}
.login-publico-rodape i, .login-restrito i { margin-right: 4px; vertical-align: -1px; }
.login-trocar-usuario { text-align: center; margin-top: 12px; }
.login-trocar-usuario button { background: none; border: none; color: #888780; font-size: 11px; text-decoration: underline; cursor: pointer; }
.login-footer {
  margin-top: 1rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.login-footer img {
  height: 18px;
  width: auto;
  opacity: .85;
}
.login-footer span {
  font-size: 11px;
  color: #B4B2A9;
}

.relatorio h2 { font-size: 17px; }
.relatorio p { font-size: 12px; }

.relatorio-pdf-hidden { display: none; }
.relatorio-pdf-hidden h1,
.relatorio-pdf-hidden h2,
.relatorio-pdf-hidden p { margin: 0; }
.relatorio-pdf-hidden .pdf-topo { border-bottom: 2px solid #06344F; padding-bottom: 10px; margin-bottom: 14px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.relatorio-pdf-hidden .pdf-marca { color: #0E7EA8; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
.relatorio-pdf-hidden .pdf-topo h1 { color: #06344F; font-size: 22px; margin-top: 4px; }
.relatorio-pdf-hidden .pdf-topo p { color: #5F5E5A; font-size: 11px; margin-top: 4px; }
.relatorio-pdf-hidden .pdf-selo { border: 1px solid #D9D6CE; border-radius: 999px; padding: 6px 10px; color: #06344F; font-weight: 800; font-size: 10px; white-space: nowrap; }
.relatorio-pdf-hidden .pdf-bloco { margin-top: 14px; page-break-inside: avoid; break-inside: avoid; }
.relatorio-pdf-hidden .pdf-bloco h2 { color: #06344F; font-size: 14px; margin-bottom: 7px; border-bottom: 1px solid #E0DDD5; padding-bottom: 5px; }
.relatorio-pdf-hidden .pdf-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.relatorio-pdf-hidden .pdf-kpi { border: 1px solid #E0DDD5; border-radius: 8px; padding: 8px; background: #fff; }
.relatorio-pdf-hidden .pdf-kpi span { display: block; color: #6F6C66; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
.relatorio-pdf-hidden .pdf-kpi strong { display: block; color: #06344F; font-size: 16px; margin-top: 4px; }
.relatorio-pdf-hidden .pdf-rodape { margin-top: 16px; border-top: 1px solid #E0DDD5; padding-top: 8px; font-size: 9px; color: #6F6C66; text-align: center; }
.relatorio-pdf-hidden .pdf-cancelada { color: #777; text-decoration: line-through; }

.print-only { display: none; }
.ficha-termica { width: 58mm; padding: 1.5mm 3mm; text-align: center; font-family: Arial, sans-serif; color: #000; page-break-after: always; }
.ficha-topo { font-size: 11px; font-weight: 900; }
.ficha-sub { font-size: 8px; font-weight: 600; margin-bottom: 1px; }
.ficha-termica h2 { font-size: 14px; margin: 2px 0; color: #000; }
.ficha-termica h1 { font-size: 22px; margin: 2px 0; text-transform: uppercase; color: #000; line-height: 1.05; }
.ficha-termica h3 { font-size: 15px; font-weight: 800; margin: 1px 0 2px; color: #000; }
.ficha-termica p { font-size: 8px; margin: 1px 0; color: #000; }
.ficha-marca { font-size: 8px; font-weight: 900; letter-spacing: 1px; margin-top: 2px; }
.cupom-sorteio .ficha-topo { font-size: 12px; }
.cupom-sorteio h1 { font-size: 30px; letter-spacing: 2px; margin: 2px 0; }
.linha-pontilhada { border-top: 1px dashed #000; margin: 4px 0; }



/* ===== AJUSTE FINO — PADRÃO CAPETTE / AGENDO INTEGRA ===== */
.app-shell { grid-template-columns: 228px 1fr; }
.sidebar {
  background: rgba(255,255,255,0.52);
  border-right: 0.5px solid #E0DDD5;
  box-shadow: none;
}
.brand {
  min-height: 60px;
  padding: 13px 14px;
  gap: 9px;
  border-bottom: 0.5px solid #E0DDD5;
}
.brand-logo { width: 32px; height: 32px; object-fit: contain; }
.brand strong { font-size: 12.5px; font-weight: 700; color: #06344F; letter-spacing: -0.02em; }
.brand span { font-size: 9.5px; color: #9BBFCE; }
.evento-card {
  margin: 10px 12px;
  background: rgba(255,255,255,0.80);
  border: 0.5px solid #E0DDD5;
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: none;
}
.evento-oscard img {
  width: 112px;
  max-height: 42px;
  object-fit: contain;
  object-position: left center;
  margin-bottom: 8px;
}
.evento-card small { font-size: 9.5px; font-weight: 600; color: #B4B2A9; letter-spacing: .09em; }
.evento-card strong { font-size: 12px; font-weight: 800; color: #06344F; }
.evento-card span { font-size: 10.5px; color: #7D7A72; }
nav { padding: 4px 0 10px; }
.nav-secao-titulo {
  font-size: 9.5px;
  color: #B4B2A9;
  padding: 10px 1.1rem 2px;
  text-transform: uppercase;
  letter-spacing: .09em;
  font-weight: 500;
}
nav button {
  padding: 8.5px 1.1rem;
  gap: 9px;
  font-size: 12.5px;
  font-weight: 400;
  color: #5F5E5A;
  background: transparent;
  border-left: 2px solid transparent;
  border-radius: 0;
}
.nav-icone { font-size: 15px; width: 15px; height: 15px; opacity: .88; }
nav button:hover {
  background: rgba(14,126,168,0.06);
  color: #0E7EA8;
}
nav button.ativo {
  background: rgba(14,126,168,0.08);
  color: #0E7EA8;
  border-left-color: #0E7EA8;
  font-weight: 500;
}
.rodape-side {
  grid-template-columns: 32px 1fr auto;
  padding: 10px 12px;
  border-top: 0.5px solid #E0DDD5;
  gap: 9px;
}
.user-badge { width: 32px; height: 32px; background: rgba(14,126,168,.12); color: #0E7EA8; }
.side-actions { display: flex; flex-direction: column; gap: 5px; }
.sair-acesso { padding: 5px 8px; font-size: 10px; border-radius: 999px; }
.conteudo { padding: 1.35rem 1.55rem 2.5rem; }
.topo h1 { font-size: 27px; }
.card { box-shadow: none; border-color: #E0DDD5; }
.card.kpi { border-top: 0.5px solid #E0DDD5; }

@media (max-width: 1000px) {
  .app-shell { grid-template-columns: 1fr; }
  .sidebar { height: auto; position: relative; }
  .painel-grid, .grid-venda, .produtos-grid { grid-template-columns: 1fr; }
  .span2 { grid-column: auto; }
  .linha-form { grid-template-columns: 1fr; }
  .topo { flex-direction: column; }
  .conteudo { padding: 1rem; }
  .carrinho-card { position: static; }
  .pagamentos { grid-template-columns: repeat(2, 1fr); }
  .acesso-opcoes { grid-template-columns: 1fr; }
  .acesso-logo-row h1 { font-size: 34px; }
  .acesso-panel { padding: 18px; border-radius: 20px; }
}

@media print {
  body { background: #fff; }
  .no-print, .sidebar, .topo, .resumo-faixa, .mensagem { display: none !important; }
  body.imprimindo-fichas .app-shell { display: none !important; }
  body.imprimindo-fichas .area-impressao { display: block !important; width: 58mm !important; margin: 0 !important; }
  body:not(.imprimindo-fichas) .area-impressao { display: none !important; }
  body:not(.imprimindo-fichas) .app-shell { display: block !important; min-height: auto !important; }
  body:not(.imprimindo-fichas) .conteudo { padding: 0 !important; max-width: none !important; }
  .ficha-termica { width: 58mm !important; margin: 0 !important; box-shadow: none !important; }
  .print-area { display: block !important; box-shadow: none !important; border: none !important; padding: 0 !important; }
  .print-area table { font-size: 12px; }
  .print-area h2 { font-size: 22px; }
}

@media print {
  body.imprimindo-relatorio {
    background: #fff !important;
  }
  body.imprimindo-relatorio * {
    visibility: hidden !important;
  }
  body.imprimindo-relatorio .app-shell,
  body.imprimindo-relatorio .area-impressao {
    display: none !important;
  }
  body.imprimindo-relatorio .relatorio-pdf-hidden,
  body.imprimindo-relatorio .relatorio-pdf-hidden * {
    visibility: visible !important;
  }
  body.imprimindo-relatorio .relatorio-pdf-hidden {
    position: absolute !important;
    left: 0 !important;
    top: 0 !important;
    display: block !important;
    width: 100% !important;
    background: #fff !important;
    color: #111 !important;
    font-family: Arial, sans-serif !important;
    font-size: 11px !important;
    padding: 0 !important;
  }
  body.imprimindo-relatorio .relatorio-pdf-hidden table {
    width: 100% !important;
    border-collapse: collapse !important;
    page-break-inside: auto !important;
  }
  body.imprimindo-relatorio .relatorio-pdf-hidden th,
  body.imprimindo-relatorio .relatorio-pdf-hidden td {
    border: 1px solid #D9D6CE !important;
    padding: 5px 6px !important;
    font-size: 10px !important;
    color: #111 !important;
    text-align: left !important;
    vertical-align: top !important;
  }
  body.imprimindo-relatorio .relatorio-pdf-hidden th {
    background: #F1F1ED !important;
    color: #111 !important;
    font-weight: 700 !important;
  }
  body.imprimindo-relatorio .relatorio-pdf-hidden tr,
  body.imprimindo-relatorio .relatorio-pdf-hidden .pdf-bloco,
  body.imprimindo-relatorio .relatorio-pdf-hidden .pdf-kpi {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
}


/* ===== PADRÃO AGENDO INTEGRA — AJUSTE FINAL ===== */
.app-shell { grid-template-columns: 252px 1fr; }
.sidebar { background: rgba(255,255,255,0.54); }
.brand { min-height: 72px; padding: 15px 16px; gap: 10px; }
.brand-logo { width: 36px; height: 36px; object-fit: contain; flex-shrink: 0; }
.logo { display: none; }
.brand strong { font-size: 14px; color: #06344F; }
.brand span { color: #82AABF; font-size: 10px; }
.evento-card { margin: 12px 14px; border-radius: 14px; background: rgba(255,255,255,.78); padding: 12px 13px; }
.evento-oscard img { width: 112px; max-height: 42px; object-fit: contain; object-position: left center; margin-bottom: 8px; }
.evento-card strong { font-size: 13px; }
.evento-card span { font-size: 11px; }
nav { padding: 0 0 12px; }
nav::before { content: none; }
.nav-secao { padding: 0; }
.nav-secao-titulo { font-size: 9.5px; color: #B4B2A9; padding: 11px 1.1rem 3px; text-transform: uppercase; letter-spacing: .09em; font-weight: 700; }
nav button { gap: 9px; padding: 9px 1.1rem; font-size: 12.5px; }
.nav-icone { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: inherit; font-size: 13px; flex-shrink: 0; }
.rodape-side { display: grid; grid-template-columns: 32px 1fr auto; align-items: center; gap: 9px; padding: 11px 14px; }
.user-badge { width: 32px; height: 32px; border-radius: 50%; background: rgba(14,126,168,.13); color: #0E7EA8; display: grid; place-items: center; font-weight: 850; font-size: 11px; }
.rodape-side span { font-size: 10.5px; color: #7D7A72; }
.rodape-side strong { font-size: 11px; margin: 0; color: #06344F; }
.sair-acesso { margin: 0; padding: 5px 8px; border-radius: 999px; width: auto; font-size: 10px; }
.conteudo { padding: 1.35rem 1.65rem 2.5rem; }
.topo { align-items: center; margin-bottom: 16px; }
.topo h1 { font-size: 28px; }
.topo-acoes { display: flex; gap: 8px; align-items: center; }
.topo-btn { border: .5px solid var(--ag-border); background: rgba(255,255,255,.8); color: #5F5E5A; border-radius: 10px; padding: 9px 13px; font-size: 12px; font-weight: 700; }
.topo-btn.principal { background: #0E7EA8; border-color: #0E7EA8; color: #fff; box-shadow: 0 8px 20px rgba(14,126,168,.16); }
.card { border-radius: 16px; background: rgba(255,255,255,.80); box-shadow: 0 14px 34px rgba(6,52,79,.055); }
.card.kpi { border-top: 3px solid rgba(14,126,168,.85); }
.produto-btn { border-radius: 16px; min-height: 106px; }
.resumo-faixa { border-radius: 16px; }
.acesso-panel { border-radius: 26px; }
.acesso-agendo-logo { width: 64px; height: 64px; object-fit: contain; flex-shrink: 0; }
.acesso-logo { display: none; }
.acesso-marca { color: #0E7EA8; }
.acesso-opcao.principal { border-top: 3px solid #0E7EA8; }
.acesso-opcao.caixa { border-left: 3px solid rgba(150,193,31,.65); }

/* ===== Sidebar recolhível (padrão Layout.jsx do CAPETTE) ===== */
.app-shell.colapsado { grid-template-columns: 64px 1fr; }
.app-shell.colapsado .sidebar { width: 64px; }
.app-shell .sidebar { transition: width .2s cubic-bezier(.2,.8,.3,1); width: 228px; }
.colapsar-btn {
  border: none; background: none; cursor: pointer; color: rgba(155,191,206,0.6);
  padding: 4px; line-height: 1; display: flex; margin-left: auto; flex-shrink: 0;
}
.colapsar-btn:hover { color: #0E7EA8; }
.app-shell.colapsado .brand { justify-content: center; padding: 14px 0; }
.app-shell.colapsado .brand-logo { width: 32px; height: 32px; }
.app-shell.colapsado .colapsar-btn { margin: 6px auto 0; }
.nav-secao-titulo { display: flex; align-items: center; justify-content: space-between; user-select: none; }
.nav-secao-titulo i { font-size: 11px; }
.app-shell.colapsado .nav-secao { height: 10px; border-bottom: 0.5px solid #F1EFE8; margin-bottom: 4px; overflow: hidden; }
.app-shell.colapsado nav button { justify-content: center; padding: 10px 0; }
.app-shell.colapsado .nav-icone { font-size: 17px; }
.rodape-side { display: flex; flex-direction: row; align-items: center; gap: 9px; }
.user-info { text-align: left; }
.sidebar-scroll { scrollbar-width: thin; scrollbar-color: #D3D1C7 transparent; }
.sidebar-scroll::-webkit-scrollbar { width: 5px; }
.sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
.sidebar-scroll::-webkit-scrollbar-thumb { background: #D3D1C7; border-radius: 99px; }
.sidebar-scroll::-webkit-scrollbar-thumb:hover { background: #B4B2A9; }
.app-shell.colapsado .rodape-side { flex-direction: column; padding: .7rem 0; }
.user-badge { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 10px; flex-shrink: 0; }
.user-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.user-info span { font-size: 10.5px; color: #7D7A72; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.user-info strong { font-size: 11px; color: #06344F; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side-actions { display: flex; flex-direction: row; gap: 5px; flex-shrink: 0; }
.sair-acesso { border-radius: 50%; width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; }
.sair-acesso.danger { color: #E63214; border-color: rgba(230,50,20,.2); }
.rodape-conteudo {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 2px 0; margin-top: 14px; border-top: 0.5px solid #E8E6DE;
  font-size: 10px; color: #B4B2A9;
}
.rodape-conteudo .rodape-marca { color: #D3D1C7; }

@media (max-width: 1000px) {
  .app-shell.colapsado { grid-template-columns: 1fr; }
}

/* ===== Hierarquia de ações rápidas (padrão 1 grande + 2 médias + chips) ===== */
.acoes-rapidas { display: grid; gap: 10px; margin-bottom: 14px; }
.acao-grande {
  display: flex; align-items: center; gap: 14px;
  border: none; border-radius: 18px; padding: 18px 20px;
  background: linear-gradient(135deg, #0E7EA8 0%, #096484 100%);
  color: #fff; text-align: left;
  box-shadow: 0 14px 30px rgba(14,126,168,.25);
}
.acao-grande i { font-size: 26px; flex-shrink: 0; }
.acao-grande strong { display: block; font-size: 16px; }
.acao-grande span { display: block; font-size: 12px; opacity: .85; margin-top: 2px; }
.acoes-medias { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.acao-media {
  display: flex; align-items: center; gap: 9px;
  border: 0.5px solid var(--ag-border); border-radius: 14px; padding: 13px 14px;
  background: rgba(255,255,255,.82); color: #06344F; font-weight: 700; font-size: 12.5px;
}
.acao-media i { font-size: 17px; color: #0E7EA8; }
.acoes-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 0.5px solid var(--ag-border); border-radius: 999px; padding: 6px 12px;
  background: rgba(255,255,255,.7); color: #5F5E5A; font-size: 11px; font-weight: 600;
}
.chip i { font-size: 13px; color: #96C11F; }
@media (max-width: 1000px) { .acoes-medias { grid-template-columns: 1fr; } }

/* ===== Drawer mobile + busca Ctrl+K (padrão Layout.jsx do CAPETTE) ===== */
@keyframes drawerIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 99; animation: fadeIn .18s ease; }
.drawer-mobile {
  position: fixed; left: 0; top: 0; bottom: 0; z-index: 100; width: 240px;
  background: #FCFBF8; overflow: hidden;
  animation: drawerIn .22s cubic-bezier(.2,.8,.3,1);
  -webkit-transform: translateZ(0);
  transform: translateZ(0);
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}
.drawer-mobile-inner {
  height: 100%; width: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch;
}
.drawer-mobile .sidebar {
  width: 240px;
  height: 100%;
  position: static;
  top: auto;
  backdrop-filter: none;
  background: transparent;
}
.topo-mobile {
  display: flex; align-items: center; gap: 10px; padding: .6rem 1rem;
  background: rgba(255,255,255,0.92); border-bottom: 0.5px solid #E8E6DE; margin: -1.35rem -1.65rem 1rem;
}
.topo-mobile img { height: 26px; width: auto; object-fit: contain; }
.topo-mobile button { border: none; background: none; font-size: 19px; color: #888780; padding: 4px; display: flex; }
.tabs-caixa {
  display: flex; align-items: center; gap: 8px; padding: .55rem .9rem;
  background: rgba(255,255,255,0.92); border-bottom: 0.5px solid #E8E6DE; margin: -1.35rem -1.65rem 1rem;
}
.tabs-caixa button {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  border: 0.5px solid var(--ag-border); border-radius: 12px; padding: 11px 8px;
  background: rgba(255,255,255,0.7); color: #5F5E5A; font-size: 12.5px; font-weight: 700;
}
.tabs-caixa button.ativo { background: #0E7EA8; border-color: #0E7EA8; color: #fff; box-shadow: 0 6px 16px rgba(14,126,168,.22); }
.tabs-caixa button i { font-size: 16px; }
.tabs-caixa-mais { flex: 0 0 auto !important; width: 40px; padding: 11px 0 !important; }
.categorias-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 2px; }
.categorias-tabs button {
  border: 0.5px solid var(--ag-border); border-radius: 999px; padding: 7px 14px;
  background: rgba(255,255,255,0.7); color: #5F5E5A; font-size: 11.5px; font-weight: 700;
}
.categorias-tabs button.ativo { background: #96C11F; border-color: #96C11F; color: #fff; }

.produto-btn.em-promocao { border: 1.5px solid #E63214; background: rgba(230,50,20,0.05); position: relative; padding-top: 22px; }
.produto-btn .selo-promo {
  display: inline-flex !important; position: absolute; top: 6px; right: 6px; background: #E63214; color: #fff;
  font-size: 8.5px !important; font-weight: 800; letter-spacing: .03em; padding: 2px 7px; border-radius: 999px;
  line-height: 1.6;
}
.preco-promo { display: flex; align-items: baseline; gap: 6px; }
.preco-promo s { font-size: 11px; color: #B4B2A9; font-weight: 400; }
.promo-celula { display: flex; flex-direction: column; gap: 5px; min-width: 130px; }
.promo-preco { width: 100%; }
.mini.verde { background: #96C11F; border-color: #96C11F; color: #fff; }
.busca-overlay {
  position: fixed; inset: 0; background: rgba(26,31,28,0.4); z-index: 9999;
  display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; backdrop-filter: blur(2px);
}
.busca-modal {
  background: rgba(255,255,255,0.98); border: 0.5px solid #E8E6DE; border-radius: 14px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.18); width: 100%; max-width: 480px; overflow: hidden; margin: 0 1rem;
}
.busca-input-linha { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 0.5px solid #E8E6DE; }
.busca-input-linha i { font-size: 16px; color: #888780; }
.busca-input-linha input { flex: 1; border: none; outline: none; font-size: 14px; background: transparent; color: #1A1F1C; }
.busca-esc { font-size: 10px; color: #C8C6BC; border: 0.5px solid #E8E6DE; border-radius: 5px; padding: 2px 6px; }
.busca-resultados { max-height: 320px; overflow-y: auto; padding: 6px 0; }
.busca-vazio { padding: 1.5rem; text-align: center; font-size: 12px; color: #888780; }
.busca-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; font-size: 13px; color: #2C2C2A; cursor: pointer; }
.busca-item:hover { background: rgba(14,126,168,0.08); }
.busca-item i { font-size: 15px; color: #888780; }

.drawer-mobile {
  border-radius: 0 18px 18px 0;
  box-shadow: 0 16px 40px rgba(6,52,79,.18);
}
.drawer-mobile .brand { padding: 16px 18px; }
.drawer-mobile .evento-card { margin: 12px 16px; padding: 14px 16px; }
.drawer-mobile nav { padding: 6px 0 12px; }
.drawer-mobile .nav-secao { margin-bottom: 2px; }
.drawer-mobile .nav-secao-titulo { padding: 13px 1.2rem 4px; }
.drawer-mobile nav button { padding: 11px 1.2rem; }
.drawer-mobile .rodape-side { padding: 13px 16px; }

.lista-vendas-mobile { display: flex; flex-direction: column; gap: 9px; }
.venda-card {
  border: 0.5px solid #E8E6DE; border-radius: 14px; padding: 12px 14px;
  background: rgba(255,255,255,0.85);
}
.venda-card.cancelada { opacity: .55; }
.venda-card-topo { display: flex; justify-content: space-between; align-items: baseline; }
.venda-card-topo strong { font-size: 14px; color: #06344F; }
.venda-card-valor { font-size: 16px; font-weight: 800; color: #0E7EA8; }
.venda-card-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: #7D7A72; margin-top: 4px; }
.venda-card-itens { font-size: 11.5px; color: #5F5E5A; margin-top: 6px; line-height: 1.4; }
.venda-card-sorteio { font-size: 11.5px; color: #06344F; font-weight: 700; margin-top: 6px; background: #EAF6FB; border: 1px solid #CDE8F3; border-radius: 8px; padding: 5px 8px; }
.badge-sorteio { display: inline-block; font-size: 11px; font-weight: 700; color: #06344F; background: #EAF6FB; border: 1px solid #CDE8F3; border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
.pos-venda-overlay { position: fixed; inset: 0; background: rgba(6, 52, 79, .55); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 3000; }
.pos-venda-card { background: #fff; border-radius: 20px; padding: 26px 22px; width: 100%; max-width: 380px; text-align: center; box-shadow: 0 24px 60px rgba(0,0,0,.35); animation: pos-venda-pop .18s ease-out; }
@keyframes pos-venda-pop { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.pos-venda-check { width: 60px; height: 60px; border-radius: 50%; background: #E8F7EC; color: #1E9E4A; display: flex; align-items: center; justify-content: center; font-size: 34px; margin: 0 auto 12px; }
.pos-venda-card h2 { font-size: 19px; color: #06344F; margin: 0 0 4px; }
.pos-venda-total { font-size: 15px; font-weight: 700; color: #0E7EA8; margin-bottom: 14px; }
.pos-venda-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 20px; }
.pos-venda-chip { font-size: 12.5px; font-weight: 600; color: #5F5E5A; background: #F3F2EE; border-radius: 999px; padding: 6px 12px; display: inline-flex; align-items: center; gap: 5px; }
.pos-venda-chip.sorteio { color: #06344F; background: #EAF6FB; border: 1px solid #CDE8F3; }
.pos-venda-imprimir { width: 100%; font-size: 17px; padding: 15px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.pos-venda-nova { width: 100%; margin-top: 10px; background: none; border: none; color: #7D7A72; font-size: 13.5px; padding: 8px; cursor: pointer; text-decoration: underline; }
.rawbt-passos { font-size: 13px; color: #5F5E5A; margin: 10px 0; background: #F7F6F1; border: 1px solid #E7E5DC; border-radius: 10px; padding: 12px 14px; }
.rawbt-passos ol { margin: 6px 0 0; padding-left: 20px; line-height: 1.7; }
.card-perigo { border: 1px solid #E6C0BA; background: #FDF6F5; }
.sessao-resumo { margin: 8px 0 4px; }
.sessao-linha { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13.5px; color: #5F5E5A; border-bottom: 1px solid #F0EEE7; }
.sessao-linha strong { color: #06344F; font-weight: 600; }
.sessao-linha.forte { border-bottom: none; margin-top: 4px; font-size: 15px; }
.sessao-linha.forte span { color: #06344F; font-weight: 600; }
.sessao-linha.forte strong { color: #0E7EA8; font-weight: 800; }
.sessao-dif { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-radius: 10px; margin: 12px 0; font-weight: 700; }
.sessao-dif.ok { background: #EAF7EE; color: #1E7A3C; }
.sessao-dif.falta { background: #FDECEA; color: #B3261E; }
.sessao-dif strong { font-size: 17px; }
.capette-seletor { margin-top: 12px; }
.capette-seletor select { width: 100%; max-width: 420px; margin: 4px 0; padding: 8px 10px; border: 0.5px solid #D3D1C7; border-radius: 8px; font-size: 13px; }
.capette-hint { display: block; font-size: 12px; color: #7D7A72; }
.venda-card-acoes { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }

@media (max-width: 1000px) {
  .app-shell { grid-template-columns: 1fr; }
  input, select, textarea { font-size: 16px !important; }
  .topo-mobile {
    margin: 0 0 1rem;
    border-radius: 14px;
    border: 0.5px solid #E8E6DE;
    box-shadow: 0 4px 14px rgba(6,52,79,.05);
  }
  .conteudo { padding-top: 1.1rem; }
  .topo .eyebrow { display: none; }
  .topo p { display: none; }
  .topo { margin-bottom: .9rem; }
  .hide-mobile-caixa { display: none; }

  /* Tela de venda — otimizada pra uso no celular pelos caixas */
  .topo h1 { font-size: 21px; }
  .topo p { font-size: 11px; }
  .resumo-faixa { font-size: 11px; gap: 6px 10px; padding: 9px 11px; }
  .grid-venda { gap: 12px; }
  .produtos-grid { grid-template-columns: repeat(2, 1fr); gap: 9px; }
  .produto-btn { min-height: 86px; padding: 12px; border-radius: 14px; }
  .produto-btn strong { font-size: 13px; }
  .produto-btn span { font-size: 18px; }
  .carrinho-card { padding-bottom: 110px; }
  .lista-carrinho { max-height: 32vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .linha-carrinho { padding: 11px; }
  .qtd-actions button { width: 34px; height: 34px; font-size: 16px; }
  .pagamentos button { padding: 12px 8px; font-size: 12.5px; }
  .botoes-finalizar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
    margin: 0; grid-template-columns: 1fr 2fr; gap: 8px;
    padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
    background: rgba(252,251,248,0.97);
    border-top: 0.5px solid #E0DDD5;
    box-shadow: 0 -8px 24px rgba(6,52,79,.08);
    backdrop-filter: none;
  }
  .botoes-finalizar .botao { min-height: 48px; }
  .botoes-finalizar .botao.verde { font-size: 14px; font-weight: 800; }

  /* Listas e tabelas — toque mais fácil */
  th, td { padding: 11px 9px; font-size: 11.5px; }
  .mini { padding: 8px 10px; font-size: 11px; }
  .acoes-linha { gap: 6px; }
}

`;

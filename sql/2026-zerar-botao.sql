-- ============================================================================
-- BOTÃO "ZERAR DADOS DE TESTE" — função chamada pelo app
-- Rode UMA VEZ no Supabase (SQL Editor puro, NÃO na Assistente de IA).
-- Depois disso, o botão em Configurações funciona quantas vezes quiser.
--
-- Apaga vendas, itens, movimentações e números de sorteio do evento, e zera o
-- estoque de volta ao inicial. MANTÉM produtos, caixas, fiado e config.
-- ============================================================================

create or replace function public.zerar_dados_teste_evento(p_evento_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.sorteio_numeros where evento_id = p_evento_id;
  delete from public.venda_itens
    where venda_id in (select id from public.vendas where evento_id = p_evento_id);
  delete from public.vendas where evento_id = p_evento_id;
  delete from public.movimentacoes_caixa where evento_id = p_evento_id;
  update public.produtos set estoque_atual = estoque_inicial where evento_id = p_evento_id;
end;
$$;

grant execute on function public.zerar_dados_teste_evento(uuid) to authenticated;

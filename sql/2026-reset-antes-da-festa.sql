-- ============================================================================
-- RESET DE TESTE — rode SÓ quando quiser começar a festa de verdade do ZERO
-- ----------------------------------------------------------------------------
-- Apaga as VENDAS, itens, movimentações (sangria/reforço) e números de sorteio
-- DE TESTE deste evento, e zera o estoque de volta ao inicial.
--
-- MANTÉM: produtos, caixas, pessoas do fiado e a configuração do evento.
--
-- ⚠️ NÃO TEM VOLTA. Rode no SQL Editor puro (NÃO na Assistente de IA), só uma
--    vez, pouco antes do evento. Depois disso, o sorteio recomeça no número 1.
-- ============================================================================

do $$
declare
  v_evento uuid := '092f45a8-4c47-4a4c-bda2-1c0f8ef5635c';  -- evento do .env (VITE_EVENTO_ID)
begin
  delete from public.sorteio_numeros where evento_id = v_evento;
  delete from public.venda_itens where venda_id in (select id from public.vendas where evento_id = v_evento);
  delete from public.vendas where evento_id = v_evento;
  delete from public.movimentacoes_caixa where evento_id = v_evento;

  -- zera o estoque de volta ao inicial (tira os números negativos dos testes)
  update public.produtos set estoque_atual = estoque_inicial where evento_id = v_evento;
end $$;

-- ============================================================================
-- SORTEIO — tornar o valor editável (a cada R$X = 1 número)
-- Rode no Supabase (SQL Editor puro, NÃO na "Assistente de IA"). Seguro repetir.
-- Depois disso, o valor é configurado na tela "Dados do evento" do app.
-- ============================================================================

-- Coluna de configuração no evento (padrão R$10)
alter table public.eventos
  add column if not exists sorteio_valor_por_numero numeric not null default 10;

-- Função passa a usar o valor configurado no evento
create or replace function public.emitir_numeros_sorteio(p_venda_id uuid)
returns table (numero integer)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_evento uuid;
  v_total  numeric;
  v_forma  text;
  v_status text;
  v_valor  numeric;
  v_qtd    integer;
  v_max    integer;
begin
  select evento_id, total, forma_pagamento, status
    into v_evento, v_total, v_forma, v_status
    from public.vendas
   where id = p_venda_id;

  if v_evento is null then
    return;
  end if;

  if v_status = 'cancelada' or v_forma = 'Cortesia' then
    return;
  end if;

  select coalesce(sorteio_valor_por_numero, 10) into v_valor
    from public.eventos where id = v_evento for update;

  if exists (select 1 from public.sorteio_numeros where venda_id = p_venda_id) then
    return query
      select s.numero from public.sorteio_numeros s
       where s.venda_id = p_venda_id
       order by s.numero;
    return;
  end if;

  if v_valor is null or v_valor <= 0 then
    return;
  end if;

  v_qtd := floor(coalesce(v_total, 0) / v_valor)::int;
  if v_qtd < 1 then
    return;
  end if;

  select coalesce(max(s.numero), 0) into v_max
    from public.sorteio_numeros s
   where s.evento_id = v_evento;

  return query
  with novos as (
    insert into public.sorteio_numeros (evento_id, venda_id, numero)
    select v_evento, p_venda_id, v_max + g
      from generate_series(1, v_qtd) as g
    returning sorteio_numeros.numero
  )
  select n.numero from novos n order by n.numero;
end;
$$;

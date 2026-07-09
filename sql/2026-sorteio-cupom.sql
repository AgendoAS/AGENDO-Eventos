-- ============================================================================
-- SORTEIO DA FESTA — "a cada R$X, um número" (valor configurável no app)
-- ----------------------------------------------------------------------------
-- Script completo do zero. Rode no Supabase (SQL Editor puro, NÃO na "Assistente
-- de IA"). É seguro rodar de novo (idempotente).
--
-- Regra: floor(total / valor_por_numero). O valor é configurado por evento na
--        tela "Dados do evento" do app (padrão R$10; 0 desliga o sorteio).
--        Vendas canceladas e Cortesia NÃO geram número. Fiado gera.
-- ============================================================================

-- 1) Tabela dos números emitidos ------------------------------------------------
create table if not exists public.sorteio_numeros (
  id         bigint generated always as identity primary key,
  evento_id  uuid not null,
  venda_id   uuid not null references public.vendas(id) on delete cascade,
  numero     integer not null,
  criado_em  timestamptz not null default now(),
  unique (evento_id, numero)
);

create index if not exists idx_sorteio_venda  on public.sorteio_numeros (venda_id);
create index if not exists idx_sorteio_evento on public.sorteio_numeros (evento_id);

-- 1b) Regra configurável por evento (a cada R$X = 1 número; padrão 10) ----------
alter table public.eventos
  add column if not exists sorteio_valor_por_numero numeric not null default 10;

-- 2) Função que emite os números (atômica + idempotente) ------------------------
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
  -- dados da venda
  select evento_id, total, forma_pagamento, status
    into v_evento, v_total, v_forma, v_status
    from public.vendas
   where id = p_venda_id;

  if v_evento is null then
    return;                               -- venda não existe
  end if;

  -- vendas canceladas ou cortesia não geram número
  if v_status = 'cancelada' or v_forma = 'Cortesia' then
    return;
  end if;

  -- trava o evento (serializa a numeração, sem repetir entre caixas) e lê a regra
  select coalesce(sorteio_valor_por_numero, 10) into v_valor
    from public.eventos where id = v_evento for update;

  -- idempotente (já sob a trava): se já emitiu, devolve o que tem e não gera de novo
  if exists (select 1 from public.sorteio_numeros where venda_id = p_venda_id) then
    return query
      select s.numero from public.sorteio_numeros s
       where s.venda_id = p_venda_id
       order by s.numero;
    return;
  end if;

  -- valor 0 (ou inválido) = sorteio desligado
  if v_valor is null or v_valor <= 0 then
    return;
  end if;

  v_qtd := floor(coalesce(v_total, 0) / v_valor)::int;   -- 1 número a cada R$ v_valor
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

grant execute on function public.emitir_numeros_sorteio(uuid) to anon, authenticated;

-- 3) Leitura pelo app (RLS) -----------------------------------------------------
alter table public.sorteio_numeros enable row level security;

drop policy if exists sorteio_numeros_select on public.sorteio_numeros;
create policy sorteio_numeros_select
  on public.sorteio_numeros
  for select
  to authenticated
  using (true);

-- 4) (Opcional) Realtime: atualiza a lista em outros aparelhos na hora ----------
do $$
begin
  alter publication supabase_realtime add table public.sorteio_numeros;
exception
  when duplicate_object then null;
  when others then null;
end $$;

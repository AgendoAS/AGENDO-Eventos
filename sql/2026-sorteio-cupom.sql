-- ============================================================================
-- SORTEIO DA FESTA — "a cada R$10, um número"
-- ----------------------------------------------------------------------------
-- Rode este script UMA VEZ no Supabase (SQL Editor) ANTES de publicar o app.
-- Ele cria:
--   1) a tabela sorteio_numeros (cada linha = um número da sorte já emitido)
--   2) a função emitir_numeros_sorteio(venda) que gera os números de forma
--      ATÔMICA (número único e sequencial, mesmo com vários caixas ao mesmo
--      tempo — igual às fichas)
--   3) a permissão de leitura (RLS) pro app conseguir mostrar/imprimir
--
-- Regra: floor(total / 10). Ex.: R$25 = 2 números, R$9 = nenhum.
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

  -- idempotente: se já emitiu, devolve o que já tem e não gera de novo
  if exists (select 1 from public.sorteio_numeros where venda_id = p_venda_id) then
    return query
      select s.numero from public.sorteio_numeros s
       where s.venda_id = p_venda_id
       order by s.numero;
    return;
  end if;

  -- vendas canceladas ou cortesia não geram número
  if v_status = 'cancelada' or v_forma = 'Cortesia' then
    return;
  end if;

  v_qtd := floor(coalesce(v_total, 0) / 10)::int;   -- 1 número a cada R$10
  if v_qtd < 1 then
    return;
  end if;

  -- trava por evento => numeração sequencial sem repetição, mesmo com
  -- vários caixas finalizando ao mesmo tempo
  perform 1 from public.eventos where id = v_evento for update;

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

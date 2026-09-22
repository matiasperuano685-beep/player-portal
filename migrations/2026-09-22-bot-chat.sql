-- Bot del chat (etapa 1). Solo agrega columnas: no borra ni modifica datos.
-- Correr en el SQL Editor de Supabase (proyecto capiii) ANTES de publicar el código nuevo.

-- Mensajes con estructura (tarjeta de CBU, formulario de retiro, etc.)
alter table public.portal_chat_messages add column if not exists meta jsonb;

-- Cada carga/retiro guarda su comprobante y el chat donde se pidió
alter table public.portal_transactions add column if not exists comprobante_path text;
alter table public.portal_transactions add column if not exists chat_id uuid references public.portal_chats(id) on delete set null;

-- Interruptor general del bot. Arranca APAGADO: nada cambia para los jugadores
-- hasta que se prenda (para probar se usa la variable BOT_TEST_USERS).
alter table public.portal_settings add column if not exists bot_enabled boolean not null default false;

-- Interruptor del bot por conversación (lo maneja el operador desde Chat Jugadores
-- en el CRM). Por defecto prendido: manda el interruptor general de arriba.
alter table public.portal_chats add column if not exists bot_enabled boolean not null default true;

-- Cuentas de cobro: el operador elige cuál está activa desde el CRM y el bot
-- muestra esa. La conciliación con la wallet mira todas.
create table if not exists public.portal_cash_accounts (
  id uuid primary key default gen_random_uuid(),
  bank_name text,
  cbu text,
  alias text,
  account_name text,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.portal_cash_accounts enable row level security;
insert into public.portal_cash_accounts (bank_name, cbu, alias, account_name, is_active)
select bank_name, bank_cbu, bank_alias, bank_account_name, true
from public.portal_settings
where not exists (select 1 from public.portal_cash_accounts);

-- Conciliación con LurkerPay (etapa 3)
alter table public.portal_transactions add column if not exists lurkerpay_tx_id text;
alter table public.portal_transactions add column if not exists lurkerpay_deposit_id text;
alter table public.portal_transactions add column if not exists matched_at timestamptz;
alter table public.portal_transactions add column if not exists match_info jsonb;
alter table public.portal_cash_accounts add column if not exists lurkerpay_cuenta_id text;
create index if not exists idx_portal_tx_pending on public.portal_transactions (status, type, created_at desc);

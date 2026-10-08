-- Bono de bienvenida de la landing (08/10/2026): ruleta en registro.capiok.me → 20% extra
-- en la PRIMERA carga. Se calcula al crear el pedido de carga y el cajero (Aprobar en el
-- chat de jugadores del CRM) o la carga automática acreditan monto + bono.
alter table public.portal_players
  add column if not exists welcome_bonus_pct numeric(5,2),          -- null = sin bono
  add column if not exists welcome_bonus_used_at timestamptz,
  add column if not exists welcome_bonus_tx_id uuid;

alter table public.portal_transactions
  add column if not exists bonus_pct numeric(5,2),
  add column if not exists bonus_amount numeric(14,2) not null default 0;

alter table public.portal_settings
  add column if not exists landing_welcome_bonus_pct numeric(5,2) default 20;   -- % que da la ruleta

select (select landing_welcome_bonus_pct from portal_settings limit 1) as bono_landing;

-- Seguimiento automático de registrados que no cargaron (api/cron/seguimiento.js).
-- Una fila por aviso enviado: no se repite el mismo aviso al mismo jugador.
create table if not exists portal_followups (
  id bigserial primary key,
  player_id uuid not null references portal_players(id) on delete cascade,
  kind text not null,          -- reg_1h | reg_24h | cbu:<id del mensaje con los datos>
  channel text not null,       -- whatsapp | chat | both
  created_at timestamptz not null default now(),
  unique (player_id, kind)
);
create index if not exists portal_followups_player_idx on portal_followups (player_id, created_at desc);
alter table portal_followups enable row level security;

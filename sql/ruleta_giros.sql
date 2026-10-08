-- Un giro de la ruleta por WhatsApp (08/10/2026): evita girar muchas veces hasta sacar el 100%.
create table if not exists public.landing_spins (
  whatsapp_last8 text primary key,
  pct numeric(5,2) not null,
  ref text,
  created_at timestamptz not null default now()
);
alter table public.landing_spins enable row level security;  -- solo el servidor (service role)
select count(*) as giros from public.landing_spins;

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

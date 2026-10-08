-- Recordatorio de soporte a jugadores que hace N días no cargan (08/10/2026).
-- "Sin cargar" = la última carga aprobada (o el alta, si nunca cargó) es de hace más de N días.
-- Se manda como mucho una vez cada N días por jugador.
alter table public.portal_players add column if not exists last_reactivation_at timestamptz;

create or replace function public.players_to_reactivate(p_days integer, p_limit integer default 1000)
returns table (id uuid, full_name text, username text, welcome_bonus_pct numeric, welcome_bonus_used_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select p.id, p.full_name, p.username, p.welcome_bonus_pct, p.welcome_bonus_used_at
    from portal_players p
   where p.status = 'active'
     and coalesce(p.last_reactivation_at, '-infinity') < now() - make_interval(days => p_days)
     and coalesce(
           (select max(t.updated_at) from portal_transactions t
             where t.player_id = p.id and t.type = 'deposit' and t.status = 'approved'),
           p.created_at
         ) < now() - make_interval(days => p_days)
   order by p.created_at
   limit p_limit;
$$;
revoke all on function public.players_to_reactivate(integer, integer) from public, anon, authenticated;

select count(*) as recibirian_hoy from public.players_to_reactivate(4, 5000);

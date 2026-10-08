-- Ruleta de la landing con premios distintos y sorteo real (08/10/2026).
-- pct = % extra en la primera carga; weight = probabilidad relativa (suman 100).
alter table public.portal_settings
  add column if not exists landing_wheel_prizes jsonb
    default '[{"pct":20,"weight":85},{"pct":30,"weight":10},{"pct":50,"weight":4},{"pct":100,"weight":1}]'::jsonb;

update public.portal_settings
   set landing_wheel_prizes = '[{"pct":20,"weight":85},{"pct":30,"weight":10},{"pct":50,"weight":4},{"pct":100,"weight":1}]'::jsonb
 where landing_wheel_prizes is null;

select landing_wheel_prizes from public.portal_settings limit 1;

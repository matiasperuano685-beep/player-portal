// Carga automática de fichas: el portal le pide la carga a la edge function
// casino-ops del CRM (Supabase de Capibet), la misma que usan los operadores.
// Así hay una sola lógica de carga y todo queda en el Registro de cargas del
// CRM, a nombre de "Bot del chat".
//
// Env (Vercel):
//   CASINO_OPS_URL          https://<ref del CRM>.supabase.co/functions/v1/casino-ops
//   CASINO_OPS_ANON_KEY     anon key PÚBLICA del CRM (solo para pasar el gateway)
//   CASINO_OPS_BOT_SECRET   secreto compartido con casino-ops (CASINO_OPS_BOT_SECRET)
//   AUTO_LOAD_TEST_USERS    usuarios del portal para probar con la carga automática apagada

const MIN_AUTO = 2000;
const MAX_AUTO = 50000;

function configurado() {
  return !!(process.env.CASINO_OPS_URL && process.env.CASINO_OPS_ANON_KEY && process.env.CASINO_OPS_BOT_SECRET);
}

// Prendida para todos (portal_settings.auto_load_enabled) o solo para testers.
function autoLoadActivo(settings, username) {
  if (settings?.auto_load_enabled) return true;
  const testers = (process.env.AUTO_LOAD_TEST_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!username && testers.includes(String(username).toLowerCase());
}

function montoPermitido(monto) {
  const n = Number(monto);
  return Number.isFinite(n) && n >= MIN_AUTO && n <= MAX_AUTO;
}

async function cargar({ username, amount, reference }) {
  const res = await fetch(process.env.CASINO_OPS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CASINO_OPS_ANON_KEY}`,
      apikey: process.env.CASINO_OPS_ANON_KEY,
      'x-bot-secret': process.env.CASINO_OPS_BOT_SECRET,
    },
    body: JSON.stringify({ action: 'deposit', username, amount, reference }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.message || `casino-ops HTTP ${res.status}`);
  return data; // { ok, balance_after, duplicate? }
}

module.exports = { MIN_AUTO, MAX_AUTO, configurado, autoLoadActivo, montoPermitido, cargar };

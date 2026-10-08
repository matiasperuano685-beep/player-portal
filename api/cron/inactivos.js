const webpush = require('web-push');
const { db } = require('../_lib');
const bot = require('../_bot');

// Recordatorio de soporte por el chat del portal a quienes hace 4 días no cargan (o se
// registraron y nunca cargaron). Una vez cada 4 días por jugador. Si tiene el bono de
// bienvenida sin usar, se lo recuerda. También va como push a quien lo tenga activado.
const DIAS = 4;

webpush.setVapidDetails('mailto:admin@capibet.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'No autorizado' });

  const client = db();
  const settings = await bot.getSettings(client);
  const { data: players, error } = await client.rpc('players_to_reactivate', { p_days: DIAS, p_limit: 1000 });
  if (error) return res.status(500).json({ error: error.message });

  let sent = 0, skipped = 0, failed = 0;
  for (const p of players || []) {
    try {
      const chat = await bot.getOrCreateChat(client, p.id);
      if (!bot.botActive(settings, p.username, chat)) { skipped++; continue; }
      const nombre = String(p.full_name || '').trim().split(' ')[0];
      const lineas = [
        `👋 ¡Hola${nombre ? ' ' + nombre : ''}! Te recordamos que en CapiBet estamos disponibles las 24 hs, todos los días, para cargar y retirar.`,
        'Cuando quieras jugar, escribinos por acá o tocá 💰 Cargar. ¡Te esperamos! 🍀',
      ];
      if (Number(p.welcome_bonus_pct) > 0 && !p.welcome_bonus_used_at) {
        lineas.push('', `🎁 Recordá que tenés ${Number(p.welcome_bonus_pct)}% extra en tu primera carga.`);
      }
      await bot.botSay(client, chat.id, lineas.join('\n'), { type: 'reactivation' });
      await client.from('portal_players').update({ last_reactivation_at: new Date().toISOString() }).eq('id', p.id);

      const { data: subs } = await client.from('portal_push_subscriptions').select('subscription').eq('player_id', p.id);
      await Promise.allSettled((subs || []).map((s) => webpush.sendNotification(s.subscription, JSON.stringify({
        title: '💬 Soporte CapiBet', body: 'Estamos disponibles las 24 hs para cargar y retirar. ¡Te esperamos!',
      }))));
      sent++;
    } catch (e) {
      console.error('inactivos', p.id, e.message);
      failed++;
    }
  }
  return res.status(200).json({ sent, skipped, failed, total: (players || []).length });
};

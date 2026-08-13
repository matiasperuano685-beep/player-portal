const webpush = require('web-push');
const { db } = require('../_lib');

webpush.setVapidDetails(
  'mailto:admin@capibet.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const NOTIF_TITLE = '🥹 TE EXTRAÑAMOS';
const NOTIF_BODY = 'No te olvides que en CAPIBET estamos recargando las 24 HS 💚\n\nCuando tengas ganas de volver a probar suerte, acá estamos esperándote 🍀🎰\n\n🔥 Estamos activos todo el día, todos los días.';

module.exports = async (req, res) => {
  // Solo Vercel Cron o llamada con secret
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const client = db();
  const now = new Date();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since48h = new Date(now - 48 * 60 * 60 * 1000).toISOString();

  // Jugadores que no ingresaron en las últimas 24hs
  // y cuya suscripción no recibió esta notif en las últimas 48hs (para no spamear)
  const { data: subs } = await client
    .from('portal_push_subscriptions')
    .select('id, subscription, player_id, notif_reengagement_sent_at, portal_players!inner(last_login_at, status)')
    .eq('portal_players.status', 'active')
    .or(`last_login_at.lt.${since24h},last_login_at.is.null`, { foreignTable: 'portal_players' })
    .or(`notif_reengagement_sent_at.lt.${since48h},notif_reengagement_sent_at.is.null`);

  if (!subs?.length) return res.status(200).json({ sent: 0, message: 'Sin jugadores para notificar' });

  let sent = 0;
  let failed = 0;

  await Promise.allSettled(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({ title: NOTIF_TITLE, body: NOTIF_BODY })
      );
      await client
        .from('portal_push_subscriptions')
        .update({ notif_reengagement_sent_at: now.toISOString() })
        .eq('id', sub.id);
      sent++;
    } catch {
      failed++;
    }
  }));

  return res.status(200).json({ sent, failed, total: subs.length });
};

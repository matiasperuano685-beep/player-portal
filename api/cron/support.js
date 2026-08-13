const webpush = require('web-push');
const { db } = require('../_lib');

webpush.setVapidDetails(
  'mailto:admin@capibet.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const NOTIF_TITLE = '🙋 ¿Necesitás ayuda?';
const NOTIF_BODY = 'Si tenés algún inconveniente podés comunicarte con tu cajero de confianza o contactarnos directamente.';

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const client = db();
  const now = new Date();
  const since48h = new Date(now - 48 * 60 * 60 * 1000).toISOString();

  // Suscripciones que no recibieron esta notif en las últimas 48hs
  const { data: subs } = await client
    .from('portal_push_subscriptions')
    .select('id, subscription, portal_players!inner(status)')
    .eq('portal_players.status', 'active')
    .or(`notif_support_sent_at.lt.${since48h},notif_support_sent_at.is.null`);

  if (!subs?.length) return res.status(200).json({ sent: 0, message: 'Sin suscriptores para notificar' });

  let sent = 0;
  let failed = 0;

  await Promise.allSettled(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({
          title: NOTIF_TITLE,
          body: NOTIF_BODY,
          actions: [{ action: 'soporte', title: '💬 Soporte' }],
          data: { actionUrl: 'https://capiok.me/wa/soportecapi' }
        })
      );
      await client
        .from('portal_push_subscriptions')
        .update({ notif_support_sent_at: now.toISOString() })
        .eq('id', sub.id);
      sent++;
    } catch {
      failed++;
    }
  }));

  return res.status(200).json({ sent, failed, total: subs.length });
};

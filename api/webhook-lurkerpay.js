// Webhook de LurkerPay: avisa cuando entra (o sale) plata de las cuentas de cobro.
//
// Seguridad, en capas, porque LurkerPay no documenta firma:
//   1) La URL lleva un token secreto (LURKERPAY_WEBHOOK_TOKEN). Sin él, 404.
//   2) Antes de marcar nada, se verifica contra /transactions que la transferencia
//      exista y esté confirmada. Un aviso inventado no pasa de acá.
//
// Por ahora NO acredita fichas solo: marca la solicitud como verificada para que
// el operador apruebe de un clic. La carga automática se prende después.
const { db } = require('./_lib');
const bot = require('./_bot');
const lurkerpay = require('./_lurkerpay');

const VENTANA_MS = 6 * 60 * 60 * 1000; // buscar solicitudes de las últimas 6 horas

function tokenValido(req) {
  const esperado = process.env.LURKERPAY_WEBHOOK_TOKEN;
  if (!esperado) return false;
  const url = new URL(req.url, 'http://x');
  const recibido = url.searchParams.get('token') || req.headers['x-webhook-token'];
  return recibido === esperado;
}

// Busca a qué solicitud pendiente corresponde el ingreso.
async function buscarSolicitud(client, evento) {
  const monto = Number(evento.monto);
  const desde = new Date(Date.now() - VENTANA_MS).toISOString();

  // 1) Si el pedido se creó como depósito esperado, viene atado por id
  if (evento.deposit_id) {
    const { data } = await client.from('portal_transactions')
      .select('*, portal_players(id, username)')
      .eq('lurkerpay_deposit_id', evento.deposit_id).eq('status', 'pending').limit(1);
    if (data?.length) return { tx: data[0], via: 'deposito_esperado' };
  }

  // 2) Si no, por monto exacto entre las cargas pendientes recientes
  const { data: candidatas } = await client.from('portal_transactions')
    .select('*, portal_players(id, username)')
    .eq('status', 'pending').eq('type', 'deposit').eq('amount', monto)
    .gte('created_at', desde).order('created_at', { ascending: false });

  if (!candidatas?.length) return { tx: null, via: 'sin_candidatas' };
  if (candidatas.length > 1) return { tx: null, via: 'ambiguo', cantidad: candidatas.length };
  return { tx: candidatas[0], via: 'monto_y_horario' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!tokenValido(req)) {
    console.warn('webhook-lurkerpay: token invalido');
    return res.status(404).json({ error: 'No encontrado' });
  }

  const evento = req.body || {};
  // Responder rápido: LurkerPay no tiene que esperar a que hagamos todo
  const tipoOk = evento.tipo === 'ingreso' && evento.status === 'confirmada';
  if (!tipoOk) {
    console.log('webhook-lurkerpay: evento ignorado', evento.event, evento.tipo, evento.status);
    return res.status(200).json({ ok: true, ignorado: true });
  }

  try {
    const client = db();

    // Verificación contra la API: el aviso tiene que corresponder a una
    // transferencia real y confirmada.
    let verificada = null;
    if (lurkerpay.configurada()) {
      try {
        verificada = await lurkerpay.buscarIngreso({
          codigo_coelsa: evento.codigo_coelsa,
          referencia_externa: evento.referencia_externa,
          transaction_id: evento.transaction_id,
          monto: evento.monto,
          cuenta_id: evento.cuenta_id,
        });
      } catch (e) {
        console.error('webhook-lurkerpay: error verificando', e.message);
      }
      if (!verificada) {
        console.warn('webhook-lurkerpay: no se pudo verificar el ingreso, se descarta');
        return res.status(202).json({ ok: true, verificado: false });
      }
    }

    const { tx, via, cantidad } = await buscarSolicitud(client, evento);
    const info = {
      via,
      verificado: !!verificada,
      monto: Number(evento.monto),
      contraparte_nombre: evento.contraparte_nombre || null,
      contraparte_cuit: evento.contraparte_cuil_cuit || null,
      contraparte_cbu: evento.contraparte_cbu || null,
      codigo_coelsa: evento.codigo_coelsa || null,
      cuenta_alias: evento.cuenta_alias || null,
      fecha: evento.fecha || null,
      candidatas: cantidad || null,
    };

    if (!tx) {
      console.log('webhook-lurkerpay: ingreso sin solicitud asociada', JSON.stringify(info));
      return res.status(200).json({ ok: true, asociado: false, via });
    }

    await client.from('portal_transactions').update({
      lurkerpay_tx_id: evento.transaction_id || null,
      matched_at: new Date().toISOString(),
      match_info: info,
      updated_at: new Date().toISOString(),
    }).eq('id', tx.id);

    // Avisarle al jugador que ya vimos la plata (sin acreditar todavía)
    try {
      const settings = await bot.getSettings(client);
      const chat = await bot.getOrCreateChat(client, tx.player_id);
      if (bot.botActive(settings, tx.portal_players?.username, chat)) {
        await bot.botSay(client, chat.id,
          `✅ Ya vemos tu transferencia de $${bot.money(evento.monto)}. La estamos acreditando.`,
          { type: 'status', tx_id: tx.id, matched: true });
      }
    } catch (e) { console.error('webhook-lurkerpay: aviso al jugador', e.message); }

    return res.status(200).json({ ok: true, asociado: true, via, transaction: tx.id });
  } catch (e) {
    console.error('webhook-lurkerpay:', e);
    // 200 igual: si devolvemos error, LurkerPay puede reintentar en loop
    return res.status(200).json({ ok: false });
  }
};

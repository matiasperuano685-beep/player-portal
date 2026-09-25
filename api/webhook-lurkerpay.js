// Webhook de LurkerPay: avisa cuando entra (o sale) plata de las cuentas de cobro.
//
// Seguridad, en capas, porque LurkerPay no documenta firma:
//   1) La URL lleva un token secreto (LURKERPAY_WEBHOOK_TOKEN). Sin él, 404.
//   2) Antes de marcar nada, se verifica contra /transactions que la transferencia
//      exista y esté confirmada. Un aviso inventado no pasa de acá.
//
// Carga automática: si el ingreso está verificado, la asociación es segura
// (depósito esperado o un único pedido con ese monto), el monto está entre
// $2.000 y $50.000, el jugador tiene su usuario del casino y la carga automática
// está prendida (o es un tester), se cargan las fichas en el casino vía
// casino-ops y se cierra la solicitud. En cualquier otro caso queda para que un
// operador la apruebe (que también carga en el casino).
const { db } = require('./_lib');
const bot = require('./_bot');
const lurkerpay = require('./_lurkerpay');
const casino = require('./_casino');

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
      .select('*, portal_players(id, username, casino_username, balance)')
      .eq('lurkerpay_deposit_id', evento.deposit_id).eq('status', 'pending').limit(1);
    if (data?.length) return { tx: data[0], via: 'deposito_esperado' };
  }

  // 2) Si no, por monto exacto entre las cargas pendientes recientes
  const { data: candidatas } = await client.from('portal_transactions')
    .select('*, portal_players(id, username, casino_username, balance)')
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

    const settings = await bot.getSettings(client);
    const player = tx.portal_players || {};
    const casinoUser = (player.casino_username || '').trim();

    // ¿Se puede acreditar sola?
    let auto = null; // 'ok' | 'error' | null (no correspondía)
    const segura = via === 'deposito_esperado' || via === 'monto_y_horario';
    const puedeAuto = !!verificada && segura
      && Number(evento.monto) === Number(tx.amount)
      && casino.configurado()
      && casino.autoLoadActivo(settings, player.username)
      && casino.montoPermitido(tx.amount)
      && !!casinoUser;

    if (puedeAuto) {
      // Bloqueo: solo sigue si la solicitud todavía estaba pendiente (un aviso
      // repetido de la billetera no puede acreditar dos veces).
      const { data: tomada } = await client.from('portal_transactions').update({
        status: 'approved',
        operator_notes: 'Acreditada automáticamente (transferencia confirmada en la billetera)',
        updated_at: new Date().toISOString(),
      }).eq('id', tx.id).eq('status', 'pending').select('id');

      if (tomada?.length) {
        try {
          const r = await casino.cargar({ username: casinoUser, amount: Number(tx.amount), reference: tx.id });
          await client.from('portal_players')
            .update({ balance: Number(player.balance || 0) + Number(tx.amount) })
            .eq('id', player.id);
          await client.from('portal_transactions').update({
            match_info: { ...info, auto: 'ok', saldo_casino: r.balance_after ?? null },
          }).eq('id', tx.id);
          auto = 'ok';
        } catch (e) {
          console.error('webhook-lurkerpay: carga automática falló', e.message);
          await client.from('portal_transactions').update({
            status: 'pending',
            operator_notes: `La carga automática falló: ${e.message}. Revisar y aprobar a mano.`,
            match_info: { ...info, auto: 'error', auto_error: e.message },
            updated_at: new Date().toISOString(),
          }).eq('id', tx.id);
          auto = 'error';
        }
      }
    }

    // Avisarle al jugador
    try {
      const chat = await bot.getOrCreateChat(client, tx.player_id);
      if (bot.botActive(settings, player.username, chat)) {
        if (auto === 'ok') {
          await bot.notifyTransactionResult(client, tx, 'approve');
        } else {
          await bot.botSay(client, chat.id,
            `✅ Ya vemos tu transferencia de $${bot.money(evento.monto)}. La estamos acreditando.`,
            { type: 'status', tx_id: tx.id, matched: true });
        }
      }
    } catch (e) { console.error('webhook-lurkerpay: aviso al jugador', e.message); }

    return res.status(200).json({ ok: true, asociado: true, via, transaction: tx.id, auto });
  } catch (e) {
    console.error('webhook-lurkerpay:', e);
    // 200 igual: si devolvemos error, LurkerPay puede reintentar en loop
    return res.status(200).json({ ok: false });
  }
};

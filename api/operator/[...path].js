const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const { db, cors } = require('../_lib');
const bot = require('../_bot');

webpush.setVapidDetails(
  'mailto:admin@capibet.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function sendPushToPlayer(client, playerId, title, body) {
  try {
    const { data: subs } = await client.from('portal_push_subscriptions').select('subscription').eq('player_id', playerId);
    if (!subs?.length) return;
    const payload = JSON.stringify({ title, body });
    await Promise.allSettled(subs.map(s => webpush.sendNotification(s.subscription, payload)));
  } catch {}
}

function isOperator(req) {
  const key = req.headers['x-operator-key'];
  return key && key === process.env.OPERATOR_KEY;
}

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const slug = req.url.split('?')[0].replace(/^\/api\/operator\/?/, '').replace(/\/$/, '');
  // Clave de solo lectura para las estadísticas de campañas (la usa el Panel
  // Central); no sirve para nada más.
  const statsKey = req.headers['x-stats-key'];
  const isStatsReader = slug === 'campaigns' && req.method === 'GET' && !!statsKey && statsKey === process.env.STATS_READ_KEY;
  // LinkBio: la sesión del usuario del LinkBio (validada contra su Supabase) y
  // su mail tiene que estar en STATS_ALLOWED_EMAILS. Solo para leer campañas.
  let isLinkbioReader = false;
  const lbToken = req.headers['x-linkbio-token'];
  if (!isStatsReader && slug === 'campaigns' && req.method === 'GET' && lbToken) {
    const allowed = String(process.env.STATS_ALLOWED_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    const lbUrl = process.env.LINKBIO_SUPABASE_URL || 'https://eqynozpdigyoqvgazkjj.supabase.co';
    const lbAnon = process.env.LINKBIO_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxeW5venBkaWd5b3F2Z2F6a2pqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0Mzk4OTYsImV4cCI6MjA4MjAxNTg5Nn0.oUSCKC7P-_Nyr7lluQYFj_PQnNCakrriRIxWzgiMobM';
    try {
      const r = await fetch(`${lbUrl}/auth/v1/user`, { headers: { apikey: lbAnon, Authorization: `Bearer ${lbToken}` } });
      const u = r.ok ? await r.json() : null;
      isLinkbioReader = !!u?.email && allowed.includes(String(u.email).toLowerCase());
    } catch { isLinkbioReader = false; }
  }
  if (!isOperator(req) && !isStatsReader && !isLinkbioReader) return res.status(403).json({ error: 'Acceso denegado' });

  const client = db();

  // ── PLAYERS ───────────────────────────────────────────
  // ── CAMPAÑAS (landing registro.capiok.me) ─────────────
  // Registros por código de afiliado (?ref=) y cuántos cargaron, en un período.
  if (slug === 'campaigns') {
    if (req.method !== 'GET') return res.status(405).end();
    try {
      const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const players = [];
      for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await client.from('portal_players')
          .select('id, signup_ref, created_at')
          .eq('signup_source', 'landing').gte('created_at', since)
          .order('created_at', { ascending: true }).range(from, from + 999);
        if (error) return res.status(500).json({ error: error.message });
        players.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const byPlayer = new Map();
      const ids = players.map((p) => p.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data: txs } = await client.from('portal_transactions')
          .select('player_id, amount')
          .in('player_id', ids.slice(i, i + 200))
          .eq('type', 'deposit').eq('status', 'approved');
        for (const t of txs || []) byPlayer.set(t.player_id, (byPlayer.get(t.player_id) || 0) + Number(t.amount || 0));
      }
      const rows = new Map();
      for (const p of players) {
        const key = p.signup_ref || '(sin código)';
        const r = rows.get(key) || { ref: key, registros: 0, cargaron: 0, total_cargado: 0, ultimo: null };
        r.registros += 1;
        const total = byPlayer.get(p.id) || 0;
        if (total > 0) { r.cargaron += 1; r.total_cargado += total; }
        if (!r.ultimo || p.created_at > r.ultimo) r.ultimo = p.created_at;
        rows.set(key, r);
      }
      const data = Array.from(rows.values()).sort((a, b) => b.registros - a.registros);
      return res.status(200).json({ days, data });
    } catch (e) { console.error('campaigns', e); return res.status(500).json({ error: 'Error interno' }); }
  }

  if (slug === 'players') {
    if (req.method === 'GET') {
      const { data, error } = await client.from('portal_players').select('id, username, full_name, whatsapp, casino_username, balance, status, created_at').order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(200).json({ data });
    }
    if (req.method === 'POST') {
      const { username, password, full_name, whatsapp, casino_username } = req.body;
      if (!username || !password || !full_name) return res.status(400).json({ error: 'Faltan datos' });
      const hash = await bcrypt.hash(password, 10);
      const { data, error } = await client.from('portal_players').insert({ username: username.toLowerCase().trim(), password_hash: hash, full_name, whatsapp, casino_username, status: 'active' }).select('id, username, full_name, whatsapp, casino_username, balance, status').single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe' });
        return res.status(500).json({ error: 'Error interno' });
      }
      return res.status(201).json({ ok: true, player: data });
    }
    if (req.method === 'PUT') {
      const { id, balance, status, casino_username, full_name, whatsapp, password } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const updates = {};
      if (balance !== undefined) updates.balance = Number(balance);
      if (status) updates.status = status;
      if (casino_username !== undefined) updates.casino_username = casino_username;
      if (full_name) updates.full_name = full_name;
      if (whatsapp !== undefined) updates.whatsapp = whatsapp;
      if (password) updates.password_hash = await bcrypt.hash(password, 10);
      // Alta de un invitado ("No tengo usuario"): al activarlo, su usuario del
      // portal pasa a ser el del casino, así entra con los mismos datos.
      if (status === 'active' && casino_username) {
        const { data: cur } = await client.from('portal_players').select('status').eq('id', id).maybeSingle();
        if (cur?.status === 'guest') updates.username = String(casino_username).toLowerCase().trim();
      }
      const { error } = await client.from('portal_players').update(updates).eq('id', id);
      if (error?.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe en el portal' });
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── TRANSACTIONS ──────────────────────────────────────
  if (slug === 'transactions') {
    if (req.method === 'GET') {
      const status = req.query.status || 'pending';
      let query = client.from('portal_transactions').select(`id, type, amount, status, notes, operator_notes, comprobante_path, chat_id, matched_at, match_info, lurkerpay_tx_id, created_at, updated_at, portal_players (id, username, full_name, whatsapp, casino_username, balance)`).order('created_at', { ascending: false });
      if (status !== 'all') query = query.eq('status', status);
      const { data, error } = await query.limit(200);
      if (error) return res.status(500).json({ error: 'Error interno' });
      const urls = await bot.signPaths(client, (data || []).map(t => t.comprobante_path));
      return res.status(200).json({ data: (data || []).map(t => ({ ...t, comprobante_url: urls.get(t.comprobante_path) || null })) });
    }
    if (req.method === 'PUT') {
      const { id, action, operator_notes } = req.body;
      if (!id || !action) return res.status(400).json({ error: 'Faltan datos' });
      if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción inválida' });
      const { data: tx, error: txErr } = await client.from('portal_transactions').select('*, portal_players(id, balance, username)').eq('id', id).single();
      if (txErr || !tx) return res.status(404).json({ error: 'Transacción no encontrada' });
      if (tx.status !== 'pending') return res.status(409).json({ error: 'La transacción ya fue procesada' });
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      await client.from('portal_transactions').update({ status: newStatus, operator_notes: operator_notes || null, updated_at: new Date().toISOString() }).eq('id', id);
      if (action === 'approve') {
        const player = tx.portal_players;
        const delta = tx.type === 'deposit' ? Number(tx.amount) : -Number(tx.amount);
        await client.from('portal_players').update({ balance: Math.max(0, Number(player.balance || 0) + delta) }).eq('id', player.id);
      }
      try {
        const settings = await bot.getSettings(client);
        const chat = await bot.getOrCreateChat(client, tx.player_id);
        if (bot.botActive(settings, tx.portal_players?.username, chat)) {
          const note = await bot.notifyTransactionResult(client, tx, action, operator_notes);
          if (note) await sendPushToPlayer(client, tx.player_id, '💬 Novedades de tu cuenta', note.body.split('\n')[0]);
        }
      } catch (e) { console.error('bot notify', e); }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── SETTINGS ──────────────────────────────────────────
  if (slug === 'settings') {
    if (req.method === 'GET') {
      const { data } = await client.from('portal_settings').select('*').limit(1).maybeSingle();
      return res.status(200).json({ settings: data });
    }
    if (req.method === 'PUT') {
      const { whatsapp_number, casino_url, min_deposit, min_withdrawal, bank_cbu, bank_alias, bank_name, bank_account_name, bot_enabled } = req.body;
      const { data: existing } = await client.from('portal_settings').select('id, bank_cbu, bank_alias').limit(1).maybeSingle();
      const payload = { whatsapp_number, casino_url, min_deposit, min_withdrawal, bank_cbu, bank_alias, bank_name, bank_account_name };
      // Si cambiaron el CBU/alias desde acá, esta pasa a ser la cuenta que muestra el bot:
      // se desactivan las "Cuentas de cobro" del CRM (que si no, tienen prioridad).
      const norm = (v) => String(v || '').trim();
      const cuentaCambio = (norm(bank_cbu) || norm(bank_alias)) &&
        (norm(bank_cbu) !== norm(existing?.bank_cbu) || norm(bank_alias) !== norm(existing?.bank_alias));
      if (cuentaCambio) {
        try { await client.from('portal_cash_accounts').update({ is_active: false }).eq('is_active', true); }
        catch { /* la tabla puede no existir en portales sin cuentas de cobro */ }
      }
      if (typeof bot_enabled === 'boolean') payload.bot_enabled = bot_enabled;
      if (typeof req.body.landing_bonus_text === 'string') payload.landing_bonus_text = req.body.landing_bonus_text.trim().slice(0, 140) || null;
      if (existing) { await client.from('portal_settings').update(payload).eq('id', existing.id); }
      else { await client.from('portal_settings').insert(payload); }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── CUENTAS DE COBRO ──────────────────────────────────
  // Las cuentas donde los jugadores transfieren. El operador elige cuál está
  // activa; el bot muestra esa. La conciliación con la wallet mira todas.
  if (slug === 'cash-accounts') {
    if (req.method === 'GET') {
      const { data, error } = await client.from('portal_cash_accounts').select('*').order('created_at', { ascending: true });
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(200).json({ data });
    }
    if (req.method === 'POST') {
      const { bank_name, cbu, alias, account_name } = req.body;
      if (!cbu && !alias) return res.status(400).json({ error: 'Ingresá al menos un CBU o alias' });
      const { data, error } = await client.from('portal_cash_accounts')
        .insert({ bank_name, cbu, alias, account_name }).select().single();
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(201).json({ ok: true, account: data });
    }
    if (req.method === 'PUT') {
      const { id, is_active, bank_name, cbu, alias, account_name } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      if (is_active === true) {
        // Una sola activa a la vez
        await client.from('portal_cash_accounts').update({ is_active: false }).neq('id', id);
      }
      const updates = {};
      if (typeof is_active === 'boolean') updates.is_active = is_active;
      if (bank_name !== undefined) updates.bank_name = bank_name;
      if (cbu !== undefined) updates.cbu = cbu;
      if (alias !== undefined) updates.alias = alias;
      if (account_name !== undefined) updates.account_name = account_name;
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para actualizar' });
      const { error } = await client.from('portal_cash_accounts').update(updates).eq('id', id);
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── CHATS ─────────────────────────────────────────────
  if (slug === 'chats') {
    if (req.method === 'GET') {
      const { chat_id } = req.query;
      if (chat_id) {
        await client.from('portal_chats').update({ unread_operator: 0 }).eq('id', chat_id);
        const offset = parseInt(req.query.offset) || 0;
        const limit = Math.min(parseInt(req.query.limit) || 1000, 2000);
        const { data: messages, count } = await client.from('portal_chat_messages').select('id, sender, body, meta, created_at', { count: 'exact' }).eq('chat_id', chat_id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        const sorted = await bot.signMessageUrls(client, (messages || []).reverse());
        const { data: chatRow } = await client.from('portal_chats').select('bot_enabled').eq('id', chat_id).maybeSingle();
        return res.status(200).json({ messages: sorted, total: count, offset, limit, bot_enabled: chatRow?.bot_enabled !== false });
      }
      const { data: chats } = await client.from('portal_chats').select('*, portal_players(id, username, full_name, whatsapp, status, casino_username)').order('last_message_at', { ascending: false }).limit(80);
      if (!chats) return res.status(200).json({ chats: [] });
      // Traer último mensaje de cada chat en una sola consulta
      const chatIds = chats.map(c => c.id);
      const { data: lastMsgs } = await client.from('portal_chat_messages')
        .select('id, chat_id, sender, body, created_at')
        .in('chat_id', chatIds)
        .order('created_at', { ascending: false });
      // Mapear el primer mensaje (más reciente) por chat_id
      const lastMsgMap = {};
      (lastMsgs || []).forEach(m => { if (!lastMsgMap[m.chat_id]) lastMsgMap[m.chat_id] = m; });
      const enriched = chats.map(c => ({ ...c, last_message: lastMsgMap[c.id] || null }));
      return res.status(200).json({ chats: enriched });
    }
    if (req.method === 'POST') {
      const { chat_id, body } = req.body;
      if (!chat_id || !body?.trim()) return res.status(400).json({ error: 'Faltan datos' });
      const { data: msg, error } = await client.from('portal_chat_messages').insert({ chat_id, sender: 'operator', body: body.trim() }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      const { data: chatRow } = await client.from('portal_chats').select('unread_player, player_id').eq('id', chat_id).single();
      await client.from('portal_chats').update({ last_message_at: new Date().toISOString(), unread_operator: 0, unread_player: (chatRow?.unread_player || 0) + 1 }).eq('id', chat_id);
      if (chatRow?.player_id) await sendPushToPlayer(client, chatRow.player_id, '🎧 CapiBet Soporte', body.trim());
      return res.status(201).json({ ok: true, message: msg });
    }
    // Prender/apagar el bot en una conversación (desde Chat Jugadores del CRM)
    if (req.method === 'PUT') {
      const { chat_id, bot_enabled } = req.body;
      if (!chat_id || typeof bot_enabled !== 'boolean') return res.status(400).json({ error: 'Faltan datos' });
      const { error } = await client.from('portal_chats').update({ bot_enabled }).eq('id', chat_id);
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(200).json({ ok: true, bot_enabled });
    }
    return res.status(405).end();
  }

  return res.status(404).json({ error: 'Ruta no encontrada' });
};

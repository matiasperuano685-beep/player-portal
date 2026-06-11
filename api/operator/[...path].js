const bcrypt = require('bcryptjs');
const { db, cors } = require('../_lib');

function isOperator(req) {
  const key = req.headers['x-operator-key'];
  return key && key === process.env.OPERATOR_KEY;
}

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isOperator(req)) return res.status(403).json({ error: 'Acceso denegado' });

  const slug = req.url.split('?')[0].replace(/^\/api\/operator\/?/, '').replace(/\/$/, '');
  const client = db();

  // ── PLAYERS ───────────────────────────────────────────
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
      const { error } = await client.from('portal_players').update(updates).eq('id', id);
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── TRANSACTIONS ──────────────────────────────────────
  if (slug === 'transactions') {
    if (req.method === 'GET') {
      const status = req.query.status || 'pending';
      let query = client.from('portal_transactions').select(`id, type, amount, status, notes, operator_notes, created_at, updated_at, portal_players (id, username, full_name, whatsapp, casino_username, balance)`).order('created_at', { ascending: false });
      if (status !== 'all') query = query.eq('status', status);
      const { data, error } = await query.limit(200);
      if (error) return res.status(500).json({ error: 'Error interno' });
      return res.status(200).json({ data });
    }
    if (req.method === 'PUT') {
      const { id, action, operator_notes } = req.body;
      if (!id || !action) return res.status(400).json({ error: 'Faltan datos' });
      if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción inválida' });
      const { data: tx, error: txErr } = await client.from('portal_transactions').select('*, portal_players(id, balance)').eq('id', id).single();
      if (txErr || !tx) return res.status(404).json({ error: 'Transacción no encontrada' });
      if (tx.status !== 'pending') return res.status(409).json({ error: 'La transacción ya fue procesada' });
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      await client.from('portal_transactions').update({ status: newStatus, operator_notes: operator_notes || null, updated_at: new Date().toISOString() }).eq('id', id);
      if (action === 'approve') {
        const player = tx.portal_players;
        const delta = tx.type === 'deposit' ? Number(tx.amount) : -Number(tx.amount);
        await client.from('portal_players').update({ balance: Math.max(0, Number(player.balance || 0) + delta) }).eq('id', player.id);
      }
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
      const { whatsapp_number, casino_url, min_deposit, min_withdrawal, bank_cbu, bank_alias, bank_name, bank_account_name } = req.body;
      const { data: existing } = await client.from('portal_settings').select('id').limit(1).maybeSingle();
      const payload = { whatsapp_number, casino_url, min_deposit, min_withdrawal, bank_cbu, bank_alias, bank_name, bank_account_name };
      if (existing) { await client.from('portal_settings').update(payload).eq('id', existing.id); }
      else { await client.from('portal_settings').insert(payload); }
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
        const { data: messages } = await client.from('portal_chat_messages').select('id, sender, body, created_at').eq('chat_id', chat_id).order('created_at', { ascending: true }).limit(200);
        return res.status(200).json({ messages: messages || [] });
      }
      const { data: chats } = await client.from('portal_chats').select('*, portal_players(id, username, full_name, whatsapp)').order('last_message_at', { ascending: false });
      if (!chats) return res.status(200).json({ chats: [] });
      const enriched = await Promise.all(chats.map(async (chat) => {
        const { data: lastMsg } = await client.from('portal_chat_messages').select('sender, body, created_at').eq('chat_id', chat.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        return { ...chat, last_message: lastMsg };
      }));
      return res.status(200).json({ chats: enriched });
    }
    if (req.method === 'POST') {
      const { chat_id, body } = req.body;
      if (!chat_id || !body?.trim()) return res.status(400).json({ error: 'Faltan datos' });
      const { data: msg, error } = await client.from('portal_chat_messages').insert({ chat_id, sender: 'operator', body: body.trim() }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      const { data: chatRow } = await client.from('portal_chats').select('unread_player').eq('id', chat_id).single();
      await client.from('portal_chats').update({ last_message_at: new Date().toISOString(), unread_operator: 0, unread_player: (chatRow?.unread_player || 0) + 1 }).eq('id', chat_id);
      return res.status(201).json({ ok: true, message: msg });
    }
    return res.status(405).end();
  }

  return res.status(404).json({ error: 'Ruta no encontrada' });
};

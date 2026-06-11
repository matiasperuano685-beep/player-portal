const bcrypt = require('bcryptjs');
const { db, signToken, verifyToken, cors, rateLimit } = require('../_lib');

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const slug = (req.query.path || []).join('/');

  // ── LOGIN ──────────────────────────────────────────────
  if (slug === 'login') {
    if (req.method !== 'POST') return res.status(405).end();
    if (rateLimit(req, 8, 60000)) return res.status(429).json({ error: 'Demasiados intentos. Esperá un momento.' });
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
      const client = db();
      const { data: player, error } = await client.from('portal_players').select('*').eq('username', username.toLowerCase().trim()).eq('status', 'active').single();
      if (error || !player) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      const valid = await bcrypt.compare(password, player.password_hash);
      if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      const token = signToken(player);
      return res.status(200).json({ token, player: { id: player.id, username: player.username, full_name: player.full_name, whatsapp: player.whatsapp, casino_username: player.casino_username, balance: player.balance } });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── REGISTER ───────────────────────────────────────────
  if (slug === 'register') {
    if (req.method !== 'POST') return res.status(405).end();
    if (rateLimit(req, 5, 60000)) return res.status(429).json({ error: 'Demasiados intentos. Esperá un momento.' });
    try {
      const { username, password, full_name, whatsapp } = req.body;
      if (!username || !password || !full_name) return res.status(400).json({ error: 'Faltan datos obligatorios' });
      if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const client = db();
      const hash = await bcrypt.hash(password, 10);
      const { data: player, error } = await client.from('portal_players').insert({ username: username.toLowerCase().trim(), password_hash: hash, full_name: full_name.trim(), whatsapp: whatsapp?.trim() || null, status: 'active' }).select().single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe' });
        throw error;
      }
      const token = signToken(player);
      return res.status(201).json({ token, player: { id: player.id, username: player.username, full_name: player.full_name, whatsapp: player.whatsapp, casino_username: player.casino_username, balance: player.balance } });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── Rutas autenticadas ─────────────────────────────────
  const claim = verifyToken(req);
  if (!claim) return res.status(401).json({ error: 'No autorizado' });
  const client = db();

  // ── ME ────────────────────────────────────────────────
  if (slug === 'me') {
    try {
      const { data: player } = await client.from('portal_players').select('id, username, full_name, whatsapp, casino_username, balance, status').eq('id', claim.id).single();
      const { data: bank } = await client.from('portal_bank_accounts').select('*').eq('player_id', claim.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const { data: settings } = await client.from('portal_settings').select('whatsapp_number, casino_url, min_deposit, min_withdrawal, bank_cbu, bank_alias, bank_name, bank_account_name').limit(1).maybeSingle();
      return res.status(200).json({ player, bank, settings });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── TRANSACTIONS ──────────────────────────────────────
  if (slug === 'transactions') {
    try {
      const { data, error } = await client.from('portal_transactions').select('id, type, amount, status, notes, operator_notes, created_at, updated_at').eq('player_id', claim.id).order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.status(200).json({ data });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── DEPOSIT ───────────────────────────────────────────
  if (slug === 'deposit') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const { amount, notes } = req.body;
      if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
      const { data: settings } = await client.from('portal_settings').select('min_deposit').limit(1).maybeSingle();
      const minDeposit = settings?.min_deposit || 0;
      if (Number(amount) < minDeposit) return res.status(400).json({ error: `El monto mínimo de carga es $${Number(minDeposit).toLocaleString('es-AR')}` });
      const { data: hasPending } = await client.from('portal_transactions').select('id').eq('player_id', claim.id).eq('type', 'deposit').eq('status', 'pending').maybeSingle();
      if (hasPending) return res.status(409).json({ error: 'Ya tenés una carga pendiente de aprobación' });
      const { data, error } = await client.from('portal_transactions').insert({ player_id: claim.id, type: 'deposit', amount: Number(amount), status: 'pending', notes: notes || null }).select().single();
      if (error) throw error;
      return res.status(201).json({ ok: true, transaction: data });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── WITHDRAW ──────────────────────────────────────────
  if (slug === 'withdraw') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const { amount, notes } = req.body;
      if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
      const { data: player } = await client.from('portal_players').select('balance').eq('id', claim.id).single();
      const { data: settings } = await client.from('portal_settings').select('min_withdrawal').limit(1).maybeSingle();
      const minWithdrawal = settings?.min_withdrawal || 0;
      if (Number(amount) < minWithdrawal) return res.status(400).json({ error: `El monto mínimo de retiro es $${Number(minWithdrawal).toLocaleString('es-AR')}` });
      if (Number(amount) > Number(player?.balance || 0)) return res.status(400).json({ error: 'Saldo insuficiente' });
      const { data: bank } = await client.from('portal_bank_accounts').select('id').eq('player_id', claim.id).limit(1).maybeSingle();
      if (!bank) return res.status(400).json({ error: 'Debés cargar tu cuenta bancaria antes de retirar' });
      const { data: hasPending } = await client.from('portal_transactions').select('id').eq('player_id', claim.id).eq('type', 'withdrawal').eq('status', 'pending').maybeSingle();
      if (hasPending) return res.status(409).json({ error: 'Ya tenés un retiro pendiente de aprobación' });
      const { data, error } = await client.from('portal_transactions').insert({ player_id: claim.id, type: 'withdrawal', amount: Number(amount), status: 'pending', notes: notes || null }).select().single();
      if (error) throw error;
      return res.status(201).json({ ok: true, transaction: data });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── BANK ──────────────────────────────────────────────
  if (slug === 'bank') {
    if (req.method !== 'PUT') return res.status(405).end();
    try {
      const { bank_name, cbu, alias, account_name } = req.body;
      if (!cbu && !alias) return res.status(400).json({ error: 'Ingresá al menos un CBU o alias' });
      await client.from('portal_bank_accounts').delete().eq('player_id', claim.id);
      const { data, error } = await client.from('portal_bank_accounts').insert({ player_id: claim.id, bank_name, cbu, alias, account_name }).select().single();
      if (error) throw error;
      return res.status(200).json({ ok: true, bank: data });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── PROFILE ───────────────────────────────────────────
  if (slug === 'profile') {
    if (req.method !== 'PUT') return res.status(405).end();
    try {
      const { full_name, whatsapp, current_password, new_password } = req.body;
      const updates = {};
      if (full_name) updates.full_name = full_name.trim();
      if (whatsapp !== undefined) updates.whatsapp = whatsapp.trim() || null;
      if (new_password) {
        if (!current_password) return res.status(400).json({ error: 'Ingresá tu contraseña actual' });
        if (new_password.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
        const { data: p } = await client.from('portal_players').select('password_hash').eq('id', claim.id).single();
        const valid = await bcrypt.compare(current_password, p.password_hash);
        if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
        updates.password_hash = await bcrypt.hash(new_password, 10);
      }
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para actualizar' });
      const { error } = await client.from('portal_players').update(updates).eq('id', claim.id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── CHAT ──────────────────────────────────────────────
  if (slug === 'chat') {
    if (req.method === 'GET') {
      try {
        let { data: chat } = await client.from('portal_chats').select('*').eq('player_id', claim.id).maybeSingle();
        if (!chat) {
          const { data: newChat } = await client.from('portal_chats').insert({ player_id: claim.id }).select().single();
          chat = newChat;
        } else {
          await client.from('portal_chats').update({ unread_player: 0 }).eq('id', chat.id);
        }
        const { data: messages } = await client.from('portal_chat_messages').select('id, sender, body, created_at').eq('chat_id', chat.id).order('created_at', { ascending: true }).limit(200);
        return res.status(200).json({ chat_id: chat.id, messages: messages || [] });
      } catch { return res.status(500).json({ error: 'Error interno' }); }
    }
    if (req.method === 'POST') {
      try {
        const { body, chat_id } = req.body;
        if (!body?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
        let chatId = chat_id;
        if (!chatId) {
          let { data: chat } = await client.from('portal_chats').select('id').eq('player_id', claim.id).maybeSingle();
          if (!chat) { const { data: nc } = await client.from('portal_chats').insert({ player_id: claim.id }).select().single(); chat = nc; }
          chatId = chat.id;
        }
        const { data: msg, error } = await client.from('portal_chat_messages').insert({ chat_id: chatId, sender: 'player', body: body.trim() }).select().single();
        if (error) throw error;
        const { data: chatRow } = await client.from('portal_chats').select('unread_operator').eq('id', chatId).single();
        await client.from('portal_chats').update({ last_message_at: new Date().toISOString(), unread_operator: (chatRow?.unread_operator || 0) + 1 }).eq('id', chatId);
        return res.status(201).json({ ok: true, message: msg });
      } catch { return res.status(500).json({ error: 'Error interno' }); }
    }
    return res.status(405).end();
  }

  return res.status(404).json({ error: 'Ruta no encontrada' });
};

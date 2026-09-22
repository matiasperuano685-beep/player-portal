const bcrypt = require('bcryptjs');
const { db, signToken, verifyToken, cors, rateLimit } = require('../_lib');
const bot = require('../_bot');

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const slug = req.url.split('?')[0].replace(/^\/api\/player\/?/, '').replace(/\/$/, '');

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
      // Actualizar último login (sin await para no demorar la respuesta)
      client.from('portal_players').update({ last_login_at: new Date().toISOString() }).eq('id', player.id).then(() => {});
      return res.status(200).json({ token, player: { id: player.id, username: player.username, full_name: player.full_name, whatsapp: player.whatsapp, casino_username: player.casino_username, balance: player.balance } });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── REGISTER ───────────────────────────────────────────
  if (slug === 'register') {
    if (req.method !== 'POST') return res.status(405).end();
    // El alta la hace un operador desde el CRM: el jugador pide su usuario por
    // WhatsApp. Se puede reabrir con ALLOW_PUBLIC_REGISTER=true.
    if (process.env.ALLOW_PUBLIC_REGISTER !== 'true') {
      return res.status(403).json({ error: 'Para crear tu cuenta escribinos por WhatsApp y un operador te la genera.' });
    }
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
      const { data: settings } = await client.from('portal_settings').select('min_withdrawal').limit(1).maybeSingle();
      const minWithdrawal = settings?.min_withdrawal || 0;
      if (Number(amount) < minWithdrawal) return res.status(400).json({ error: `El monto mínimo de retiro es $${Number(minWithdrawal).toLocaleString('es-AR')}` });
      const { data: bank } = await client.from('portal_bank_accounts').select('id').eq('player_id', claim.id).limit(1).maybeSingle();
      if (!bank) return res.status(400).json({ error: 'Debés cargar tu cuenta bancaria antes de retirar' });
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

  // ── UPLOAD COMPROBANTE ───────────────────────────────
  if (slug === 'upload') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const { imageBase64, mimeType } = req.body;
      if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'Faltan datos' });
      const buffer = Buffer.from(imageBase64, 'base64');
      const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : mimeType === 'image/gif' ? 'gif' : 'jpg';
      const filename = `${claim.id}_${Date.now()}.${ext}`;
      const { error: upErr } = await client.storage.from('comprobantes').upload(filename, buffer, { contentType: mimeType, upsert: false });
      if (upErr) return res.status(500).json({ error: 'Error subiendo imagen' });
      const { data: urlData } = client.storage.from('comprobantes').getPublicUrl(filename);
      return res.status(200).json({ url: urlData.publicUrl });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── PUSH SUBSCRIBE ────────────────────────────────────
  if (slug === 'push-subscribe') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const { subscription } = req.body;
      if (!subscription) return res.status(400).json({ error: 'Falta subscription' });
      await client.from('portal_push_subscriptions').delete().eq('player_id', claim.id);
      await client.from('portal_push_subscriptions').insert({ player_id: claim.id, subscription });
      return res.status(200).json({ ok: true });
    } catch { return res.status(500).json({ error: 'Error interno' }); }
  }

  // ── CHAT ──────────────────────────────────────────────
  if (slug === 'chat') {
    if (req.method === 'GET') {
      try {
        const chat = await bot.getOrCreateChat(client, claim.id);
        await client.from('portal_chats').update({ unread_player: 0 }).eq('id', chat.id);
        const { data: messages } = await client.from('portal_chat_messages').select('id, sender, body, meta, created_at').eq('chat_id', chat.id).order('created_at', { ascending: true }).limit(200);
        const settings = await bot.getSettings(client);
        return res.status(200).json({
          chat_id: chat.id,
          bot_active: bot.botActive(settings, claim.username, chat),
          // Diagnóstico (solo booleanos, sin datos sensibles): ayuda a ver por qué
          // el bot no responde — apagado en general, en este chat, o sin lista de prueba.
          bot_debug: {
            global: !!settings?.bot_enabled,
            este_chat: chat?.bot_enabled !== false,
            hay_lista_de_prueba: !!(process.env.BOT_TEST_USERS || '').trim(),
            estoy_en_la_lista: (process.env.BOT_TEST_USERS || '').split(',').map(s => s.trim().toLowerCase()).includes(String(claim.username || '').toLowerCase()),
          },
          messages: await bot.signMessageUrls(client, messages || []),
        });
      } catch { return res.status(500).json({ error: 'Error interno' }); }
    }
    if (req.method === 'POST') {
      try {
        const { body, action } = req.body;
        const labels = { cargar: '💰 Quiero cargar', retirar: '💸 Quiero retirar', soporte: '🎧 Necesito ayuda' };
        if (action && !labels[action]) return res.status(400).json({ error: 'Acción inválida' });
        const text = action ? labels[action] : body?.trim();
        if (!text) return res.status(400).json({ error: 'Mensaje vacío' });
        const chat = await bot.getOrCreateChat(client, claim.id);
        const msg = await bot.insertMessage(client, chat.id, 'player', text, action ? { action } : null);
        await bot.touchChat(client, chat.id, 'player');
        let replies = [];
        const settings = await bot.getSettings(client);
        if (bot.botActive(settings, claim.username, chat)) {
          try {
            replies = action
              ? await bot.replyToAction(client, { chatId: chat.id, playerId: claim.id, action, settings })
              : await bot.maybeWelcome(client, chat.id);
          } catch (e) { console.error('bot reply', e); }
        }
        return res.status(201).json({ ok: true, message: msg, replies });
      } catch { return res.status(500).json({ error: 'Error interno' }); }
    }
    return res.status(405).end();
  }

  // ── CHAT: CARGA CON COMPROBANTE ───────────────────────
  if (slug === 'chat/deposit') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const { amount, imageBase64, mimeType } = req.body;
      if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'Ingresá el monto que transferiste' });
      if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'Adjuntá el comprobante' });
      const settings = await bot.getSettings(client);
      if (Number(amount) < Number(settings.min_deposit || 0)) return res.status(400).json({ error: `El monto mínimo de carga es $${bot.money(settings.min_deposit)}` });
      const file = await bot.uploadComprobante(client, claim.id, imageBase64, mimeType);
      const chat = await bot.getOrCreateChat(client, claim.id);
      const { data: tx, error: txErr } = await client.from('portal_transactions')
        .insert({ player_id: claim.id, type: 'deposit', amount: Number(amount), status: 'pending', comprobante_path: file.path, chat_id: chat.id })
        .select().single();
      if (txErr) throw txErr;
      const isPdf = mimeType === 'application/pdf';
      const body = `💰 SOLICITUD DE CARGA\n💵 Monto: $${bot.money(amount)}\n${isPdf ? '📄 Comprobante PDF: ' : ''}${file.url}`;
      const msg = await bot.insertMessage(client, chat.id, 'player', body, { type: 'comprobante', tx_id: tx.id, amount: Number(amount) });
      await bot.touchChat(client, chat.id, 'player');
      const replies = [await bot.botSay(client, chat.id, `⏳ Recibimos tu comprobante por $${bot.money(amount)}. Lo estamos verificando y te avisamos por acá.`, { type: 'status', tx_id: tx.id })];
      return res.status(201).json({ ok: true, messages: await bot.signMessageUrls(client, [msg, ...replies]) });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('chat/deposit', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  }

  // ── CHAT: RETIRO ──────────────────────────────────────
  if (slug === 'chat/withdraw') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const { amount } = req.body;
      if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });
      const settings = await bot.getSettings(client);
      if (Number(amount) < Number(settings.min_withdrawal || 0)) return res.status(400).json({ error: `El monto mínimo de retiro es $${bot.money(settings.min_withdrawal)}` });
      const { data: bank } = await client.from('portal_bank_accounts').select('bank_name, cbu, alias, account_name').eq('player_id', claim.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!bank) return res.status(400).json({ error: 'Debés cargar tu cuenta bancaria antes de retirar' });
      const chat = await bot.getOrCreateChat(client, claim.id);
      const { data: tx, error: txErr } = await client.from('portal_transactions')
        .insert({ player_id: claim.id, type: 'withdrawal', amount: Number(amount), status: 'pending', chat_id: chat.id })
        .select().single();
      if (txErr) throw txErr;
      const bankInfo = [`🏦 Banco: ${bank.bank_name || '—'}`, `📋 CBU: ${bank.cbu || '—'}`, `🔤 Alias: ${bank.alias || '—'}`, `👤 Titular: ${bank.account_name || '—'}`].join('\n');
      const msg = await bot.insertMessage(client, chat.id, 'player', `💸 SOLICITUD DE RETIRO\n💵 Monto: $${bot.money(amount)}\n${bankInfo}`, { type: 'withdraw_request', tx_id: tx.id, amount: Number(amount) });
      await bot.touchChat(client, chat.id, 'player');
      const replies = [await bot.botSay(client, chat.id, `⏳ Recibimos tu pedido de retiro por $${bot.money(amount)}. Un operador lo procesa y te avisamos por acá.`, { type: 'status', tx_id: tx.id })];
      return res.status(201).json({ ok: true, messages: [msg, ...replies] });
    } catch (e) {
      console.error('chat/withdraw', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  }

  return res.status(404).json({ error: 'Ruta no encontrada' });
};

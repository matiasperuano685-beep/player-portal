const { db, verifyToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const claim = verifyToken(req);
  if (!claim) return res.status(401).json({ error: 'No autorizado' });

  const client = db();

  // GET — obtener o crear chat y sus mensajes
  if (req.method === 'GET') {
    let { data: chat } = await client
      .from('portal_chats')
      .select('*')
      .eq('player_id', claim.id)
      .maybeSingle();

    if (!chat) {
      const { data: newChat } = await client
        .from('portal_chats')
        .insert({ player_id: claim.id })
        .select()
        .single();
      chat = newChat;
    } else {
      await client.from('portal_chats').update({ unread_player: 0 }).eq('id', chat.id);
    }

    const { data: messages } = await client
      .from('portal_chat_messages')
      .select('id, sender, body, created_at')
      .eq('chat_id', chat.id)
      .order('created_at', { ascending: true })
      .limit(200);

    return res.status(200).json({ chat_id: chat.id, messages: messages || [] });
  }

  // POST — jugador envía mensaje
  if (req.method === 'POST') {
    const { body, chat_id } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

    let chatId = chat_id;
    if (!chatId) {
      let { data: chat } = await client.from('portal_chats').select('id').eq('player_id', claim.id).maybeSingle();
      if (!chat) {
        const { data: newChat } = await client.from('portal_chats').insert({ player_id: claim.id }).select().single();
        chat = newChat;
      }
      chatId = chat.id;
    }

    const { data: msg, error } = await client
      .from('portal_chat_messages')
      .insert({ chat_id: chatId, sender: 'player', body: body.trim() })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Actualizar last_message_at e incrementar unread del operador
    const { data: chatRow } = await client.from('portal_chats').select('unread_operator').eq('id', chatId).single();
    await client.from('portal_chats').update({
      last_message_at: new Date().toISOString(),
      unread_operator: (chatRow?.unread_operator || 0) + 1
    }).eq('id', chatId);

    return res.status(201).json({ ok: true, message: msg });
  }

  res.status(405).end();
};

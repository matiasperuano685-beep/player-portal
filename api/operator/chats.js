const { db, cors } = require('../_lib');

function authOperator(req) {
  const key = req.headers['x-operator-key'];
  return key && key === process.env.OPERATOR_KEY;
}

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!authOperator(req)) return res.status(401).json({ error: 'No autorizado' });

  const client = db();

  // GET — listar todos los chats con último mensaje
  if (req.method === 'GET') {
    const { chat_id } = req.query;

    if (chat_id) {
      // Mensajes de un chat específico
      await client.from('portal_chats').update({ unread_operator: 0 }).eq('id', chat_id);
      const { data: messages } = await client
        .from('portal_chat_messages')
        .select('id, sender, body, created_at')
        .eq('chat_id', chat_id)
        .order('created_at', { ascending: true })
        .limit(200);
      return res.status(200).json({ messages: messages || [] });
    }

    // Lista de todos los chats
    const { data: chats } = await client
      .from('portal_chats')
      .select('*, portal_players(id, username, full_name, whatsapp)')
      .order('last_message_at', { ascending: false });

    if (!chats) return res.status(200).json({ chats: [] });

    // Último mensaje de cada chat
    const enriched = await Promise.all(chats.map(async (chat) => {
      const { data: lastMsg } = await client
        .from('portal_chat_messages')
        .select('sender, body, created_at')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return { ...chat, last_message: lastMsg };
    }));

    return res.status(200).json({ chats: enriched });
  }

  // POST — operador responde a un chat
  if (req.method === 'POST') {
    const { chat_id, body } = req.body;
    if (!chat_id || !body?.trim()) return res.status(400).json({ error: 'Faltan datos' });

    const { data: msg, error } = await client
      .from('portal_chat_messages')
      .insert({ chat_id, sender: 'operator', body: body.trim() })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const { data: chatRow } = await client.from('portal_chats').select('unread_player').eq('id', chat_id).single();
    await client.from('portal_chats').update({
      last_message_at: new Date().toISOString(),
      unread_operator: 0,
      unread_player: (chatRow?.unread_player || 0) + 1
    }).eq('id', chat_id);

    return res.status(201).json({ ok: true, message: msg });
  }

  res.status(405).end();
};

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

  const client = db();

  if (req.method === 'GET') {
    const { data, error } = await client
      .from('portal_players')
      .select('id, username, full_name, whatsapp, casino_username, balance, status, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Error interno' });
    return res.status(200).json({ data });
  }

  if (req.method === 'POST') {
    const { username, password, full_name, whatsapp, casino_username } = req.body;
    if (!username || !password || !full_name) return res.status(400).json({ error: 'Faltan datos' });
    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await client
      .from('portal_players')
      .insert({ username: username.toLowerCase().trim(), password_hash: hash, full_name, whatsapp, casino_username, status: 'active' })
      .select('id, username, full_name, whatsapp, casino_username, balance, status')
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe' });
      return res.status(500).json({ error: 'Error interno' });
    }
    return res.status(201).json({ ok: true, player: data });
  }

  if (req.method === 'PUT') {
    const { id, balance, status, casino_username, full_name, whatsapp } = req.body;
    if (!id) return res.status(400).json({ error: 'Falta id' });
    const updates = {};
    if (balance !== undefined) updates.balance = Number(balance);
    if (status) updates.status = status;
    if (casino_username !== undefined) updates.casino_username = casino_username;
    if (full_name) updates.full_name = full_name;
    if (whatsapp !== undefined) updates.whatsapp = whatsapp;
    const { error } = await client.from('portal_players').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: 'Error interno' });
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};

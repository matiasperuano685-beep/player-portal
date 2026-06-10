const bcrypt = require('bcryptjs');
const { dbAuthed, signToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { username, password, full_name, whatsapp } = req.body;
    if (!username || !password || !full_name) return res.status(400).json({ error: 'Faltan datos obligatorios' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const client = await dbAuthed();
    const hash = await bcrypt.hash(password, 10);

    const { data: player, error } = await client
      .from('portal_players')
      .insert({
        username: username.toLowerCase().trim(),
        password_hash: hash,
        full_name: full_name.trim(),
        whatsapp: whatsapp?.trim() || null,
        status: 'active'
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe' });
      throw error;
    }

    const token = signToken(player);
    res.status(201).json({
      token,
      player: {
        id: player.id, username: player.username, full_name: player.full_name,
        whatsapp: player.whatsapp, casino_username: player.casino_username,
        balance: player.balance
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

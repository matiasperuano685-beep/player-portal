const bcrypt = require('bcryptjs');
const { dbAuthed, signToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });

    const client = await dbAuthed();
    const { data: player, error } = await client
      .from('portal_players')
      .select('*')
      .eq('username', username.toLowerCase().trim())
      .eq('status', 'active')
      .single();

    if (error || !player) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const valid = await bcrypt.compare(password, player.password_hash);
    if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const token = signToken(player);
    res.status(200).json({
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

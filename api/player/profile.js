const bcrypt = require('bcryptjs');
const { dbAuthed, verifyToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') return res.status(405).end();

  const claim = verifyToken(req);
  if (!claim) return res.status(401).json({ error: 'No autorizado' });

  try {
    const { full_name, whatsapp, current_password, new_password } = req.body;
    const client = await dbAuthed();

    const updates = {};
    if (full_name) updates.full_name = full_name.trim();
    if (whatsapp !== undefined) updates.whatsapp = whatsapp.trim() || null;

    if (new_password) {
      if (!current_password) return res.status(400).json({ error: 'Ingresá tu contraseña actual' });
      if (new_password.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });

      const { data: player } = await client.from('portal_players').select('password_hash').eq('id', claim.id).single();
      const valid = await bcrypt.compare(current_password, player.password_hash);
      if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
      updates.password_hash = await bcrypt.hash(new_password, 10);
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para actualizar' });

    const { error } = await client.from('portal_players').update(updates).eq('id', claim.id);
    if (error) throw error;
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

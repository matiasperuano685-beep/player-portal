const { dbAuthed, verifyToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const claim = verifyToken(req);
  if (!claim) return res.status(401).json({ error: 'No autorizado' });

  try {
    const client = await dbAuthed();
    const { data, error } = await client
      .from('portal_transactions')
      .select('id, type, amount, status, notes, operator_notes, created_at, updated_at')
      .eq('player_id', claim.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    res.status(200).json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

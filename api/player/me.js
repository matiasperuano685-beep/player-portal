const { dbAuthed, verifyToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const claim = verifyToken(req);
  if (!claim) return res.status(401).json({ error: 'No autorizado' });

  try {
    const client = await dbAuthed();
    const { data: player } = await client
      .from('portal_players')
      .select('id, username, full_name, whatsapp, casino_username, balance, status')
      .eq('id', claim.id)
      .single();

    const { data: bank } = await client
      .from('portal_bank_accounts')
      .select('*')
      .eq('player_id', claim.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: settings } = await client
      .from('portal_settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    res.status(200).json({ player, bank, settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

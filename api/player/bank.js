const { dbAuthed, verifyToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') return res.status(405).end();

  const claim = verifyToken(req);
  if (!claim) return res.status(401).json({ error: 'No autorizado' });

  try {
    const { bank_name, cbu, alias, account_name } = req.body;
    if (!cbu && !alias) return res.status(400).json({ error: 'Ingresá al menos un CBU o alias' });

    const client = await dbAuthed();

    await client.from('portal_bank_accounts').delete().eq('player_id', claim.id);

    const { data, error } = await client
      .from('portal_bank_accounts')
      .insert({ player_id: claim.id, bank_name, cbu, alias, account_name })
      .select()
      .single();

    if (error) throw error;
    res.status(200).json({ ok: true, bank: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

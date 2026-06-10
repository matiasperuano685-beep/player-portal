const { dbAuthed, cors } = require('../_lib');

function isOperator(req) {
  return req.headers['x-operator-key'] === process.env.OPERATOR_KEY;
}

module.exports = async (req, res) => {
  cors(res);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-operator-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isOperator(req)) return res.status(403).json({ error: 'Acceso denegado' });

  const client = await dbAuthed();

  if (req.method === 'GET') {
    const { data } = await client.from('portal_settings').select('*').limit(1).maybeSingle();
    return res.status(200).json({ settings: data });
  }

  if (req.method === 'PUT') {
    const { whatsapp_number, casino_url, min_deposit, min_withdrawal, bank_cbu, bank_alias, bank_name, bank_account_name } = req.body;
    const { data: existing } = await client.from('portal_settings').select('id').limit(1).maybeSingle();
    const payload = { whatsapp_number, casino_url, min_deposit, min_withdrawal, bank_cbu, bank_alias, bank_name, bank_account_name };
    if (existing) {
      await client.from('portal_settings').update(payload).eq('id', existing.id);
    } else {
      await client.from('portal_settings').insert(payload);
    }
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};

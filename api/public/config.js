const { cors } = require('../_lib');

module.exports = (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  // La anon key es segura de exponer — solo permite lo que RLS permita
  res.status(200).json({
    url: process.env.SUPABASE_URL,
    anon_key: process.env.SUPABASE_ANON_KEY
  });
};

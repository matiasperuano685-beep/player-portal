const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  const svc = process.env.SUPABASE_SERVICE_KEY || '';

  // Test connection
  let testResult = null;
  try {
    const client = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await client.from('portal_settings').select('id').limit(1);
    testResult = error ? { error: error.message, code: error.code } : { ok: true, rows: data?.length };
  } catch(e) {
    testResult = { threw: e.message };
  }

  res.status(200).json({
    url_set: !!url,
    url_preview: url ? url.substring(0, 30) + '...' : null,
    anon_key_set: !!key,
    anon_key_len: key.length,
    anon_key_preview: key ? key.substring(0, 20) + '...' : null,
    svc_key_set: !!svc,
    test: testResult
  });
};

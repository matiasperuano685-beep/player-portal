const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  const svc = process.env.SUPABASE_SERVICE_KEY || '';

  // Test with anon key
  let testAnon = null;
  try {
    const client = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await client.from('portal_players').insert({ username: 'debug_test_' + Date.now(), password_hash: 'x', full_name: 'test' }).select().single();
    if (data) { await client.from('portal_players').delete().eq('id', data.id); }
    testAnon = error ? { error: error.message } : { ok: true };
  } catch(e) { testAnon = { threw: e.message }; }

  // Test with service key
  let testSvc = null;
  try {
    const client = createClient(url, svc, { auth: { persistSession: false } });
    const { data, error } = await client.from('portal_players').insert({ username: 'debug_svc_' + Date.now(), password_hash: 'x', full_name: 'test' }).select().single();
    if (data) { await client.from('portal_players').delete().eq('id', data.id); }
    testSvc = error ? { error: error.message } : { ok: true };
  } catch(e) { testSvc = { threw: e.message }; }

  const testResult = { anon: testAnon, svc: testSvc };

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

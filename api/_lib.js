const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

async function dbAuthed() {
  const client = db();
  await client.auth.signInWithPassword({
    email: process.env.SUPABASE_EMAIL,
    password: process.env.SUPABASE_PASSWORD
  });
  return client;
}

function signToken(player) {
  return jwt.sign(
    { id: player.id, username: player.username, role: 'player' },
    process.env.PORTAL_JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.PORTAL_JWT_SECRET);
  } catch {
    return null;
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { db, dbAuthed, signToken, verifyToken, cors };

import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

async function getAccessToken() {
  const tokens = await redis.get('gmail_tokens');
  if (!tokens) return null;
  
  const t = typeof tokens === 'string' ? JSON.parse(tokens) : tokens;
  
  if (Date.now() > t.expiry_date) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: t.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const newTokens = await res.json();
    t.access_token = newTokens.access_token;
    t.expiry_date = Date.now() + newTokens.expires_in * 1000;
    await redis.set('gmail_tokens', JSON.stringify(t));
  }
  
  return t.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, query, to, subject, body } = req.body || {};
  const token = await getAccessToken();
  
  if (!token) return res.status(401).json({ error: 'Gmail no conectado. Andá a /api/auth?action=login' });

  if (action === 'read') {
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(query || 'is:unread')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const list = await listRes.json();
    
    if (!list.messages) return res.status(200).json({ emails: [] });
    
    const emails = await Promise.all(list.messages.slice(0, 5).map(async (m) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const msg = await msgRes.json();
      const headers = msg.payload.headers;
      return {
        id: m.id,
        from: headers.find(h => h.name === 'From')?.value,
        subject: headers.find(h => h.name === 'Subject')?.value,
        date: headers.find(h => h.name === 'Date')?.value,
        snippet: msg.snippet
      };
    }));
    
    return res.status(200).json({ emails });
  }

  if (action === 'send') {
    const email = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
    const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded })
    });
    
    return res.status(200).json({ ok: true });
  }

  res.status(400).json({ error: 'Acción no válida' });
}

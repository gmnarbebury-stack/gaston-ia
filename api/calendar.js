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

  const { action, title, start, end, description, days = 7 } = req.body || {};
  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  if (action === 'list') {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${future}&singleEvents=true&orderBy=startTime&maxResults=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    const events = (data.items || []).map(e => ({
      id: e.id,
      title: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      description: e.description,
      location: e.location
    }));
    return res.status(200).json({ events });
  }

  if (action === 'create') {
    const r = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: title,
          description,
          start: { dateTime: start, timeZone: 'America/Argentina/Buenos_Aires' },
          end: { dateTime: end, timeZone: 'America/Argentina/Buenos_Aires' }
        })
      }
    );
    const data = await r.json();
    return res.status(200).json({ ok: true, event: data });
  }

  res.status(400).json({ error: 'Acción no válida' });
}

import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

async function getTokens() {
  const raw = await redis.get('gmail_tokens');
  if (!raw) throw new Error('No autenticado. Conecta Gmail primero.');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function refreshIfNeeded(tokens) {
  if (Date.now() < tokens.expiry_date - 60000) return tokens;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await r.json();
  if (data.error) throw new Error('Error al renovar token: ' + data.error);
  const updated = { ...tokens, access_token: data.access_token, expiry_date: Date.now() + data.expires_in * 1000 };
  await redis.set('gmail_tokens', JSON.stringify(updated));
  return updated;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, spreadsheetId, range, values, title, sheetTitle } = req.body;

  try {
    let tokens = await getTokens();
    tokens = await refreshIfNeeded(tokens);
    const auth = 'Bearer ' + tokens.access_token;

    if (action === 'list') {
      const r = await fetch(
        "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.spreadsheet'&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=20",
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      return res.status(200).json({ sheets: d.files || [] });
    }

    if (action === 'read') {
      if (!spreadsheetId || !range) return res.status(400).json({ error: 'Falta spreadsheetId o range' });
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ values: d.values || [], range: d.range });
    }

    if (action === 'write') {
      if (!spreadsheetId || !range || !values) return res.status(400).json({ error: 'Falta spreadsheetId, range o values' });
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ range, majorDimension: 'ROWS', values })
        }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true, updatedCells: d.updatedCells });
    }

    if (action === 'append') {
      if (!spreadsheetId || !range || !values) return res.status(400).json({ error: 'Falta spreadsheetId, range o values' });
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ range, majorDimension: 'ROWS', values })
        }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'create') {
      if (!title) return res.status(400).json({ error: 'Falta title' });
      const body = { properties: { title }, sheets: [{ properties: { title: sheetTitle || 'Hoja1' } }] };
      const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true, spreadsheetId: d.spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${d.spreadsheetId}` });
    }

    if (action === 'info') {
      if (!spreadsheetId) return res.status(400).json({ error: 'Falta spreadsheetId' });
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties,sheets.properties`,
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ title: d.properties?.title, sheets: d.sheets?.map(s => s.properties) });
    }

    return res.status(400).json({ error: 'Accion no reconocida: ' + action });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

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

function extractText(doc) {
  const body = doc.body?.content || [];
  let text = '';
  for (const block of body) {
    if (block.paragraph) {
      for (const el of block.paragraph.elements || []) {
        if (el.textRun?.content) text += el.textRun.content;
      }
    }
    if (block.table) {
      for (const row of block.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const c of cell.content || []) {
            for (const el of c.paragraph?.elements || []) {
              if (el.textRun?.content) text += el.textRun.content + '\t';
            }
          }
        }
        text += '\n';
      }
    }
  }
  return text.trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, documentId, title, content, requests } = req.body;

  try {
    let tokens = await getTokens();
    tokens = await refreshIfNeeded(tokens);
    const auth = 'Bearer ' + tokens.access_token;

    if (action === 'list') {
      const r = await fetch(
        "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.document'&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=20",
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      return res.status(200).json({ docs: d.files || [] });
    }

    if (action === 'read') {
      if (!documentId) return res.status(400).json({ error: 'Falta documentId' });
      const r = await fetch(
        `https://docs.googleapis.com/v1/documents/${documentId}`,
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      const text = extractText(d);
      return res.status(200).json({ title: d.title, text, documentId: d.documentId });
    }

    if (action === 'create') {
      if (!title) return res.status(400).json({ error: 'Falta title' });
      const r = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      const docId = d.documentId;

      if (content) {
        await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{ insertText: { location: { index: 1 }, text: content } }]
          })
        });
      }

      return res.status(200).json({
        ok: true,
        documentId: docId,
        url: `https://docs.google.com/document/d/${docId}/edit`
      });
    }

    if (action === 'insert') {
      if (!documentId || !content) return res.status(400).json({ error: 'Falta documentId o content' });
      const infoR = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, { headers: { Authorization: auth } });
      const info = await infoR.json();
      if (info.error) return res.status(400).json({ error: info.error.message });
      const endIndex = info.body?.content?.at(-1)?.endIndex - 1 || 1;

      const r = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: endIndex }, text: '\n' + content } }]
        })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'batchUpdate') {
      if (!documentId || !requests) return res.status(400).json({ error: 'Falta documentId o requests' });
      const r = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Accion no reconocida: ' + action });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

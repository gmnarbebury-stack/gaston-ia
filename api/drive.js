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

  const { action, fileId, folderId, name, query, parentId, mimeType } = req.body;

  try {
    let tokens = await getTokens();
    tokens = await refreshIfNeeded(tokens);
    const auth = 'Bearer ' + tokens.access_token;
    const BASE = 'https://www.googleapis.com/drive/v3';

    // ── LISTAR archivos/carpetas ───────────────────────────────────────
    if (action === 'list') {
      const q = query || "'root' in parents and trashed=false";
      const r = await fetch(
        `${BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,parents,size)&orderBy=modifiedTime desc&pageSize=50&includeItemsFromAllDrives=true&supportsAllDrives=true`,
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ files: d.files || [] });
    }

    // ── BUSCAR archivos ───────────────────────────────────────────────
    if (action === 'search') {
      if (!name) return res.status(400).json({ error: 'Falta name para buscar' });
      const q = `name contains '${name.replace(/'/g,"\\'")}' and trashed=false`;
      const r = await fetch(
        `${BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,parents)&pageSize=20&includeItemsFromAllDrives=true&supportsAllDrives=true`,
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ files: d.files || [] });
    }

    // ── CREAR CARPETA ─────────────────────────────────────────────────
    if (action === 'create_folder') {
      if (!name) return res.status(400).json({ error: 'Falta name' });
      const body = {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {})
      };
      const r = await fetch(`${BASE}/files`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true, folderId: d.id, name: d.name, url: `https://drive.google.com/drive/folders/${d.id}` });
    }

    // ── MOVER archivo a carpeta ───────────────────────────────────────
    if (action === 'move') {
      if (!fileId || !folderId) return res.status(400).json({ error: 'Falta fileId o folderId' });
      // Obtener parents actuales
      const infoR = await fetch(`${BASE}/files/${fileId}?fields=parents`, { headers: { Authorization: auth } });
      const info = await infoR.json();
      if (info.error) return res.status(400).json({ error: info.error.message });
      const oldParents = (info.parents || []).join(',');
      const r = await fetch(
        `${BASE}/files/${fileId}?addParents=${folderId}&removeParents=${oldParents}&fields=id,name,parents&supportsAllDrives=true`,
        { method: 'PATCH', headers: { Authorization: auth } }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true, fileId: d.id, name: d.name });
    }

    // ── RENOMBRAR archivo o carpeta ───────────────────────────────────
    if (action === 'rename') {
      if (!fileId || !name) return res.status(400).json({ error: 'Falta fileId o name' });
      const r = await fetch(`${BASE}/files/${fileId}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true, fileId: d.id, name: d.name });
    }

    // ── ELIMINAR archivo o carpeta (mover a papelera) ─────────────────
    if (action === 'trash') {
      if (!fileId) return res.status(400).json({ error: 'Falta fileId' });
      const r = await fetch(`${BASE}/files/${fileId}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true });
    }

    // ── COPIAR archivo ────────────────────────────────────────────────
    if (action === 'copy') {
      if (!fileId) return res.status(400).json({ error: 'Falta fileId' });
      const body = { ...(name ? { name } : {}), ...(parentId ? { parents: [parentId] } : {}) };
      const r = await fetch(`${BASE}/files/${fileId}/copy?supportsAllDrives=true`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json({ ok: true, fileId: d.id, name: d.name });
    }

    // ── INFO de un archivo ────────────────────────────────────────────
    if (action === 'info') {
      if (!fileId) return res.status(400).json({ error: 'Falta fileId' });
      const r = await fetch(
        `${BASE}/files/${fileId}?fields=id,name,mimeType,modifiedTime,parents,size,webViewLink&supportsAllDrives=true`,
        { headers: { Authorization: auth } }
      );
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      return res.status(200).json(d);
    }

    return res.status(400).json({ error: 'Accion no reconocida: ' + action });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

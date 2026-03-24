export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token     = process.env.WHATSAPP_TOKEN;
  const phoneId   = process.env.WHATSAPP_PHONE_ID;
  const defaultTo = process.env.WHATSAPP_TO;

  if (!token || !phoneId) {
    return res.status(500).json({ error: 'Faltan variables WHATSAPP_TOKEN o WHATSAPP_PHONE_ID' });
  }

  const { action, to, message, template } = req.body;
  const recipient = to || defaultTo;

  if (!recipient) return res.status(400).json({ error: 'Falta numero destinatario' });

  // ── ENVIAR texto libre ────────────────────────────────────────────
  if (action === 'send') {
    if (!message) return res.status(400).json({ error: 'Falta message' });
    try {
      const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'text',
          text: { body: message }
        })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message, code: d.error.code });
      return res.status(200).json({ ok: true, messageId: d.messages?.[0]?.id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ENVIAR template (para iniciar conversacion nueva) ─────────────
  if (action === 'template') {
    try {
      const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'template',
          template: { name: template || 'hello_world', language: { code: 'es' } }
        })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message, code: d.error.code });
      return res.status(200).json({ ok: true, messageId: d.messages?.[0]?.id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Accion no reconocida: ' + action });
}

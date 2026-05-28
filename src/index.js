const http = require('http');
const crypto = require('crypto');
const { handleWhatsAppMessage } = require('./whatsapp');
require('./reminder');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

// Rate limiting simple en memoria
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minuto
  const maxRequests = 100;
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  const data = rateLimitMap.get(ip);
  if (now - data.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (data.count >= maxRequests) return true;
  data.count++;
  return false;
}
// Limpiar rate limit cada 5 minutos
setInterval(() => rateLimitMap.clear(), 5 * 60 * 1000);

// Verificar firma de Meta
function verifyMetaSignature(body, signature) {
  if (!process.env.META_APP_SECRET) return true; // si no hay secret configurado, pasar
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(body)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Verificar que la petición viene del panel (token simple)
function verifyPanelToken(req) {
  const token = req.headers['x-panel-token'];
  return token === process.env.PANEL_SECRET_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  // CORS headers para todas las respuestas
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-panel-token');

  // Rate limiting
  if (isRateLimited(ip)) {
    console.warn(`[Rate limit] IP bloqueada: ${ip}`);
    res.writeHead(429);
    res.end('Too Many Requests');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/webhook')) {
    const url = new URL(req.url, 'http://localhost');
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      console.log('Webhook verificado correctamente');
      res.writeHead(200);
      res.end(challenge);
    } else {
      console.warn(`[Security] Intento de verificación webhook fallido desde ${ip}`);
      res.writeHead(403);
      res.end('Forbidden');
    }

  } else if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      // Verificar firma Meta
      const signature = req.headers['x-hub-signature-256'];
      if (!verifyMetaSignature(body, signature)) {
        console.warn(`[Security] Firma Meta inválida desde ${ip}`);
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      try { req.body = JSON.parse(body); } catch(e) { req.body = {}; }
      await handleWhatsAppMessage(req, res);
    });

  } else if (req.method === 'POST' && req.url === '/send-message') {
    // Solo el panel puede llamar a este endpoint
    if (!verifyPanelToken(req)) {
      console.warn(`[Security] Token panel inválido en /send-message desde ${ip}`);
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { phone, message, restaurantId } = JSON.parse(body);
        const { sendWhatsAppMessage } = require('./whatsapp');
        const { saveMessage } = require('./database');
        await sendWhatsAppMessage(phone, message);
        await saveMessage(restaurantId, phone, null, 'outbound', message);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[send-message error]', e.message);
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  } else if (req.method === 'POST' && req.url === '/set-manual-mode') {
    if (!verifyPanelToken(req)) {
      console.warn(`[Security] Token panel inválido en /set-manual-mode desde ${ip}`);
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { phone, restaurantId, active } = JSON.parse(body);
        const { setManualMode } = require('./database');
        await setManualMode(restaurantId, phone, active);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[set-manual-mode error]', e.message);
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  } else if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end('Bot de reservas funcionando ✅');

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT} ✅`);
});
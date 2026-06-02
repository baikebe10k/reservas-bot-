const http = require('http');
const crypto = require('crypto');
const { handleWhatsAppMessage } = require('./whatsapp');
require('./reminder');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 100;
  if (!rateLimitMap.has(ip)) { rateLimitMap.set(ip, { count: 1, start: now }); return false; }
  const data = rateLimitMap.get(ip);
  if (now - data.start > windowMs) { rateLimitMap.set(ip, { count: 1, start: now }); return false; }
  if (data.count >= maxRequests) return true;
  data.count++;
  return false;
}
setInterval(() => rateLimitMap.clear(), 5 * 60 * 1000);

function verifyMetaSignature(body, signature) {
  if (!process.env.META_APP_SECRET) return true;
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

function verifyPanelToken(req) {
  const token = req.headers['x-panel-token'];
  return token === process.env.PANEL_SECRET_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-panel-token');

  if (isRateLimited(ip)) { console.warn(`[Rate limit] IP bloqueada: ${ip}`); res.writeHead(429); res.end('Too Many Requests'); return; }

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url.startsWith('/webhook')) {
    const url = new URL(req.url, 'http://localhost');
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      console.log('Webhook verificado correctamente');
      res.writeHead(200); res.end(challenge);
    } else {
      console.warn(`[Security] Intento de verificación webhook fallido desde ${ip}`);
      res.writeHead(403); res.end('Forbidden');
    }

  } else if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const signature = req.headers['x-hub-signature-256'];
      if (!verifyMetaSignature(body, signature)) { console.warn(`[Security] Firma Meta inválida desde ${ip}`); res.writeHead(401); res.end('Unauthorized'); return; }
      try { req.body = JSON.parse(body); } catch(e) { req.body = {}; }
      await handleWhatsAppMessage(req, res);
    });

  } else if (req.method === 'POST' && req.url === '/send-message') {
    if (!verifyPanelToken(req)) { console.warn(`[Security] Token panel inválido en /send-message desde ${ip}`); res.writeHead(401); res.end('Unauthorized'); return; }
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
    if (!verifyPanelToken(req)) { console.warn(`[Security] Token panel inválido en /set-manual-mode desde ${ip}`); res.writeHead(401); res.end('Unauthorized'); return; }
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

  } else if (req.method === 'POST' && req.url === '/confirm-reservation') {
    if (!verifyPanelToken(req)) { console.warn(`[Security] Token panel inválido en /confirm-reservation desde ${ip}`); res.writeHead(401); res.end('Unauthorized'); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { reservation, restaurantName, language } = JSON.parse(body);
        const { sendWhatsAppMessage } = require('./whatsapp');
        const { saveMessage } = require('./database');

        const weekdays = { es: ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'], ca: ['diumenge','dilluns','dimarts','dimecres','dijous','divendres','dissabte'], en: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], fr: ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'], de: ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'] };
        const months = { es: ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'], ca: ['gener','febrer','març','abril','maig','juny','juliol','agost','setembre','octubre','novembre','desembre'], en: ['January','February','March','April','May','June','July','August','September','October','November','December'], fr: ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'], de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'] };
        const endings = { es: `¡Todo listo! Te esperamos 🎉 Si necesitas cambiar algo, responde aquí.`, ca: `Tot llest! T'esperem 🎉 Si necessites canviar alguna cosa, respon aquí.`, en: `All set! We look forward to seeing you 🎉 If you need to change anything, reply here.`, fr: `Tout est prêt! Nous vous attendons 🎉 Si vous avez besoin de modifier quoi que ce soit, répondez ici.`, de: `Alles bereit! Wir freuen uns auf Sie 🎉 Falls Sie etwas ändern möchten, antworten Sie hier.` };

        const lang = language || 'es';
        const d = new Date(reservation.date + 'T12:00:00');
        const dayName = (weekdays[lang] || weekdays.es)[d.getDay()];
        const monthName = (months[lang] || months.es)[d.getMonth()];

        const message = `✅ *Reserva confirmada en ${restaurantName}*\n\nHola ${reservation.customer_name} 😊\n📅 ${dayName} ${d.getDate()} de ${monthName}\n🕘 ${reservation.time}\n👥 ${reservation.guests} persona(s)\n\n${endings[lang] || endings.es}`;

        await sendWhatsAppMessage(reservation.customer_phone, message);
        await saveMessage(reservation.restaurant_id, reservation.customer_phone, reservation.customer_name, 'outbound', message);

        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[confirm-reservation error]', e.message);
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  } else if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200); res.end('Bot de reservas funcionando ✅');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => { console.log(`Servidor iniciado en puerto ${PORT} ✅`); });
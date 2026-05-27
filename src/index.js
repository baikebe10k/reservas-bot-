const http = require('http');
const { handleWhatsAppMessage } = require('./whatsapp');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
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
     res.writeHead(403);
     res.end('Forbidden');
   }

 } else if (req.method === 'POST' && req.url === '/webhook') {
   let body = '';
   req.on('data', chunk => body += chunk);
   req.on('end', async () => {
     try { req.body = JSON.parse(body); } catch(e) { req.body = {}; }
     await handleWhatsAppMessage(req, res);
   });

 } else if (req.method === 'POST' && req.url === '/send-message') {
   let body = '';
   req.on('data', chunk => body += chunk);
   req.on('end', async () => {
     try {
       const { phone, message, restaurantId } = JSON.parse(body);
       const { sendWhatsAppMessage } = require('./whatsapp');
       const { saveMessage } = require('./database');
       await sendWhatsAppMessage(phone, message);
       await saveMessage(restaurantId, phone, null, 'outbound', message);
       res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
       res.end(JSON.stringify({ ok: true }));
     } catch(e) {
       console.error('[send-message error]', e.message);
       res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
       res.end(JSON.stringify({ error: e.message }));
     }
   });

 } else if (req.method === 'POST' && req.url === '/set-manual-mode') {
   let body = '';
   req.on('data', chunk => body += chunk);
   req.on('end', async () => {
     try {
       const { phone, restaurantId, active } = JSON.parse(body);
       const { setManualMode } = require('./database');
       await setManualMode(restaurantId, phone, active);
       res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
       res.end(JSON.stringify({ ok: true }));
     } catch(e) {
       console.error('[set-manual-mode error]', e.message);
       res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
       res.end(JSON.stringify({ error: e.message }));
     }
   });

 } else if (req.method === 'OPTIONS') {
   res.writeHead(200, {
     'Access-Control-Allow-Origin': '*',
     'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
     'Access-Control-Allow-Headers': 'Content-Type'
   });
   res.end();

 } else if (req.method === 'GET' && req.url === '/') {
   res.writeHead(200);
   res.end('Bot de reservas funcionando ✅');

 } else {
   res.writeHead(200);
   res.end('OK');
 }
});

server.listen(PORT, () => {
 console.log(`Servidor iniciado en puerto ${PORT} ✅`);
});
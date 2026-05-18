const http = require('http');
const { handleWhatsAppMessage } = require('./whatsapp');
require('dotenv').config();
// require('./reviews') // Desactivado temporalmente;

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
      try {
        req.body = JSON.parse(body);
      } catch(e) {
        req.body = {};
      }
      await handleWhatsAppMessage(req, res);
    });
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

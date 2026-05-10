const http = require('http');
const url = require('url');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;

  if (req.method === 'GET' && path === '/webhook') {
    const mode = parsedUrl.query['hub.mode'];
    const token = parsedUrl.query['hub.verify_token'];
    const challenge = parsedUrl.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.writeHead(200);
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end('Forbidden');
    }
  } else if (req.method === 'GET' && path === '/') {
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
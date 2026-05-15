const http = require('http');
const { handleWhatsAppMessage } = require('./whatsapp');
require('dotenv').config();
require('./reviews');

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      req.body = Object.fromEntries(new URLSearchParams(body));
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
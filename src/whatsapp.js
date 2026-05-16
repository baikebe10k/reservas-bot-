const axios = require('axios');
const { processMessage } = require('./ai');
require('dotenv').config();

async function handleWhatsAppMessage(req, res) {
  try {
    const from = req.body.From?.replace('whatsapp:', '');
    const text = req.body.Body;

    console.log('Mensaje recibido:', from, text);

    if (!from || !text) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    console.log('Llamando a processMessage...');
    const reply = await processMessage(from, text, 'twilio');
    console.log('Respuesta de Claude:', reply);

    const twiml = reply
      ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`
      : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);

  } catch (err) {
    console.error('Error whatsapp:', err.message);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Error: ${err.message}</Message></Response>`);
  }
}

module.exports = { handleWhatsAppMessage };
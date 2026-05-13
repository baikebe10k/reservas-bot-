const { processMessage } = require('./ai');
require('dotenv').config();

async function handleWhatsAppMessage(req, res) {
  try {
    const from = req.body.From?.replace('whatsapp:', '');
    const text = req.body.Body;

    if (!from || !text) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    const reply = await Promise.race([
      processMessage(from, text, 'twilio'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 9000))
    ]);

    const twiml = reply
      ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`
      : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);

  } catch (err) {
    console.error('Error:', err.message);
    const msg = err.message === 'timeout' ? 'Lo siento, tardé demasiado. Por favor inténtalo de nuevo.' : err.message;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
  }
}

module.exports = { handleWhatsAppMessage };
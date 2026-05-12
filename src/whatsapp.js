const axios = require('axios');
const { processMessage } = require('./ai');
require('dotenv').config();

async function handleWhatsAppMessage(req, res) {
  try {
    const from = req.body.From?.replace('whatsapp:', '');
    const text = req.body.Body;

    if (!from || !text) {
      res.writeHead(200);
      res.end();
      return;
    }

    const reply = await processMessage(from, text, 'twilio');

    // Responder con TwiML (formato que espera Twilio)
    const twiml = reply
      ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`
      : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);

  } catch (err) {
    console.error('Error:', err);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }
}

async function sendMessage(to, text) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    new URLSearchParams({ From: 'whatsapp:+14155238886', To: `whatsapp:${to}`, Body: text }),
    { auth: { username: accountSid, password: authToken } }
  );
}

module.exports = { handleWhatsAppMessage, sendMessage };
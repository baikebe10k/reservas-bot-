const axios = require('axios');
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

    // Responder a Twilio inmediatamente
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    // Procesar y enviar respuesta por separado
    const reply = await processMessage(from, text, 'twilio');
    console.log('reply:', reply);
    if (reply) await sendMessage(from, reply);

  } catch (err) {
    console.error('Error completo:', err.message, err.stack);
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
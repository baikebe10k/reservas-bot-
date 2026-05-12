const axios = require('axios');
const { processMessage } = require('./ai');
require('dotenv').config();

function verifyWebhook(req, res) {
  res.sendStatus(200);
}

async function handleWhatsAppMessage(req, res) {
  res.sendStatus(200);

  try {
    const from = req.body.From?.replace('whatsapp:', '');
    const text = req.body.Body;

    if (!from || !text) return;

    const reply = await processMessage(from, text, 'twilio');
    if (reply) await sendMessage(from, reply);

  } catch (err) {
    console.error('Error:', err);
  }
}

async function sendMessage(to, text) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    new URLSearchParams({
      From: 'whatsapp:+14155238886',
      To: `whatsapp:${to}`,
      Body: text
    }),
    { auth: { username: accountSid, password: authToken } }
  );
}

module.exports = { verifyWebhook, handleWhatsAppMessage, sendMessage };
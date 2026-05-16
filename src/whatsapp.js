const { processMessage } = require('./ai');

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

   console.log('Llamando processMessage...');
   const reply = await processMessage(from, text, 'twilio');
   console.log('Reply:', reply);

   const clean = (reply || '')
     .replace(/\*\*/g, '')
     .replace(/\*/g, '')
     .replace(/#{1,6} /g, '')
     .replace(/&/g, 'y')
     .replace(/</g, '')
     .replace(/>/g, '');

   const twiml = clean
     ? '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + clean + '</Message></Response>'
     : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

   res.writeHead(200, { 'Content-Type': 'text/xml' });
   res.end(twiml);

 } catch (err) {
   console.error('Error completo:', err.stack || err.message);
   res.writeHead(200, { 'Content-Type': 'text/xml' });
   res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Hubo un error, por favor intenta de nuevo.</Message></Response>');
 }
}

module.exports = { handleWhatsAppMessage };
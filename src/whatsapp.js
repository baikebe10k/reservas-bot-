const { processMessage } = require('./ai');
const { saveMessage, getRestaurantByPhone } = require('./database');

const processedMessages = new Set();

function normalizePhone(phone) {
 let clean = phone.replace(/\D/g, '');
 if (!clean.startsWith('34') && clean.length === 9) {
   clean = '34' + clean;
 }
 return '+' + clean;
}

async function sendWhatsAppMessage(phone, message) {
 const clean = (message || '')
   .replace(/\*\*/g, '')
   .replace(/\*/g, '')
   .replace(/#{1,6} /g, '')
   .replace(/&/g, 'y')
   .replace(/</g, '')
   .replace(/>/g, '');

 const response = await fetch(`https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`, {
   method: 'POST',
   headers: {
     'Authorization': `Bearer ${process.env.META_TOKEN}`,
     'Content-Type': 'application/json'
   },
   body: JSON.stringify({
     messaging_product: 'whatsapp',
     to: phone,
     type: 'text',
     text: { body: clean }
   })
 });

 if (!response.ok) {
   const err = await response.text();
   throw new Error(`Meta API error: ${err}`);
 }

 return response.json();
}

async function handleWhatsAppMessage(req, res) {
 try {
   res.writeHead(200);
   res.end('OK');

   const entry = req.body?.entry?.[0];
   const change = entry?.changes?.[0];
   const message = change?.value?.messages?.[0];
   const metadata = change?.value?.metadata;

   if (!message) return;

   // Gestionar audios, imágenes y otros tipos
   if (message.type !== 'text') {
     const responses = {
       audio: 'No puedo escuchar mensajes de voz 😊 Por favor escríbeme tu consulta y te respondo enseguida.',
       image: 'No puedo ver imágenes 😊 Por favor escríbeme tu consulta y te respondo enseguida.',
       video: 'No puedo ver vídeos 😊 Por favor escríbeme tu consulta y te respondo enseguida.',
       document: 'No puedo abrir documentos 😊 Por favor escríbeme tu consulta y te respondo enseguida.',
       sticker: null, // ignorar stickers silenciosamente
     };

     const reply = responses[message.type];
     if (!reply) return;

     const from = normalizePhone(message.from);
     const displayPhoneNumber = normalizePhone(metadata?.display_phone_number || '');
     const restaurant = await getRestaurantByPhone(displayPhoneNumber);
     if (!restaurant) return;

     await fetch(`https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`, {
       method: 'POST',
       headers: {
         'Authorization': `Bearer ${process.env.META_TOKEN}`,
         'Content-Type': 'application/json'
       },
       body: JSON.stringify({
         messaging_product: 'whatsapp',
         to: from,
         type: 'text',
         text: { body: reply }
       })
     });
     return;
   }

   // Deduplicar mensajes
   const messageId = message.id;
   if (processedMessages.has(messageId)) {
     console.log('Mensaje duplicado ignorado:', messageId);
     return;
   }
   processedMessages.add(messageId);
   if (processedMessages.size > 1000) processedMessages.clear();

   const from = normalizePhone(message.from);
   const text = message.text.body;

   console.log(`[${new Date().toISOString()}] Mensaje recibido de ${from}: ${text}`);

   const displayPhoneNumber = normalizePhone(metadata?.display_phone_number || '');
   const restaurant = await getRestaurantByPhone(displayPhoneNumber);

   if (!restaurant) {
     console.error(`[ERROR] No se encontró restaurante para el número ${displayPhoneNumber}`);
     return;
   }

   const restaurantId = restaurant.id;
   console.log(`[${new Date().toISOString()}] Restaurante: ${restaurant.name} (${restaurantId})`);

   await saveMessage(restaurantId, from, null, 'inbound', text);

   // Si está en modo manual el bot no responde
   const { getManualMode } = require('./database');
   const isManual = await getManualMode(restaurantId, from);
   if (isManual) {
     console.log(`[Manual mode] Bot silenciado para ${from}`);
     return;
   }

   const reply = await processMessage(from, text, 'meta', restaurantId);

   const clean = (reply || '')
     .replace(/\*\*/g, '')
     .replace(/\*/g, '')
     .replace(/#{1,6} /g, '')
     .replace(/&/g, 'y')
     .replace(/</g, '')
     .replace(/>/g, '');

   if (!clean) return;

   await saveMessage(restaurantId, from, null, 'outbound', clean);

   await fetch(`https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`, {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${process.env.META_TOKEN}`,
       'Content-Type': 'application/json'
     },
     body: JSON.stringify({
       messaging_product: 'whatsapp',
       to: from,
       type: 'text',
       text: { body: clean }
     })
   });

   console.log(`[${new Date().toISOString()}] Respuesta enviada a ${from}`);

 } catch (err) {
   console.error(`[${new Date().toISOString()}] Error Meta webhook:`, err.stack || err.message);
 }
}

module.exports = { handleWhatsAppMessage, sendWhatsAppMessage };
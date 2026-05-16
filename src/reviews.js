console.log('Reviews cron iniciado');
const twilio = require('twilio');
const { supabase } = require('./database');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const GOOGLE_REVIEW_LINK = 'https://g.page/r/XXXXXXXX/review';
const TWILIO_FROM = 'whatsapp:+14155238886';

async function sendReviewRequests() {
  console.log('Ejecutando cron de resenas...');
  const now = new Date();
  
  const { data: reservations, error } = await supabase
    .from('reservations')
    .select('*')
    .eq('status', 'confirmed')
    .eq('review_sent', false);

  if (error) { console.log('Error Supabase:', error); return; }
  if (!reservations || reservations.length === 0) { console.log('No hay reservas pendientes de resena'); return; }

  console.log('Reservas a procesar:', reservations.length);

  for (const res of reservations) {
    const reservationTime = new Date(res.date + 'T' + res.time + ':00');
    const minutesSince = (now - reservationTime) / 1000 / 60;

    console.log('Minutos desde reserva:', minutesSince, 'para', res.customer_name);

    const sendAfterMinutes = 2;

    if (minutesSince >= sendAfterMinutes) {
      const message = 'Hola ' + res.customer_name + '! Esperamos que hayas disfrutado tu visita. Nos ayudaria mucho si nos dejas una resena en Google, solo tarda 1 minuto: ' + GOOGLE_REVIEW_LINK + ' Muchas gracias!';
      
      try {
        await client.messages.create({
          from: TWILIO_FROM,
          to: 'whatsapp:+' + res.customer_phone,
          body: message
        });
        
        await supabase
          .from('reservations')
          .update({ review_sent: true })
          .eq('id', res.id);
          
        console.log('Resena enviada a:', res.customer_name);
      } catch (err) {
        console.log('Error enviando a', res.customer_name, ':', err.message);
      }
    }
  }
}

setInterval(sendReviewRequests, 60 * 1000);
sendReviewRequests();

module.exports = { sendReviewRequests };
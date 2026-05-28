const { getSupabase } = require('./database');
const { sendWhatsAppMessage } = require('./whatsapp');

async function sendReminders() {
  try {
    const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
    const madridNow = new Date(now);
    const pad = n => String(n).padStart(2, '0');

    // Solo reservas de mañana
    const tomorrow = new Date(madridNow);
    tomorrow.setDate(madridNow.getDate() + 1);
    const tomorrowISO = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}`;

    console.log(`[Reminders] Buscando reservas para mañana: ${tomorrowISO}`);

    const { data: reservations } = await getSupabase()
      .from('reservations')
      .select('*, restaurants(name)')
      .eq('date', tomorrowISO)
      .eq('status', 'confirmed')
      .eq('reminder_sent', false);

    if (!reservations || reservations.length === 0) {
      console.log('[Reminders] No hay reservas para mañana sin recordatorio');
      return;
    }

    console.log(`[Reminders] ${reservations.length} recordatorios a enviar`);

    for (const reservation of reservations) {
      try {
        // Enviar solo si faltan 2h o menos para la reserva de mañana
        const reservationDateTime = new Date(`${tomorrowISO}T${reservation.time}:00`);
        const hoursUntil = (reservationDateTime - madridNow) / (1000 * 60 * 60);

        if (hoursUntil > 26 || hoursUntil < 1) {
          console.log(`[Reminders] Reserva ${reservation.id} — ${hoursUntil.toFixed(1)}h — saltando`);
          continue;
        }

        const restaurantName = reservation.restaurants?.name || 'el restaurante';
        const day = tomorrow.getDate();
        const month = tomorrow.toLocaleDateString('es-ES', { month: 'long' });
        const dayOfWeek = new Date(tomorrowISO + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long' });

        const messages = {
          es: `Hola ${reservation.customer_name} 😊\n\nTe recordamos tu reserva en ${restaurantName}:\n\n📅 Mañana ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} persona${reservation.guests > 1 ? 's' : ''}\n\nSi necesitas cancelar o modificar algo, responde a este mensaje. ¡Te esperamos!`,
          ca: `Hola ${reservation.customer_name} 😊\n\nEt recordem la teva reserva a ${restaurantName}:\n\n📅 Demà ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} persona${reservation.guests > 1 ? 'es' : ''}\n\nSi necessites cancel·lar o modificar alguna cosa, respon a aquest missatge. T'esperem!`,
          en: `Hi ${reservation.customer_name} 😊\n\nThis is a reminder of your reservation at ${restaurantName}:\n\n📅 Tomorrow ${dayOfWeek} ${day} of ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} person${reservation.guests > 1 ? 's' : ''}\n\nIf you need to cancel or change anything, reply to this message. See you soon!`,
          fr: `Bonjour ${reservation.customer_name} 😊\n\nNous vous rappelons votre réservation au ${restaurantName}:\n\n📅 Demain ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} personne${reservation.guests > 1 ? 's' : ''}\n\nSi vous avez besoin d'annuler ou de modifier, répondez à ce message. À demain!`,
          de: `Hallo ${reservation.customer_name} 😊\n\nWir erinnern Sie an Ihre Reservierung bei ${restaurantName}:\n\n📅 Morgen ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} Person${reservation.guests > 1 ? 'en' : ''}\n\nFalls Sie etwas ändern möchten, antworten Sie auf diese Nachricht. Wir freuen uns auf Sie!`
        };

        const lang = reservation.language || 'es';
        const message = messages[lang] || messages['es'];

        await sendWhatsAppMessage(reservation.customer_phone, message);

        await getSupabase()
          .from('reservations')
          .update({ reminder_sent: true })
          .eq('id', reservation.id);

        console.log(`[Reminders] Enviado a ${reservation.customer_phone} en ${lang}`);
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch(e) {
        console.error(`[Reminders] Error enviando a ${reservation.customer_phone}:`, e.message);
      }
    }

    console.log('[Reminders] Proceso completado');

  } catch(e) {
    console.error('[Reminders] Error general:', e.message);
  }
}

// Ejecutar cada 30 minutos para no perder la ventana de 2h
setInterval(sendReminders, 30 * 60 * 1000);
sendReminders();

module.exports = { sendReminders };
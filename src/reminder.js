const { getSupabase } = require('./database');
const { sendWhatsAppMessage } = require('./whatsapp');

function buildMessage(reservation, restaurantName, whenEs, whenCa, whenEn, whenFr, whenDe, day, month, dayOfWeek) {
  const messages = {
    es: `Hola ${reservation.customer_name} 😊\n\nTe recordamos tu reserva en ${restaurantName}:\n\n📅 ${whenEs} ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} persona${reservation.guests > 1 ? 's' : ''}\n\nSi necesitas cancelar o modificar algo, responde a este mensaje. ¡Te esperamos!`,
    ca: `Hola ${reservation.customer_name} 😊\n\nEt recordem la teva reserva a ${restaurantName}:\n\n📅 ${whenCa} ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} persona${reservation.guests > 1 ? 'es' : ''}\n\nSi necessites cancel·lar o modificar alguna cosa, respon a aquest missatge. T'esperem!`,
    en: `Hi ${reservation.customer_name} 😊\n\nThis is a reminder of your reservation at ${restaurantName}:\n\n📅 ${whenEn} ${dayOfWeek} ${day} of ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} person${reservation.guests > 1 ? 's' : ''}\n\nIf you need to cancel or change anything, reply to this message. See you soon!`,
    fr: `Bonjour ${reservation.customer_name} 😊\n\nNous vous rappelons votre réservation au ${restaurantName}:\n\n📅 ${whenFr} ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} personne${reservation.guests > 1 ? 's' : ''}\n\nSi vous avez besoin d'annuler ou de modifier, répondez à ce message. À bientôt!`,
    de: `Hallo ${reservation.customer_name} 😊\n\nWir erinnern Sie an Ihre Reservierung bei ${restaurantName}:\n\n📅 ${whenDe} ${dayOfWeek} ${day} de ${month}\n🕘 ${reservation.time}\n👥 ${reservation.guests} Person${reservation.guests > 1 ? 'en' : ''}\n\nFalls Sie etwas ändern möchten, antworten Sie auf diese Nachricht. Wir freuen uns auf Sie!`
  };
  const lang = reservation.language || 'es';
  return messages[lang] || messages['es'];
}

async function sendReminders() {
  try {
    const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
    const madridNow = new Date(now);
    const pad = n => String(n).padStart(2, '0');
    const todayISO = `${madridNow.getFullYear()}-${pad(madridNow.getMonth()+1)}-${pad(madridNow.getDate())}`;

    console.log(`[Reminders] Ejecutando... ${madridNow.toISOString()}`);

    // Buscar todas las reservas futuras sin recordatorio (excepto hoy)
    const { data: reservations } = await getSupabase()
      .from('reservations')
      .select('*, restaurants(name)')
      .gt('date', todayISO)
      .eq('status', 'confirmed')
      .eq('reminder_sent', false);

    if (!reservations || reservations.length === 0) {
      console.log('[Reminders] No hay reservas pendientes de recordatorio');
      return;
    }

    console.log(`[Reminders] ${reservations.length} reservas a evaluar`);

    for (const reservation of reservations) {
      try {
        const reservationDateTime = new Date(`${reservation.date}T${reservation.time}:00`);
        const hoursUntil = (reservationDateTime - madridNow) / (1000 * 60 * 60);

        const isTomorrow = hoursUntil <= 24;
        const triggerHours = isTomorrow ? 2 : 4;

        // Enviar si faltan entre 0 y triggerHours horas
        if (hoursUntil > triggerHours || hoursUntil < 0) {
          continue;
        }

        const restaurantName = reservation.restaurants?.name || 'el restaurante';
        const resDate = new Date(reservation.date + 'T12:00:00');
        const day = resDate.getDate();
        const month = resDate.toLocaleDateString('es-ES', { month: 'long' });
        const dayOfWeek = resDate.toLocaleDateString('es-ES', { weekday: 'long' });

        const whenEs = isTomorrow ? 'Mañana' : `El ${dayOfWeek}`;
        const whenCa = isTomorrow ? 'Demà' : `El ${dayOfWeek}`;
        const whenEn = isTomorrow ? 'Tomorrow' : `On ${dayOfWeek}`;
        const whenFr = isTomorrow ? 'Demain' : `Le ${dayOfWeek}`;
        const whenDe = isTomorrow ? 'Morgen' : `Am ${dayOfWeek}`;

        const message = buildMessage(reservation, restaurantName, whenEs, whenCa, whenEn, whenFr, whenDe, day, month, dayOfWeek);

        await sendWhatsAppMessage(reservation.customer_phone, message);

        await getSupabase()
          .from('reservations')
          .update({ reminder_sent: true })
          .eq('id', reservation.id);

        console.log(`[Reminders] ✅ Enviado a ${reservation.customer_phone} — ${hoursUntil.toFixed(1)}h hasta reserva`);
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

// Ejecutar cada 30 minutos
setInterval(sendReminders, 30 * 60 * 1000);
sendReminders();

module.exports = { sendReminders };
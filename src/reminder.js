const { getSupabase } = require('./database');
const { sendWhatsAppMessage } = require('./whatsapp');

async function sendReminders() {
  try {
    const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
    const madridNow = new Date(now);
    const pad = n => String(n).padStart(2, '0');
    const todayISO = `${madridNow.getFullYear()}-${pad(madridNow.getMonth()+1)}-${pad(madridNow.getDate())}`;
    
    // Calcular fecha de mañana
    const tomorrow = new Date(madridNow);
    tomorrow.setDate(madridNow.getDate() + 1);
    const tomorrowISO = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}`;

    console.log(`[Reminders] Buscando reservas para mañana: ${tomorrowISO}`);

    // Buscar reservas de mañana que no tienen recordatorio enviado
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
        // Solo enviar si la reserva es con más de 4h de antelación
        const reservationDateTime = new Date(`${tomorrowISO}T${reservation.time}:00`);
        const hoursUntil = (reservationDateTime - madridNow) / (1000 * 60 * 60);
        
        if (hoursUntil < 4) {
          console.log(`[Reminders] Reserva ${reservation.id} tiene menos de 4h — saltando`);
          continue;
        }

        const restaurantName = reservation.restaurants?.name || 'el restaurante';
        const dayOfWeek = new Date(tomorrowISO + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long' });
        const day = tomorrow.getDate();
        const month = tomorrow.toLocaleDateString('es-ES', { month: 'long' });

        const message = `Hola ${reservation.customer_name} 😊

Te recordamos tu reserva en ${restaurantName}:

📅 Mañana ${dayOfWeek} ${day} de ${month}
🕘 ${reservation.time}
👥 ${reservation.guests} persona${reservation.guests > 1 ? 's' : ''}

Si necesitas cancelar o modificar algo, responde a este mensaje. ¡Te esperamos!`;

        await sendWhatsAppMessage(reservation.customer_phone, message);

        // Marcar como enviado
        await getSupabase()
          .from('reservations')
          .update({ reminder_sent: true })
          .eq('id', reservation.id);

        console.log(`[Reminders] Recordatorio enviado a ${reservation.customer_phone}`);

        // Esperar 1 segundo entre mensajes para no saturar la API
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

// Ejecutar cada hora
setInterval(sendReminders, 60 * 60 * 1000);

// Ejecutar también al iniciar
sendReminders();

module.exports = { sendReminders };
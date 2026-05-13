const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function getAvailability(restaurantId, date, guests) {
  const { data: tables } = await supabase
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .gte('capacity', guests)
    .eq('active', true);

  const { data: existing } = await supabase
    .from('reservations')
    .select('table_id, time')
    .eq('restaurant_id', restaurantId)
    .eq('date', date)
    .neq('status', 'cancelled');

  const hours = ['13:00','13:30','14:00','14:30','21:00','21:30','22:00'];
  const available = [];

  for (const time of hours) {
    const tableAvailable = tables.find(t =>
      !existing.some(e => e.table_id === t.id && e.time === time)
    );
    if (tableAvailable) {
      available.push({ time, tableId: tableAvailable.id, tableLabel: tableAvailable.label });
    }
  }
  return available;
}

async function createReservation(data) {
  const startDateTime = new Date(`${data.date}T${data.time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 90 * 60 * 1000);
  data.end_time = endDateTime.toISOString();

  const { data: res } = await supabase
    .from('reservations')
    .insert([data])
    .select()
    .single();
  return res;
}

async function cancelByPhone(phone, restaurantId) {
  const { data } = await supabase
    .from('reservations')
    .update({ status: 'cancelled' })
    .eq('customer_phone', phone)
    .eq('restaurant_id', restaurantId)
    .eq('status', 'confirmed')
    .select()
    .single();
  return data;
}

module.exports = { supabase, getAvailability, createReservation, cancelByPhone };
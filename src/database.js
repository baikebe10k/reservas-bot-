const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function getRestaurantConfig(restaurantId) {
  const { data } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .maybeSingle();
  return data;
}

function generateSlots(openingTime, closingTime, slotDuration) {
  const slots = [];
  const [openH, openM] = openingTime.split(':').map(Number);
  const [closeH, closeM] = closingTime.split(':').map(Number);
  let current = openH * 60 + openM;
  const end = closeH * 60 + closeM;
  while (current < end) {
    const h = String(Math.floor(current / 60)).padStart(2, '0');
    const m = String(current % 60).padStart(2, '0');
    slots.push(`${h}:${m}`);
    current += slotDuration;
  }
  return slots;
}

async function getAvailability(restaurantId, date, guests) {
  const config = await getRestaurantConfig(restaurantId);
  const opening = config?.opening_time || '13:00';
  const closing = config?.closing_time || '23:00';
  const duration = config?.slot_duration || 30;

  const { data: tables } = await supabase
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .gte('capacity', guests);

  if (!tables || tables.length === 0) return [];

  const slots = generateSlots(opening, closing, duration);
  const available = [];

  for (const slot of slots) {
    const { data: existing } = await supabase
      .from('reservations')
      .select('table_id')
      .eq('restaurant_id', restaurantId)
      .eq('date', date)
      .eq('time', slot)
      .eq('status', 'confirmed');

    const bookedTableIds = (existing || []).map(r => r.table_id);
    const freeTable = tables.find(t => !bookedTableIds.includes(t.id));
    if (freeTable) available.push(slot);
  }
  return available;
}

async function createReservation(restaurantId, data) {
  console.log('createReservation:', restaurantId, data);

  const { data: tables } = await supabase
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .gte('capacity', data.guests);

  if (!tables || tables.length === 0) return { error: 'No hay mesas' };

  const { data: existing } = await supabase
    .from('reservations')
    .select('table_id')
    .eq('restaurant_id', restaurantId)
    .eq('date', data.date)
    .eq('time', data.time)
    .eq('status', 'confirmed');

  const bookedTableIds = (existing || []).map(r => r.table_id);
  const freeTable = tables.find(t => !bookedTableIds.includes(t.id));

  if (!freeTable) return { error: 'No hay mesa disponible' };

  const config = await getRestaurantConfig(restaurantId);
  const duration = config?.slot_duration || 90;

  const startDateTime = new Date(data.date + 'T' + data.time + ':00');
  const endDateTime = new Date(startDateTime.getTime() + duration * 60 * 1000);

  const insertData = {
    restaurant_id: restaurantId,
    table_id: freeTable.id,
    customer_phone: data.customer_phone,
    customer_name: data.customer_name,
    date: data.date,
    time: data.time,
    end_time: endDateTime.toISOString(),
    guests: data.guests,
    status: 'confirmed'
  };

  console.log('Insertando:', insertData);

  const { data: res, error } = await supabase
    .from('reservations')
    .insert([insertData])
    .select();

  if (error) {
    console.log('Error Supabase:', error);
    return { error: error.message };
  }

  console.log('Guardado:', res);
  return res;
}

async function cancelByPhone(phone) {
  const { data } = await supabase
    .from('reservations')
    .update({ status: 'cancelled' })
    .eq('customer_phone', phone)
    .eq('status', 'confirmed')
    .select()
    .maybeSingle();
  return data;
}

module.exports = { supabase, getRestaurantConfig, getAvailability, createReservation, cancelByPhone };
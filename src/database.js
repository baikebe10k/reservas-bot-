const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
}

async function getRestaurantByPhone(whatsappNumber) {
  const { data } = await getSupabase()
    .from('restaurants')
    .select('*')
    .eq('whatsapp_number', whatsappNumber)
    .maybeSingle();
  return data;
}

async function getRestaurantConfig(restaurantId) {
  const { data } = await getSupabase()
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .maybeSingle();
  return data;
}

const WEEKDAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function isRestaurantOpenOnDate(config, dateISO) {
  const openDays = config?.open_days;
  if (!openDays || openDays.length === 0) return true;
  const dayOfWeek = new Date(dateISO + 'T12:00:00').getDay();
  const dayName = WEEKDAY_NAMES[dayOfWeek];
  return openDays.includes(dayName);
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

function generateSlotsFromShifts(shifts, slotDuration) {
  const slots = [];
  for (const shift of shifts) {
    const shiftSlots = generateSlots(shift.start, shift.end, slotDuration);
    shiftSlots.forEach(s => { if (!slots.includes(s)) slots.push(s); });
  }
  return slots.sort();
}

async function getAvailability(restaurantId, date, guests) {
  const config = await getRestaurantConfig(restaurantId);

  if (!isRestaurantOpenOnDate(config, date)) {
    return { closed: true, message: 'El restaurante no abre ese día' };
  }

  const opening = config?.opening_time || '13:00';
  const closing = config?.closing_time || '23:00';
  const duration = config?.slot_duration || 30;
  const shifts = config?.shifts || [];

  const slots = shifts.length > 0
    ? generateSlotsFromShifts(shifts, duration)
    : generateSlots(opening, closing, duration);

  const { data: tables } = await getSupabase()
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .gte('capacity', guests)
    .or('manual_status.is.null,manual_status.eq.available');

  if (!tables || tables.length === 0) return [];

  const available = [];

  for (const slot of slots) {
    const { data: existing } = await getSupabase()
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

  const { data: tables } = await getSupabase()
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .gte('capacity', data.guests);

  if (!tables || tables.length === 0) return { error: 'No hay mesas' };

  const { data: existing } = await getSupabase()
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

  const { data: res, error } = await getSupabase()
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

function normalize(str) {
  return (str || '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function findReservationByName(restaurantId, name) {
  const { data } = await getSupabase()
    .from('reservations')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'confirmed')
    .order('date', { ascending: true });

  if (!data) return [];

  const searchNorm = normalize(name);
  const searchWords = searchNorm.split(/\s+/).filter(Boolean);

  return data.filter(r => {
    const nameNorm = normalize(r.customer_name);
    return searchWords.every(word => nameNorm.includes(word));
  });
}

async function cancelById(id) {
  const { data } = await getSupabase()
    .from('reservations')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .select()
    .maybeSingle();
  return data;
}

async function cancelByPhone(phone) {
  const { data } = await getSupabase()
    .from('reservations')
    .update({ status: 'cancelled' })
    .eq('customer_phone', phone)
    .eq('status', 'confirmed')
    .select()
    .maybeSingle();
  return data;
}

async function saveMessage(restaurantId, customerPhone, customerName, direction, message) {
  try {
    await getSupabase()
      .from('conversations')
      .insert([{
        restaurant_id: restaurantId,
        customer_phone: customerPhone,
        customer_name: customerName || null,
        direction,
        message
      }]);
  } catch (e) {
    console.error('[saveMessage error]', e.message);
  }
}

async function getConversations(restaurantId) {
  const { data } = await getSupabase()
    .from('conversations')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false });
  return data || [];
}

async function getManualMode(restaurantId, phone) {
  try {
    const { data } = await getSupabase()
      .from('manual_mode')
      .select('active')
      .eq('restaurant_id', restaurantId)
      .eq('phone', phone)
      .maybeSingle();
    return data?.active || false;
  } catch(e) {
    return false;
  }
}

async function setManualMode(restaurantId, phone, active) {
  await getSupabase()
    .from('manual_mode')
    .upsert([{ restaurant_id: restaurantId, phone, active }], { onConflict: 'restaurant_id,phone' });
}

module.exports = {
  getSupabase,
  getRestaurantConfig,
  getRestaurantByPhone,
  getAvailability,
  createReservation,
  cancelByPhone,
  findReservationByName,
  cancelById,
  saveMessage,
  getConversations,
  getManualMode,
  setManualMode
};
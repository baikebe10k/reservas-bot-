const { createClient } = require('@supabase/supabase-js');

const configCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

async function getRestaurantByPhone(whatsappNumber) {
  const { data } = await getSupabase().from('restaurants').select('*').eq('whatsapp_number', whatsappNumber).maybeSingle();
  return data;
}

async function getRestaurantConfig(restaurantId) {
  const cached = configCache.get(restaurantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  const { data } = await getSupabase().from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
  configCache.set(restaurantId, { data, ts: Date.now() });
  return data;
}

function getAdvancedConfig(config) {
  try { return JSON.parse(config?.advanced_config || '{}'); } catch { return {}; }
}

const WEEKDAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function isRestaurantOpenOnDate(config, dateISO) {
  const openDays = config?.open_days;
  if (!openDays || openDays.length === 0) return true;
  const dayOfWeek = new Date(dateISO + 'T12:00:00').getDay();
  return openDays.includes(WEEKDAY_NAMES[dayOfWeek]);
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
    generateSlots(shift.start, shift.end, slotDuration).forEach(s => { if (!slots.includes(s)) slots.push(s); });
  }
  return slots.sort();
}

// Calcula capacidad máxima de una mesa según config avanzada
function getMaxCapacity(table, advConfig) {
  if (!advConfig.flexEnabled) return table.capacity;
  const key = 'flex_cap_' + table.capacity;
  const isOn = advConfig[key + '_on'] === true;
  if (!isOn) return table.capacity;
  return advConfig[key] || table.capacity + 1;
}

async function getAvailability(restaurantId, date, guests) {
  const config = await getRestaurantConfig(restaurantId);
  const advConfig = getAdvancedConfig(config);

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

  const { data: allTables } = await getSupabase()
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .or('manual_status.is.null,manual_status.eq.available');

  if (!allTables || allTables.length === 0) return [];

  const { data: existingReservations } = await getSupabase()
    .from('reservations')
    .select('table_id, time')
    .eq('restaurant_id', restaurantId)
    .eq('date', date)
    .in('status', ['confirmed', 'pending']);

  const bookedMap = {};
  (existingReservations || []).forEach(r => {
    if (!bookedMap[r.time]) bookedMap[r.time] = new Set();
    bookedMap[r.time].add(r.table_id);
  });

  const available = [];
  for (const slot of slots) {
    const bookedIds = bookedMap[slot] || new Set();
    const freeTables = allTables.filter(t => !bookedIds.has(t.id));

    // 1. Mesa individual con capacidad suficiente (incluyendo flex)
    const singleTable = freeTables.find(t => getMaxCapacity(t, advConfig) >= guests);
    if (singleTable) { available.push(slot); continue; }

    // 2. Combinación de mesas si autoCombine está activado
    if (advConfig.autoCombine) {
      // Ordenar mesas libres: primero las más grandes
      const sorted = [...freeTables].sort((a, b) => b.capacity - a.capacity);
      let totalCap = 0;
      for (const t of sorted) {
        totalCap += getMaxCapacity(t, advConfig);
        if (totalCap >= guests) { available.push(slot); break; }
      }
    }
  }

  return available;
}

async function createReservation(restaurantId, data) {
  console.log('createReservation:', restaurantId, data);

  const config = await getRestaurantConfig(restaurantId);
  const advConfig = getAdvancedConfig(config);
  const groupMin = advConfig.groupMin || 8;
  const isGroup = data.guests >= groupMin;
  const autoConfirm = advConfig.autoConfirmGroups !== false;
  const status = (isGroup && !autoConfirm) ? 'pending' : 'confirmed';

  const { data: allTables } = await getSupabase()
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .or('manual_status.is.null,manual_status.eq.available');

  if (!allTables || allTables.length === 0) return { error: 'No hay mesas' };

  const { data: existing } = await getSupabase()
    .from('reservations')
    .select('table_id')
    .eq('restaurant_id', restaurantId)
    .eq('date', data.date)
    .eq('time', data.time)
    .in('status', ['confirmed', 'pending']);

  const bookedIds = (existing || []).map(r => r.table_id);
  const freeTables = allTables.filter(t => !bookedIds.includes(t.id));

  // 1. Mesa individual con capacidad suficiente
  const freeTable = freeTables.find(t => getMaxCapacity(t, advConfig) >= data.guests);

  if (freeTable) {
    return await insertReservation(restaurantId, freeTable.id, data, config, status);
  }

  // 2. Combinar mesas si autoCombine activado
  if (advConfig.autoCombine) {
    const sorted = [...freeTables].sort((a, b) => b.capacity - a.capacity);
    let totalCap = 0;
    const combinedTables = [];
    for (const t of sorted) {
      totalCap += getMaxCapacity(t, advConfig);
      combinedTables.push(t);
      if (totalCap >= data.guests) break;
    }
    if (totalCap >= data.guests) {
      // Reservar la primera mesa como principal
      const result = await insertReservation(restaurantId, combinedTables[0].id, data, config, status, combinedTables.map(t => t.id));
      return result;
    }
  }

  return { error: 'No hay mesa disponible' };
}

async function insertReservation(restaurantId, tableId, data, config, status, combinedTableIds) {
  const duration = config?.slot_duration || 90;
  const startDateTime = new Date(data.date + 'T' + data.time + ':00');
  const endDateTime = new Date(startDateTime.getTime() + duration * 60 * 1000);

  const insertData = {
    restaurant_id: restaurantId,
    table_id: tableId,
    customer_phone: data.customer_phone,
    customer_name: data.customer_name,
    date: data.date,
    time: data.time,
    end_time: endDateTime.toISOString(),
    guests: data.guests,
    status: status,
    language: data.language || 'es',
    notes: combinedTableIds ? `Mesas combinadas: ${combinedTableIds.join(', ')}` : (data.notes || null)
  };

  const { data: res, error } = await getSupabase().from('reservations').insert([insertData]).select();
  if (error) { console.log('Error Supabase:', error); return { error: error.message }; }
  return res;
}

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

async function findReservationByName(restaurantId, name) {
  const { data } = await getSupabase().from('reservations').select('*').eq('restaurant_id', restaurantId).eq('status', 'confirmed').order('date', { ascending: true });
  if (!data) return [];
  const searchNorm = normalize(name);
  const searchWords = searchNorm.split(/\s+/).filter(Boolean);
  return data.filter(r => {
    const nameNorm = normalize(r.customer_name);
    return searchWords.every(word => nameNorm.includes(word));
  });
}

async function cancelById(id) {
  const { data } = await getSupabase().from('reservations').update({ status: 'cancelled' }).eq('id', id).select().maybeSingle();
  return data;
}

async function cancelByPhone(phone) {
  const { data } = await getSupabase().from('reservations').update({ status: 'cancelled' }).eq('customer_phone', phone).eq('status', 'confirmed').select().maybeSingle();
  return data;
}

async function saveMessage(restaurantId, customerPhone, customerName, direction, message) {
  try {
    await getSupabase().from('conversations').insert([{ restaurant_id: restaurantId, customer_phone: customerPhone, customer_name: customerName || null, direction, message }]);
  } catch (e) { console.error('[saveMessage error]', e.message); }
}

async function getConversations(restaurantId) {
  const { data } = await getSupabase().from('conversations').select('*').eq('restaurant_id', restaurantId).order('created_at', { ascending: false });
  return data || [];
}

async function getManualMode(restaurantId, phone) {
  try {
    const { data } = await getSupabase().from('manual_mode').select('active').eq('restaurant_id', restaurantId).eq('phone', phone).maybeSingle();
    return data?.active || false;
  } catch(e) { return false; }
}

async function setManualMode(restaurantId, phone, active) {
  await getSupabase().from('manual_mode').upsert([{ restaurant_id: restaurantId, phone, active }], { onConflict: 'restaurant_id,phone' });
}

async function saveConversationHistory(restaurantId, phone, messages, language) {
  try {
    await getSupabase().from('conversation_history').upsert([{ restaurant_id: restaurantId, customer_phone: phone, messages: messages, language: language || 'es', updated_at: new Date().toISOString() }], { onConflict: 'restaurant_id,customer_phone' });
  } catch(e) { console.error('[saveConversationHistory error]', e.message); }
}

async function loadConversationHistory(restaurantId, phone) {
  try {
    const { data } = await getSupabase().from('conversation_history').select('messages, language').eq('restaurant_id', restaurantId).eq('customer_phone', phone).maybeSingle();
    return data || { messages: [], language: 'es' };
  } catch(e) { return { messages: [], language: 'es' }; }
}

module.exports = {
  getSupabase,
  getAdvancedConfig,
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
  setManualMode,
  saveConversationHistory,
  loadConversationHistory
};
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

function filterSlotsBeforeClose(slots, closingTime) {
  const [closeH, closeM] = closingTime.split(':').map(Number);
  const closeMinutes = closeH * 60 + closeM;
  return slots.filter(slot => {
    const [slotH, slotM] = slot.split(':').map(Number);
    return (slotH * 60 + slotM) <= (closeMinutes - 60);
  });
}

function getMaxCapacity(table, advConfig) {
  if (!advConfig.flexEnabled) return table.capacity;
  const key = 'flex_cap_' + table.capacity;
  const isOn = advConfig[key + '_on'] === true;
  if (!isOn) return table.capacity;
  return advConfig[key] || table.capacity + 1;
}

function isToday(dateISO) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
  const madridNow = new Date(now);
  const pad = n => String(n).padStart(2, '0');
  const todayISO = `${madridNow.getFullYear()}-${pad(madridNow.getMonth()+1)}-${pad(madridNow.getDate())}`;
  return dateISO === todayISO;
}

// Actualiza el status operativo de una mesa en tiempo real
async function updateTableStatus(tableId, status) {
  await getSupabase()
    .from('tables')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', tableId);
}

// Devuelve si una mesa está disponible para reservas (considera status operativo)
function isTableAvailableForReservation(table) {
  // Si tiene status operativo bloqueante, no está disponible
  if (table.status === 'occupied') return false;
  if (table.status === 'blocked') return false;
  if (table.status === 'cleaning') return false;
  // manual_status legacy también aplica
  if (table.manual_status === 'occupied') return false;
  if (table.manual_status === 'blocked') return false;
  return true;
}

async function getAvailability(restaurantId, date, guests) {
  const config = await getRestaurantConfig(restaurantId);
  const advConfig = getAdvancedConfig(config);

  if (!isRestaurantOpenOnDate(config, date)) {
    return { closed: true, message: 'El restaurante no abre ese día' };
  }

  // Cut-off horario mismo día
  const sameDayCutoff = advConfig.sameDayCutoff;
  if (isToday(date) && sameDayCutoff?.enabled) {
    const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
    const madridNow = new Date(now);
    const currentMinutes = madridNow.getHours() * 60 + madridNow.getMinutes();
    const isGroup = guests >= (advConfig.groupMin || 8);

    if (!sameDayCutoff.groupsOnly && sameDayCutoff.general) {
      const [ch, cm] = sameDayCutoff.general.split(':').map(Number);
      if (currentMinutes > ch * 60 + cm) {
        return { cutoff: true, message: 'No se aceptan más reservas para hoy' };
      }
    }
    if (sameDayCutoff.groupsOnly && isGroup && sameDayCutoff.general) {
      const [ch, cm] = sameDayCutoff.general.split(':').map(Number);
      if (currentMinutes > ch * 60 + cm) {
        return { cutoff: true, message: 'No se aceptan más reservas de grupos para hoy' };
      }
    }
  }

  const opening = config?.opening_time || '13:00';
  const closing = config?.closing_time || '23:00';
  const duration = config?.slot_duration || 30;
  const shifts = config?.shifts || [];

  const rawSlots = shifts.length > 0
    ? generateSlotsFromShifts(shifts, duration)
    : generateSlots(opening, closing, duration);

  const slots = filterSlotsBeforeClose(rawSlots, closing);

  // Para reservas del mismo día: excluir mesas con status operativo bloqueante
  const { data: allTablesRaw } = await getSupabase()
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true);

  if (!allTablesRaw || allTablesRaw.length === 0) return [];

  const allTables = isToday(date)
    ? allTablesRaw.filter(t => isTableAvailableForReservation(t))
    : allTablesRaw.filter(t => t.status !== 'blocked' && t.manual_status !== 'blocked');

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

    const singleTable = freeTables.find(t => getMaxCapacity(t, advConfig) >= guests);
    if (singleTable) { available.push(slot); continue; }

    if (advConfig.autoCombine) {
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
  const autoConfirm = advConfig.autoConfirmGroups === true;
  const status = (isGroup && !autoConfirm) ? 'pending' : 'confirmed';

  console.log('isGroup:', isGroup, 'autoConfirm:', autoConfirm, 'status:', status);

  const closing = config?.closing_time || '23:00';

  // Cut-off horario mismo día
  const sameDayCutoff = advConfig.sameDayCutoff;
  if (isToday(data.date) && sameDayCutoff?.enabled) {
    const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
    const madridNow = new Date(now);
    const currentMinutes = madridNow.getHours() * 60 + madridNow.getMinutes();

    if (!sameDayCutoff.groupsOnly && sameDayCutoff.general) {
      const [ch, cm] = sameDayCutoff.general.split(':').map(Number);
      if (currentMinutes > ch * 60 + cm) {
        return { error: 'No se aceptan más reservas para hoy' };
      }
    }
    if (sameDayCutoff.groupsOnly && isGroup && sameDayCutoff.general) {
      const [ch, cm] = sameDayCutoff.general.split(':').map(Number);
      if (currentMinutes > ch * 60 + cm) {
        return { error: 'No se aceptan reservas de grupos para hoy. Llama al restaurante.' };
      }
    }
  }

  // Obtener mesas disponibles
  const { data: allTablesRaw } = await getSupabase()
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true);

  if (!allTablesRaw || allTablesRaw.length === 0) return { error: 'No hay mesas' };

  const allTables = isToday(data.date)
    ? allTablesRaw.filter(t => isTableAvailableForReservation(t))
    : allTablesRaw.filter(t => t.status !== 'blocked' && t.manual_status !== 'blocked');

  // Verificar hora no está a menos de 1h del cierre
  const [closeH, closeM] = closing.split(':').map(Number);
  const closeMinutes = closeH * 60 + closeM;
  const [reqH, reqM] = data.time.split(':').map(Number);
  const reqMinutes = reqH * 60 + reqM;
  if (reqMinutes > closeMinutes - 60) {
    return { error: 'Hora fuera de servicio. El último turno es a las ' + String(Math.floor((closeMinutes - 60) / 60)).padStart(2,'0') + ':' + String((closeMinutes - 60) % 60).padStart(2,'0') };
  }

  const { data: existing } = await getSupabase()
    .from('reservations')
    .select('table_id')
    .eq('restaurant_id', restaurantId)
    .eq('date', data.date)
    .eq('time', data.time)
    .in('status', ['confirmed', 'pending']);

  const bookedIds = (existing || []).map(r => r.table_id);
  const freeTables = allTables.filter(t => !bookedIds.includes(t.id));

  // 1. Mesa individual
  const freeTable = freeTables.find(t => getMaxCapacity(t, advConfig) >= data.guests);
  if (freeTable) {
    return await insertReservation(restaurantId, freeTable.id, data, config, status, null);
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
      return await insertReservation(restaurantId, combinedTables[0].id, data, config, status, combinedTables.map(t => t.id));
    }
  }

  // 3. Buscar próxima hora disponible
  const opening = config?.opening_time || '13:00';
  const duration = config?.slot_duration || 30;
  const shifts = config?.shifts || [];
  const rawSlots = shifts.length > 0
    ? generateSlotsFromShifts(shifts, duration)
    : generateSlots(opening, closing, duration);
  const allSlots = filterSlotsBeforeClose(rawSlots, closing);

  const requestedIndex = allSlots.indexOf(data.time);
  const nextSlots = requestedIndex >= 0 ? allSlots.slice(requestedIndex + 1) : [];

  for (const slot of nextSlots) {
    const { data: slotExisting } = await getSupabase()
      .from('reservations')
      .select('table_id')
      .eq('restaurant_id', restaurantId)
      .eq('date', data.date)
      .eq('time', slot)
      .in('status', ['confirmed', 'pending']);

    const slotBookedIds = (slotExisting || []).map(r => r.table_id);
    const slotFreeTables = allTables.filter(t => !slotBookedIds.includes(t.id));

    const slotFreeTable = slotFreeTables.find(t => getMaxCapacity(t, advConfig) >= data.guests);
    if (slotFreeTable) return { error: 'no_availability', nextSlot: slot };

    if (advConfig.autoCombine) {
      const sorted = [...slotFreeTables].sort((a, b) => b.capacity - a.capacity);
      let totalCap = 0;
      for (const t of sorted) { totalCap += getMaxCapacity(t, advConfig); }
      if (totalCap >= data.guests) return { error: 'no_availability', nextSlot: slot };
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

  console.log('Insertando:', insertData);

  const { data: res, error } = await getSupabase().from('reservations').insert([insertData]).select();
  if (error) { console.log('Error Supabase:', error); return { error: error.message }; }
  console.log('Guardado:', res);
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
  updateTableStatus,
  saveConversationHistory,
  loadConversationHistory
};
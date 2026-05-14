cat > src/database.js << 'EOF'
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function getAvailability(restaurantId, date, guests) {
  const { data: tables } = await supabase
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .gte('capacity', guests);

  if (!tables || tables.length === 0) return [];

  const slots = ['13:00', '13:30', '14:00', '14:30', '21:00', '21:30', '22:00'];
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
  console.log('createReservation llamado con:', restaurantId, data);

  const { data: tables } = await supabase
    .from('tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .gte('capacity', data.guests);

  if (!tables || tables.length === 0) {
    console.log('No hay mesas disponibles');
    return { error: 'No hay mesas disponibles' };
  }

  const { data: existing } = await supabase
    .from('reservations')
    .select('table_id')
    .eq('restaurant_id', restaurantId)
    .eq('date', data.date)
    .eq('time', data.time)
    .eq('status', 'confirmed');

  const bookedTableIds = (existing || []).map(r => r.table_id);
  const freeTable = tables.find(t => !bookedTableIds.includes(t.id));

  if (!freeTable) {
    console.log('Mesa no disponible para ese horario');
    return { error: 'Mesa no disponible para ese horario' };
  }

  const startDateTime = new Date(`${data.date}T${data.time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 90 * 60 * 1000);

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

  console.log('Insertando en Supabase:', insertData);

  const { data: res, error } = await supabase
    .from('reservations')
    .insert([insertData])
    .select()
    .single();

  if (error) {
    console.log('Error Supabase:', error);
    return { error: error.message };
  }

  console.log('Reserva guardada:', res);
  return res;
}

async function cancelByPhone(phone) {
  const { data } = await supabase
    .from('reservations')
    .update({ status: 'cancelled' })
    .eq('customer_phone', phone)
    .eq('status', 'confirmed')
    .select()
    .single();
  return data;
}

module.exports = { supabase, getAvailability, createReservation, cancelByPhone };
EOF
git add . && git commit -m "fix createReservation" && git push
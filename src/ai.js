const Anthropic = require('@anthropic-ai/sdk');
const { getRestaurantConfig, getAvailability, createReservation, cancelByPhone } = require('./database');

const client = new Anthropic();
const conversations = new Map();

const tools = [
  {
    name: "get_availability",
    description: "Obtiene horarios disponibles para una fecha",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
        guests: { type: "number", description: "Numero de personas" }
      },
      required: ["date", "guests"]
    }
  },
  {
    name: "create_reservation",
    description: "Crea una reserva en la base de datos. OBLIGATORIO llamar antes de confirmar.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string" },
        time: { type: "string" },
        guests: { type: "number" },
        customer_name: { type: "string" },
        customer_phone: { type: "string" }
      },
      required: ["date", "time", "guests", "customer_name", "customer_phone"]
    }
  },
  {
    name: "cancel_reservation",
    description: "Cancela reservas de un telefono",
    input_schema: {
      type: "object",
      properties: {
        customer_phone: { type: "string" }
      },
      required: ["customer_phone"]
    }
  }
];

async function executeTool(name, input) {
  if (name === 'get_availability') {
    return await getAvailability('00000000-0000-0000-0000-000000000001', input.date, input.guests);
  } else if (name === 'create_reservation') {
    return await createReservation('00000000-0000-0000-0000-000000000001', input);
  } else if (name === 'cancel_reservation') {
    return await cancelByPhone(input.customer_phone);
  }
  return { error: 'Tool desconocido' };
}

function getSpainDateTime() {
  const now = new Date();
  const spainTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const dayName = days[spainTime.getDay()];
  const day = String(spainTime.getDate()).padStart(2, '0');
  const month = String(spainTime.getMonth() + 1).padStart(2, '0');
  const year = spainTime.getFullYear();
  const hours = String(spainTime.getHours()).padStart(2, '0');
  const minutes = String(spainTime.getMinutes()).padStart(2, '0');

  const tomorrow = new Date(spainTime);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(spainTime);
  dayAfter.setDate(dayAfter.getDate() + 2);

  const nextDays = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(spainTime);
    d.setDate(d.getDate() + i);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const dayN = days[d.getDay()];
    nextDays.push(`${dayN}: ${yyyy}-${mm}-${dd}`);
  }

  return {
    today: `${year}-${month}-${day}`,
    todayFormatted: `${dayName} ${day}/${month}/${year}`,
    currentTime: `${hours}:${minutes}`,
    tomorrow: `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`,
    dayAfterTomorrow: `${dayAfter.getFullYear()}-${String(dayAfter.getMonth()+1).padStart(2,'0')}-${String(dayAfter.getDate()).padStart(2,'0')}`,
    nextDays: nextDays.join('\n')
  };
}

async function processMessage(phone, text, platform) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }
  const history = conversations.get(phone);
  history.push({ role: "user", content: text });

  const config = await getRestaurantConfig('00000000-0000-0000-0000-000000000001');
  const restaurantName = config?.name || 'Restaurante';
  const openingTime = config?.opening_time || '13:00';
  const closingTime = config?.closing_time || '23:00';
  const dt = getSpainDateTime();

  const SYSTEM_PROMPT = `Eres un asistente de reservas para ${restaurantName}.
Restaurant ID: 00000000-0000-0000-0000-000000000001.
Horario: ${openingTime} a ${closingTime}.

FECHA Y HORA ACTUAL EN ESPAÑA:
- Hoy es: ${dt.todayFormatted} (${dt.today})
- Hora actual: ${dt.currentTime}
- Mañana: ${dt.tomorrow}
- Pasado mañana: ${dt.dayAfterTomorrow}
- Próximos 14 días:
${dt.nextDays}

INTERPRETACIÓN DE FECHAS:
- "hoy" = ${dt.today}
- "mañana" = ${dt.tomorrow}
- "pasado mañana" = ${dt.dayAfterTomorrow}
- "el lunes/martes/etc que viene" = busca en los próximos 14 días el día correcto
- "la semana que viene" = busca en los próximos 7-14 días
- El cliente también puede escribir la fecha en formato DD/MM/YYYY o DD/MM/YY — conviértela siempre a YYYY-MM-DD antes de llamar al tool.

REGLAS ABSOLUTAS:
1. Para ver disponibilidad SIEMPRE llama a get_availability PRIMERO.
2. Para crear una reserva SIEMPRE llama a create_reservation. PROHIBIDO confirmar sin llamar al tool.
3. Para cancelar SIEMPRE llama a cancel_reservation.
4. Necesitas: fecha, hora, personas, nombre completo y teléfono antes de crear reserva.
5. Responde SIEMPRE en el idioma del cliente. Si el cliente escribe en catalán, responde en catalán correcto. Si escribe en inglés, responde en inglés. Nunca mezcles idiomas.
6. Sé amable y conciso.`;

  let continueLoop = true;

  while (continueLoop) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
      tools: tools,
      tool_choice: { type: "auto" }
    });

    if (response.stop_reason === 'tool_use') {
      history.push({ role: "assistant", content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`[Tool llamado] ${block.name}`, JSON.stringify(block.input));
        let result;
        try {
          result = await executeTool(block.name, block.input);
          console.log(`[Tool resultado] ${block.name}`, JSON.stringify(result));
        } catch (e) {
          console.error(`[Tool error] ${block.name}`, e.message);
          result = { error: e.message };
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }
      history.push({ role: "user", content: toolResults });
    } else {
      const finalText = response.content.find(c => c.type === 'text')?.text || 'Lo siento, hubo un error.';
      history.push({ role: "assistant", content: finalText });
      conversations.set(phone, history);
      continueLoop = false;
      return finalText;
    }
  }
}

module.exports = { processMessage };

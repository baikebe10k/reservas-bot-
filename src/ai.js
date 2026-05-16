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

  const SYSTEM_PROMPT = `Eres un asistente de reservas para ${restaurantName}.
Restaurant ID: 00000000-0000-0000-0000-000000000001.
Horario: ${openingTime} a ${closingTime}.

REGLAS ABSOLUTAS — NUNCA las ignores:
1. Para ver disponibilidad SIEMPRE llama a get_availability PRIMERO.
2. Para crear una reserva SIEMPRE llama a create_reservation. PROHIBIDO confirmar una reserva con texto sin haberla creado en la base de datos.
3. Para cancelar SIEMPRE llama a cancel_reservation.
4. Antes de crear una reserva necesitas: fecha, hora, nº personas, nombre completo y teléfono. Si falta alguno, pregúntalo.
5. Responde SIEMPRE en el idioma del cliente.
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

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result)
        });
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
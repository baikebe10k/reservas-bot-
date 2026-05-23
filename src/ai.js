const Anthropic = require('@anthropic-ai/sdk');
const { getRestaurantConfig, getAvailability, createReservation, cancelByPhone, findReservationByName, cancelById } = require('./database');

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
    name: "find_reservation_by_name",
    description: "Busca reservas confirmadas por nombre del cliente",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre o parte del nombre del cliente" }
      },
      required: ["name"]
    }
  },
  {
    name: "cancel_reservation",
    description: "Cancela una reserva por su ID. Usar solo tras confirmar con el cliente.",
    input_schema: {
      type: "object",
      properties: {
        reservation_id: { type: "string", description: "ID de la reserva a cancelar" }
      },
      required: ["reservation_id"]
    }
  }
];

async function processMessage(phone, text, platform, restaurantId) {
  const convKey = `${restaurantId}:${phone}`;
  if (!conversations.has(convKey)) {
    conversations.set(convKey, []);
  }
  const history = conversations.get(convKey);
  history.push({ role: "user", content: text });

  let config, restaurantName, openingTime, closingTime;
  try {
    config = await getRestaurantConfig(restaurantId);
    restaurantName = config?.name || 'Restaurante';
    openingTime = config?.opening_time || '13:00';
    closingTime = config?.closing_time || '23:00';
  } catch (e) {
    console.error('[Config error]', e.message);
    restaurantName = 'Restaurante';
    openingTime = '13:00';
    closingTime = '23:00';
  }

  async function executeTool(name, input) {
    if (name === 'get_availability') {
      return await getAvailability(restaurantId, input.date, input.guests);
    } else if (name === 'create_reservation') {
      const result = await createReservation(restaurantId, input);
      if (result && !result.error) {
        result._confirmation = {
          name: input.customer_name,
          date: input.date,
          time: input.time,
          guests: input.guests
        };
      }
      return result;
    } else if (name === 'find_reservation_by_name') {
      return await findReservationByName(restaurantId, input.name);
    } else if (name === 'cancel_reservation') {
      return await cancelById(input.reservation_id);
    }
    return { error: 'Tool desconocido' };
  }

  const SYSTEM_PROMPT = `Eres el asistente de reservas de ${restaurantName}. Respondes por WhatsApp de forma natural y amable.

FECHA Y HORA ACTUAL: ${new Date().toLocaleString('es-ES', {timeZone: 'Europe/Madrid', weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'})}
Horario del restaurante: ${openingTime} a ${closingTime}.

REGLAS:
1. Cuando el cliente escriba por primera vez, salúdale con una bienvenida cálida según su idioma. Español: "¡Hola! Bienvenido/a a ${restaurantName} 😊 ¿En qué te puedo ayudar?" / Catalán: "Hola! Benvingut/da a ${restaurantName} 😊 En què et puc ajudar?" / Inglés: "Hi! Welcome to ${restaurantName} 😊 How can I help you?" / Francés: "Bonjour! Bienvenue au ${restaurantName} 😊 Comment puis-je vous aider?" / Alemán: "Hallo! Willkommen bei ${restaurantName} 😊 Wie kann ich Ihnen helfen?" Detecta el idioma del cliente. NUNCA listes opciones en el saludo.
2. Para ver disponibilidad SIEMPRE llama a get_availability PRIMERO antes de responder.
3. Para crear una reserva SIEMPRE llama a create_reservation. PROHIBIDO confirmar sin llamar al tool.
4. Para cancelar: PRIMERO llama a find_reservation_by_name con el nombre del cliente. Muestra los datos encontrados de forma cordial: "He encontrado la siguiente reserva a su nombre: [fecha] a las [hora] para [personas] personas. ¿Podría confirmarme que es esta su reserva?" Si confirma, llama a cancel_reservation con el ID. Si hay varias reservas, muéstralas todas y pregunta cuál desea cancelar.
5. Necesitas: fecha, hora, personas, nombre completo y teléfono antes de crear reserva.
6. Responde SIEMPRE en el idioma del cliente.
7. Sé conciso y natural, como un humano. Sin listas innecesarias.
8. Si el cliente dice "hoy", "mañana", "el sábado", etc. — calcula la fecha exacta tú mismo usando la fecha actual indicada arriba.
9. Si no hay disponibilidad para una hora/fecha, SIEMPRE ofrece alternativas: otras horas ese mismo día o los próximos 2-3 días. Llama a get_availability para cada alternativa antes de sugerirla.
10. Cuando confirmes una reserva usa este formato exacto adaptado al idioma del cliente:
✅ Reserva confirmada en ${restaurantName}

Hola [nombre] 😊
📅 [día semana] [día] de [mes]
🕘 [hora]
👥 [personas] persona(s)

Español: "¡Te esperamos! Si necesitas cambiar algo, responde aquí."
Catalán: "T'esperem! Si necessites canviar alguna cosa, respon aquí."
Inglés: "We look forward to seeing you! If you need to change anything, reply here."
Francés: "Nous vous attendons! Si vous avez besoin de modifier quoi que ce soit, répondez ici."
Alemán: "Wir freuen uns auf Sie! Falls Sie etwas ändern möchten, antworten Sie hier."`;

  try {
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
        conversations.set(convKey, history);
        continueLoop = false;
        return finalText;
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error Anthropic:`, err.message);
    conversations.set(convKey, history);
    return 'Ahora mismo tenemos un pequeño problema técnico. Por favor, inténtalo de nuevo en un momento o llámanos directamente. Disculpa las molestias 🙏';
  }
}

module.exports = { processMessage };
const Anthropic = require('@anthropic-ai/sdk');
const { getRestaurantConfig, getAvailability, createReservation, cancelByPhone, findReservationByName, cancelById } = require('./database');

const client = new Anthropic();
const conversations = new Map();
const languageMap = new Map();

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

function detectLanguage(text) {
  const lower = text.toLowerCase();
  if (/\b(bonjour|merci|réserver|bonsoir)\b/.test(lower)) return 'fr';
  if (/\b(hallo|danke|guten|reservieren)\b/.test(lower)) return 'de';
  if (/\b(hello|hi|thanks|book|reservation|please)\b/.test(lower)) return 'en';
  if (/\b(gràcies|bon dia|bona tarda|taula|avui|demà|persones)\b/.test(lower)) return 'ca';
  return 'es';
}

async function processMessage(phone, text, platform, restaurantId) {
  const convKey = `${restaurantId}:${phone}`;
  if (!conversations.has(convKey)) {
    conversations.set(convKey, []);
  }
  const history = conversations.get(convKey);

  if (history.length === 0) {
    const detected = detectLanguage(text);
    languageMap.set(convKey, detected);
  }
  const currentLanguage = languageMap.get(convKey) || 'es';

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

  const nowMadrid = new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
  const madridDate = new Date(nowMadrid);
  const pad = n => String(n).padStart(2, '0');
  const todayISO = `${madridDate.getFullYear()}-${pad(madridDate.getMonth()+1)}-${pad(madridDate.getDate())}`;
  const currentHour = `${pad(madridDate.getHours())}:${pad(madridDate.getMinutes())}`;
  const nextHour = `${pad(madridDate.getHours()+1)}:00`;
  const weekdayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const weekdayNum = madridDate.getDay();

  const next7 = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(madridDate);
    d.setDate(madridDate.getDate() + i);
    const iso = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const wday = weekdayNames[d.getDay()];
    const label = i === 0 ? ' (HOY)' : i === 1 ? ' (MAÑANA)' : '';
    next7.push(`  - ${wday}${label} → ${iso}`);
  }

  async function executeTool(name, input) {
    if (name === 'get_availability') {
      return await getAvailability(restaurantId, input.date, input.guests);
    } else if (name === 'create_reservation') {
      const result = await createReservation(restaurantId, { ...input, language: currentLanguage });
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

FECHA Y HORA ACTUAL EN ESPAÑA:
- Fecha de hoy: ${todayISO} (${weekdayNames[weekdayNum]})
- Hora actual: ${currentHour}

PRÓXIMOS 7 DÍAS — USA SIEMPRE ESTAS FECHAS ISO EXACTAS:
${next7.join('\n')}

REGLAS CRÍTICAS DE FECHAS:
- "hoy" → ${todayISO}
- "mañana" → mira la lista y usa la fecha marcada (MAÑANA)
- "el [día]" o "este [día]" → busca ese día en la lista de arriba (el más próximo)
- "el [día] que viene" o "[día] de la semana que viene" → busca ese día en la lista pero de la SEMANA SIGUIENTE (el que aparece más abajo)
- "dentro de una hora" / "ahora" / "en un momento" → fecha ${todayISO}, hora ${nextHour}
- Formato numérico "3/6", "3/06", "3/06/2026", "3 de junio" → convierte a YYYY-MM-DD usando año ${madridDate.getFullYear()} (si el mes ya pasó, usa ${madridDate.getFullYear()+1})
- NUNCA inventes ni calcules fechas tú solo. USA SIEMPRE la lista de arriba o convierte el formato numérico.

Horario del restaurante: ${openingTime} a ${closingTime}.

REGLAS:
1. Cuando el cliente escriba por primera vez, salúdale con una bienvenida cálida según su idioma. Español: "¡Hola! Bienvenido/a a ${restaurantName} 😊 ¿En qué te puedo ayudar?" / Catalán: "Hola! Benvingut/da a ${restaurantName} 😊 En què et puc ajudar?" / Inglés: "Hi! Welcome to ${restaurantName} 😊 How can I help you?" / Francés: "Bonjour! Bienvenue au ${restaurantName} 😊 Comment puis-je vous aider?" / Alemán: "Hallo! Willkommen bei ${restaurantName} 😊 Wie kann ich Ihnen helfen?" Detecta el idioma del cliente. NUNCA listes opciones en el saludo.
2. Para ver disponibilidad SIEMPRE llama a get_availability PRIMERO antes de responder.
3. Para crear una reserva SIEMPRE llama a create_reservation. PROHIBIDO confirmar sin llamar al tool.
4. Para cancelar: PRIMERO llama a find_reservation_by_name con el nombre del cliente. Muestra los datos encontrados de forma cordial: "He encontrado la siguiente reserva a su nombre: [fecha] a las [hora] para [personas] personas. ¿Podría confirmarme que es esta su reserva?" Si confirma, llama a cancel_reservation con el ID. Si hay varias reservas, muéstralas todas y pregunta cuál desea cancelar.
5. Necesitas: fecha, hora, personas, nombre completo y teléfono antes de crear reserva.
6. Responde SIEMPRE en el idioma del cliente. Detecta el idioma en su PRIMER mensaje y mantén ESE idioma en TODA la conversación sin mezclarlo. Si escribe en catalán, responde 100% en catalán. Si escribe en español, responde 100% en español. NUNCA mezcles idiomas en una misma respuesta.
7. Sé conciso y natural como un humano. NUNCA uses listas con bullets ni numeradas. Escribe en texto corrido como por WhatsApp. No des ejemplos innecesarios entre paréntesis.
8. Si no hay disponibilidad para una hora/fecha, SIEMPRE ofrece alternativas: otras horas ese mismo día o los próximos 2-3 días. Llama a get_availability para cada alternativa antes de sugerirla.
9. Cuando confirmes una reserva usa este formato exacto adaptado al idioma del cliente:
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

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 25000)
    );

    while (continueLoop) {
      const response = await Promise.race([
        client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: history,
          tools: tools,
          tool_choice: { type: "auto" }
        }),
        timeout
      ]);

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
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
    conversations.set(convKey, history);
    if (err.message === 'Timeout') {
      return 'Tardamos un poco más de lo normal. Por favor inténtalo de nuevo en un momento 🙏';
    }
    return 'Ahora mismo tenemos un pequeño problema técnico. Por favor, inténtalo de nuevo en un momento o llámanos directamente. Disculpa las molestias 🙏';
  }
}

module.exports = { processMessage };
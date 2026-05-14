const Anthropic = require('@anthropic-ai/sdk');
const { getAvailability, createReservation, cancelByPhone } = require('./database');

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
    description: "Crea una reserva",
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

async function processMessage(phone, text, platform) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }
  let history = conversations.get(phone);
  history = history.filter(msg => {
    if (Array.isArray(msg.content)) {
      return !msg.content.some(c => c.type === 'tool_use' || c.type === 'tool_result');
    }
    return true;
  });
  history.push({ role: "user", content: text });
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: "Eres un asistente de reservas para Restaurante Demo. Ayuda a los clientes a hacer, consultar y cancelar reservas. El restaurante ID es 00000000-0000-0000-0000-000000000001. Responde siempre en el idioma del cliente. Se amable y conciso.",
    messages: history,
    tools: tools
  });
  if (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find(c => c.type === 'tool_use');
    let toolResult;
    try {
      if (toolUseBlock.name === 'get_availability') {
        const result = await getAvailability('00000000-0000-0000-0000-000000000001', toolUseBlock.input.date, toolUseBlock.input.guests);
        toolResult = JSON.stringify(result);
      } else if (toolUseBlock.name === 'create_reservation') {
        const result = await createReservation('00000000-0000-0000-0000-000000000001', toolUseBlock.input);
        toolResult = JSON.stringify(result);
      } else if (toolUseBlock.name === 'cancel_reservation') {
        const result = await cancelByPhone(toolUseBlock.input.customer_phone);
        toolResult = JSON.stringify(result);
      }
    } catch (e) {
      toolResult = JSON.stringify({ error: e.message });
    }
    const response2 = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: "Eres un asistente de reservas para Restaurante Demo. Ayuda a los clientes a hacer, consultar y cancelar reservas. Responde siempre en el idioma del cliente. Se amable y conciso.",
      messages: [
        ...history,
        { role: "assistant", content: response.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseBlock.id, content: toolResult }] }
      ],
      tools: tools
    });
    const finalText = response2.content.find(c => c.type === 'text')?.text || 'Lo siento, hubo un error.';
    history.push({ role: "assistant", content: finalText });
    conversations.set(phone, history);
    return finalText;
  }
  const replyText = response.content.find(c => c.type === 'text')?.text || 'Lo siento, hubo un error.';
  history.push({ role: "assistant", content: replyText });
  conversations.set(phone, history);
  return replyText;
}

module.exports = { processMessage };

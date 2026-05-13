const Anthropic = require('@anthropic-ai/sdk');
const { getAvailability, createReservation, cancelByPhone } = require('./database');
require('dotenv').config();

const client = new Anthropic();
const conversations = new Map();

async function processMessage(customerPhone, messageText, restaurantPhoneId) {
    let history = conversations.get(customerPhone) || [];
    if (history.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'))) {
      history = [];
    }
  const restaurantId = await getRestaurantId(restaurantPhoneId);

  history.push({ role: 'user', content: messageText });

  const systemPrompt = `Eres el asistente de reservas de un restaurante. Ayudas a los clientes a:
1. Hacer reservas (preguntas fecha, personas, y muestras disponibilidad)
2. Cancelar reservas existentes

Hoy es ${new Date().toLocaleDateString('es-ES')}.
El ID del restaurante es: ${restaurantId}

IMPORTANTE: Detecta el idioma del cliente y responde SIEMPRE en ese idioma (español, inglés, francés, alemán, etc).
Sé amable y conciso.
Si el cliente da una fecha, extráela en formato YYYY-MM-DD.
Nunca inventes disponibilidad, siempre consulta la base de datos.`;

  const tools = [
    {
      name: 'getAvailability',
      description: 'Consulta los horarios disponibles para una fecha y número de personas',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
          guests: { type: 'number', description: 'Número de personas' }
        },
        required: ['date', 'guests']
      }
    },
    {
      name: 'createReservation',
      description: 'Crea una reserva confirmada',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          time: { type: 'string' },
          guests: { type: 'number' },
          tableId: { type: 'string' },
          customerName: { type: 'string' }
        },
        required: ['date', 'time', 'guests', 'tableId']
      }
    },
    {
      name: 'cancelReservation',
      description: 'Cancela la reserva del cliente',
      input_schema: {
        type: 'object',
        properties: {
          phone: { type: 'string' }
        },
        required: ['phone']
      }
    }
  ];

  let response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    tools,
    messages: history
  });

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    
    history.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      let toolResult;
      if (block.name === 'getAvailability') {
        toolResult = await getAvailability(restaurantId, block.input.date, block.input.guests);
      } else if (block.name === 'createReservation') {
        toolResult = await createReservation({
          ...block.input,
          table_id: block.input.tableId,
          customer_phone: customerPhone,
          restaurant_id: restaurantId
        });
      } else if (block.name === 'cancelReservation') {
        toolResult = await cancelByPhone(customerPhone, restaurantId);
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(toolResult)
      });
    }

    history.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages: history
    });
  }

  const finalText = response.content.find(b => b.type === 'text')?.text || '';
  history.push({ role: 'assistant', content: finalText });
  conversations.set(customerPhone, history.slice(-20));

  return finalText;
}

async function getRestaurantId(phoneId) {
  return '00000000-0000-0000-0000-000000000001';
}

module.exports = { processMessage };
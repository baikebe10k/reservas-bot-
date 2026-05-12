const Anthropic = require('@anthropic-ai/sdk');
const { getAvailability, createReservation, cancelByPhone } = require('./database');
require('dotenv').config();

const client = new Anthropic();
const conversations = new Map();

async function processMessage(customerPhone, messageText, restaurantPhoneId) {
  const history = conversations.get(customerPhone) || [];
  const restaurantId = await getRestaurantId(restaurantPhoneId);

  history.push({ role: 'user', content: messageText });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: `Eres el asistente de reservas de un restaurante. Ayudas a los clientes a:
1. Hacer reservas (preguntas fecha, personas, y muestras disponibilidad)
2. Cancelar reservas existentes

Hoy es ${new Date().toLocaleDateString('es-ES')}.
El ID del restaurante es: ${restaurantId}

Responde siempre en español, de forma amable y concisa.
Si el cliente da una fecha, extráela en formato YYYY-MM-DD.
Nunca inventes disponibilidad, siempre consulta la base de datos.`,
    tools: [
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
    ],
    messages: history
  });

  let finalText = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      finalText = block.text;
    } else if (block.type === 'tool_use') {
      let toolResult;
      if (block.name === 'getAvailability') {
        toolResult = await getAvailability(restaurantId, block.input.date, block.input.guests);
      } else if (block.name === 'createReservation') {
        toolResult = await createReservation({
          ...block.input,
          customer_phone: customerPhone,
          restaurant_id: restaurantId
        });
      } else if (block.name === 'cancelReservation') {
        toolResult = await cancelByPhone(customerPhone, restaurantId);
      }

      history.push({ role: 'assistant', content: response.content });
      history.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(toolResult) }]
      });

      const response2 = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: history
      });
      finalText = response2.content.find(b => b.type === 'text')?.text || '';
    }
  }

  history.push({ role: 'assistant', content: finalText });
  conversations.set(customerPhone, history.slice(-20));

  return finalText;
}

async function getRestaurantId(phoneId) {
  return 'tu-restaurant-id';
}

module.exports = { processMessage };
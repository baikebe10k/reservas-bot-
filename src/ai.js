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
        guests: { type: "number", description: "Número de personas" }
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
    description: "Cancela reservas de un teléfono",
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
  // Limpiar historial corrupto - solo mantener mensajes user/assistant simples
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }
  
  let history = conversations.get(phone);
  
  // Filtrar cualquier mensaje con tool_use o tool_result del
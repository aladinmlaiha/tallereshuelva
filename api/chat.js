/**
 * Vercel Serverless Function: /api/chat
 * Integración con Gemini API para el chatbot de Midas Huelva.
 */

const SYSTEM_INSTRUCTION = `Eres el asistente virtual inteligente y servicial del taller mecánico oficial Midas Huelva, situado en Avda. Doctor Rubio, 6 (Huelva centro).

Tu objetivo es responder dudas sobre servicios, precios aproximados, horarios, ubicación, cita previa y ventajas del taller de manera rápida, clara, profesional y en español.

INFORMACIÓN CLAVE DEL TALLER:
- Nombre: Taller Midas Huelva - Centro Oficial Multimarca
- Teléfono de atención y cita previa: 959 86 30 00
- Dirección: Avda. Doctor Rubio, 6, 21002 Huelva (en pleno centro, cómodo acceso)
- Horario ininterrumpido:
  • Lunes a Viernes: 08:30 a 20:00 h
  • Sábados: 09:00 a 14:00 h
  • Domingos y Festivos: Cerrado

SERVICIOS Y PRECIOS "DESDE":
1. LA Revisión Oficial y Mantenimiento: desde 89 € (conforme al libro de mantenimiento del fabricante, mantiene la garantía oficial sellada).
2. Neumáticos: desde 49 € (primeras marcas con montaje, equilibrado y revisión de alineación).
3. Frenos: desde 65 € (pastillas, discos y líquido de freno).
4. Climatización / Aire Acondicionado: desde 59 € (recarga de gas, purificación del habitáculo y filtros).
5. Correa de Distribución: desde 280 € (kit completo con bomba de agua).
6. Embrague y Transmisión: desde 350 € (diagnóstico, embragues y volantes bimasa).
7. Baterías: desde 75 € (comprobación gratuita in situ e instalación inmediata).
8. Pre-ITV / ITV Service: desde 39 € ("La pasamos por ti", llevamos tu vehículo a la estación ITV sin pérdidas de tiempo).
9. Diagnóstico Gratuito de Seguridad: 100% GRATIS (revisión visual de más de 30 puntos clave: luces, niveles, amortiguación, frenos, neumáticos).

VENTAJAS Y POLÍTICAS MIDAS:
- Presupuesto cerrado: El presupuesto acordado es exactamente igual a la factura final. Cero sorpresas ni sobrecostes. Siempre se pide autorización previa antes de intervenir.
- Financiación: En 3, 6 o 12 meses a medida.
- Coche de sustitución: Disponibilidad de vehículo de sustitución híbrido para que no pares (sujeto a disponibilidad).
- Garantía oficial de fabricante: Mantiene la garantía sellando el libro de mantenimiento oficial.

PAUTAS DE RESPUESTA:
- Respuestas breves, directas, amables y en español (máximo 2-3 párrafos o puntos clave).
- Usa formato markdown simple (negritas o viñetas) para facilitar la lectura.
- Si el cliente pregunta por una avería compleja, un presupuesto exacto no listado o un caso específico de su modelo de coche, explícale que en el taller hacen presupuesto cerrado y personalizado sin compromiso, e invítale a llamar al teléfono 959 86 30 00 o a pedir cita en la web.
- Si te preguntan algo ajeno a mecánica de coches o a Midas Huelva, indica amablemente que solo atiendes consultas relacionadas con el taller y sus servicios.`;

// Almacenamiento en memoria para limitación básica de peticiones por IP (Rate Limiting)
const ipRequestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_REQUESTS_PER_WINDOW = 12; // Máximo 12 mensajes por minuto por IP

export default async function handler(req, res) {
  // Configuración de cabeceras CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método no permitido. Utiliza POST.'
    });
  }

  // Rate Limiting simple por IP
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const clientRecord = ipRequestCounts.get(clientIp);

  if (clientRecord) {
    if (now - clientRecord.startTime < RATE_LIMIT_WINDOW_MS) {
      if (clientRecord.count >= MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({
          error: 'Has enviado demasiados mensajes seguidos. Por favor, espera un minuto o llámanos directamente al 959 86 30 00.'
        });
      }
      clientRecord.count++;
    } else {
      ipRequestCounts.set(clientIp, { count: 1, startTime: now });
    }
  } else {
    ipRequestCounts.set(clientIp, { count: 1, startTime: now });
  }

  // Limpieza periódica del Map de IPs (prevenir memory leak)
  if (ipRequestCounts.size > 1000) {
    for (const [key, val] of ipRequestCounts.entries()) {
      if (now - val.startTime > RATE_LIMIT_WINDOW_MS) {
        ipRequestCounts.delete(key);
      }
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: La variable de entorno GEMINI_API_KEY no está configurada.');
    return res.status(500).json({
      error: 'El servicio de chatbot no está configurado correctamente en el servidor. Por favor, contacta al taller en el 959 86 30 00.'
    });
  }

  try {
    const { messages } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'Petición inválida: se requiere un array de mensajes.'
      });
    }

    // Limitar historial a los últimos 10 mensajes para no saturar tokens
    const recentMessages = messages.slice(-10);

    // Formatear mensajes para la API de Gemini (formato contents: [{ role, parts }])
    const geminiContents = recentMessages.map(msg => {
      const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
      const text = typeof msg.content === 'string' ? msg.content.trim().slice(0, 1000) : '';
      return {
        role: role,
        parts: [{ text: text }]
      };
    }).filter(c => c.parts[0].text.length > 0);

    if (geminiContents.length === 0) {
      return res.status(400).json({
        error: 'El mensaje no contiene texto válido.'
      });
    }

    // Modelo gratuito recomendado en Gemini API: gemini-1.5-flash
    const GEMINI_MODEL = 'gemini-1.5-flash';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const payload = {
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }]
      },
      contents: geminiContents,
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        maxOutputTokens: 500
      }
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Error desde Gemini API:', response.status, errorData);
      
      if (response.status === 429) {
        return res.status(429).json({
          error: 'El servicio está experimentando alta demanda. Llámanos al 959 86 30 00 para atenderte de inmediato.'
        });
      }

      return res.status(502).json({
        error: 'No se pudo conectar con el servicio de asistencia. Por favor, inténtalo de nuevo o llámanos al 959 86 30 00.'
      });
    }

    const data = await response.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!replyText) {
      return res.status(500).json({
        error: 'No se obtuvo respuesta válida del asistente. Llámanos al 959 86 30 00 para ayudarte.'
      });
    }

    return res.status(200).json({
      reply: replyText
    });

  } catch (error) {
    console.error('Error interno en /api/chat:', error);
    return res.status(500).json({
      error: 'Ha ocurrido un error inesperado. Por favor llámanos al 959 86 30 00 para consultar tus dudas.'
    });
  }
}

/**
 * Vercel Serverless Function: /api/chat
 * Integración dinámica y autoadaptable con Gemini API para Midas Huelva.
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

export default async function handler(req, res) {
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
    return res.status(405).json({ error: 'Método no permitido. Utiliza POST.' });
  }

  const rawKey = process.env.GEMINI_API_KEY || '';
  const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

  if (!apiKey) {
    return res.status(500).json({
      error: 'La variable GEMINI_API_KEY no está configurada en Vercel.'
    });
  }

  try {
    const { messages } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Petición inválida.' });
    }

    const recentMessages = messages.slice(-10);

    const geminiContents = recentMessages.map((msg) => {
      const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
      let text = typeof msg.content === 'string' ? msg.content.trim().slice(0, 1000) : '';
      return {
        role: role,
        parts: [{ text: text }]
      };
    }).filter(c => c.parts[0].text.length > 0);

    if (geminiContents.length === 0) {
      return res.status(400).json({ error: 'El mensaje no contiene texto válido.' });
    }

    // Inyectar contexto en el primer mensaje
    if (geminiContents[0].role === 'user') {
      geminiContents[0].parts[0].text = `[Instrucciones del sistema para el asistente]:\n${SYSTEM_INSTRUCTION}\n\n[Pregunta del cliente]:\n${geminiContents[0].parts[0].text}`;
    }

    // 1. Obtener automáticamente los modelos disponibles para esta clave en Google AI Studio
    let availableModels = [];
    try {
      const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (listResponse.ok) {
        const listData = await listResponse.json();
        availableModels = (listData.models || [])
          .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
          .map(m => m.name.replace('models/', ''));
      }
    } catch (e) {
      console.warn('No se pudo listar modelos dinámicamente:', e);
    }

    // Si la lista dinámica no responde, probar fallback
    if (availableModels.length === 0) {
      availableModels = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-pro'];
    } else {
      // Priorizar los modelos flash
      availableModels.sort((a, b) => {
        if (a.includes('flash') && !b.includes('flash')) return -1;
        if (!a.includes('flash') && b.includes('flash')) return 1;
        return 0;
      });
    }

    let lastError = null;

    for (const model of availableModels) {
      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const payload = {
          contents: geminiContents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 10000
        
          }
        };

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await response.json().catch(() => ({}));

        if (response.ok) {
          const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (replyText) {
            return res.status(200).json({ reply: replyText });
          }
        }

        if (data.error?.message) {
          lastError = data.error.message;
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    return res.status(502).json({
      error: `Error al conectar con Gemini: ${lastError || 'Consulta no procesada'}`
    });

  } catch (error) {
    console.error('Error interno en /api/chat:', error);
    return res.status(500).json({
      error: 'Ha ocurrido un error inesperado al procesar tu consulta.'
    });
  }
}
 

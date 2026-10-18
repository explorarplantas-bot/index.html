function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestGet({ env }) {
  const chave =
    env.GEMINI_API_KEY || env.GOOGLE_API_KEY;

  return responder({
    funcionando: true,
    chaveConfigurada: Boolean(chave),
    mensagem: "API de identificação de plantas ativa."
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const chave =
      env.GEMINI_API_KEY || env.GOOGLE_API_KEY;

    if (!chave) {
      return responder({
        sucesso: false,
        erro: "Chave do Gemini não configurada no Cloudflare."
      }, 500);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return responder({
        sucesso: false,
        erro: "Os dados enviados não são um JSON válido."
      }, 400);
    }

    const imagem = body?.imagem;

    if (
      typeof imagem !== "string" ||
      !imagem.startsWith("data:image/")
    ) {
      return responder({
        sucesso: false,
        erro: "Envie uma foto válida da planta."
      }, 400);
    }

    const partes = imagem.match(
      /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
    );

    if (!partes) {
      return responder({
        sucesso: false,
        erro: "Formato de imagem inválido. Use JPG, PNG ou WebP."
      }, 400);
    }

    const tipoImagem = partes[1] === "image/jpg"
      ? "image/jpeg"
      : partes[1];

    const base64 = partes[2].replace(/\s/g, "");

    if (!base64) {
      return responder({
        sucesso: false,
        erro: "A imagem está vazia."
      }, 400);
    }

    if (base64.length > 7_000_000) {
      return responder({
        sucesso: false,
        erro: "A imagem é muito grande. Escolha uma foto menor."
      }, 413);
    }

    const prompt = `
Você é um especialista em botânica e identificação de plantas.

Analise cuidadosamente a fotografia enviada.

Responda em português brasileiro.

IMPORTANTE:
- Não invente informações.
- Não presuma características que não podem ser observadas.
- Se a identificação não for segura, informe isso.
- A toxicidade deve ser considerada "Desconhecida" quando não houver certeza.
- Diferencie nome popular de nome científico.
- Se houver dúvida entre espécies parecidas, mencione isso em "observacao".
- As recomendações de cultivo devem ser coerentes com a planta identificada.

Retorne SOMENTE um objeto JSON válido, sem markdown, sem comentários e sem texto antes ou depois.

Use exatamente esta estrutura:

{
  "nomePopular": "nome popular da planta",
  "nomeCientifico": "nome científico ou Não identificado",
  "familia": "família botânica ou Não confirmada",
  "confianca": "alta, média ou baixa",
  "caracteristicas": "descrição das características visíveis na fotografia",
  "luz": "necessidade de iluminação",
  "rega": "orientação de rega",
  "solo": "tipo de solo recomendado",
  "adubacao": "orientação de adubação",
  "propagacao": "formas de propagação",
  "toxicidade": "toxicidade conhecida para pessoas e animais ou Desconhecida",
  "cuidados": [
    "primeira recomendação",
    "segunda recomendação",
    "terceira recomendação"
  ],
  "observacao": "limitações da identificação ou informação útil"
}

Se não for possível identificar a planta com segurança, use:

"nomePopular": "Não identificado",
"nomeCientifico": "Não identificado",
"confianca": "baixa"

e explique o motivo em "observacao".
`;

    const respostaGemini = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": chave
        },

        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                },
                {
                  inline_data: {
                    mime_type: tipoImagem,
                    data: base64
                  }
                }
              ]
            }
          ],

          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 1800
          }
        })
      }
    );

    const textoResposta = await respostaGemini.text();

    let dadosGemini;

    try {
      dadosGemini = JSON.parse(textoResposta);
    } catch {
      return responder({
        sucesso: false,
        erro: "O Gemini retornou uma resposta inválida.",
        detalhe: textoResposta.substring(0, 500)
      }, 502);
    }

    if (!respostaGemini.ok) {
      const mensagem =
        dadosGemini?.error?.message ||
        "Não foi possível consultar o Gemini.";

      return responder({
        sucesso: false,
        erro:
          respostaGemini.status === 429
            ? "O limite de consultas do Gemini foi atingido. Tente novamente mais tarde."
            : `Erro do Gemini (${respostaGemini.status}): ${mensagem}`
      }, respostaGemini.status === 429 ? 429 : 502);
    }

    const textoGerado =
      dadosGemini?.candidates?.[0]?.content?.parts
        ?.map(parte => parte?.text || "")
        .join("")
        .trim();

    if (!textoGerado) {
      return responder({
        sucesso: false,
        erro: "A inteligência artificial não conseguiu identificar a planta. Tente outra foto."
      }, 502);
    }

    let planta;

    try {
      planta = JSON.parse(textoGerado);
    } catch {
      // Tentativa de limpar possíveis blocos de markdown
      const textoLimpo = textoGerado
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      try {
        planta = JSON.parse(textoLimpo);
      } catch {
        return responder({
          sucesso: false,
          erro: "Não foi possível interpretar a identificação. Tente novamente."
        }, 502);
      }
    }

    // Garantir que os campos principais existam
    planta = {
      nomePopular:
        planta?.nomePopular ||
        "Não identificado",

      nomeCientifico:
        planta?.nomeCientifico ||
        "Não identificado",

      familia:
        planta?.familia ||
        "Não confirmada",

      confianca:
        planta?.confianca ||
        "baixa",

      caracteristicas:
        planta?.caracteristicas ||
        "Não foi possível determinar.",

      luz:
        planta?.luz ||
        "Não foi possível determinar.",

      rega:
        planta?.rega ||
        "Não foi possível determinar.",

      solo:
        planta?.solo ||
        "Não foi possível determinar.",

      adubacao:
        planta?.adubacao ||
        "Não foi possível determinar.",

      propagacao:
        planta?.propagacao ||
        "Não foi possível determinar.",

      toxicidade:
        planta?.toxicidade ||
        "Desconhecida",

      cuidados:
        Array.isArray(planta?.cuidados)
          ? planta.cuidados
          : [],

      observacao:
        planta?.observacao ||
        ""
    };

    /*
     * Retornamos os dois formatos:
     *
     * resultado -> compatibilidade com versões antigas do frontend
     * planta     -> formato atual
     */
    return responder({
      sucesso: true,
      resultado: planta,
      planta: planta
    });

  } catch (erro) {
    return responder({
      sucesso: false,
      erro: "Ocorreu um erro no servidor. Tente novamente.",
      detalhe:
        erro instanceof Error
          ? erro.message
          : "Erro desconhecido"
    }, 500);
  }
}

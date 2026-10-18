
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
        erro: "Chave do Gemini não configurada no Cloudflare."
      }, 500);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return responder({
        erro: "Os dados enviados não são um JSON válido."
      }, 400);
    }

    const imagem = body?.imagem;

    if (
      typeof imagem !== "string" ||
      !imagem.startsWith("data:image/")
    ) {
      return responder({
        erro: "Envie uma foto válida da planta."
      }, 400);
    }

    const partes = imagem.match(
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
    );

    if (!partes) {
      return responder({
        erro: "Formato de imagem inválido. Use JPG, PNG ou WebP."
      }, 400);
    }

    const tipoImagem = partes[1];
    const base64 = partes[2].replace(/\s/g, "");

    if (base64.length > 7_000_000) {
      return responder({
        erro: "A imagem é muito grande. Escolha uma foto menor."
      }, 413);
    }

    const prompt = `
Você é um especialista em botânica e identificação de plantas.
Analise cuidadosamente a fotografia enviada.
Responda em português brasileiro, usando somente informações
que possam ser estimadas com responsabilidade pela imagem.
Se não for possível identificar a espécie com segurança,
explique essa limitação e não invente informações.

Retorne somente um objeto JSON válido com estes campos:
{
  "nomePopular": "nome popular da planta",
  "nomeCientifico": "nome científico ou Não identificado",
  "familia": "família botânica, se conhecida",
  "confianca": "alta, média ou baixa",
  "caracteristicas": "descrição das características visíveis",
  "luz": "necessidade de iluminação",
  "rega": "orientação de rega",
  "solo": "tipo de solo recomendado",
  "adubacao": "orientação de adubação",
  "propagacao": "formas de propagação",
  "toxicidade": "toxicidade conhecida para pessoas e animais",
  "cuidados": [
    "primeira recomendação",
    "segunda recomendação",
    "terceira recomendação"
  ],
  "observacao": "limitações da identificação ou informação útil"
}

Não presuma que uma característica não visível esteja presente.
Se não souber alguma informação, diga que não foi possível confirmar.
A toxicidade deve ser considerada desconhecida quando não houver
certeza sobre a espécie identificada.
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
                { text: prompt },
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
        erro: "O Gemini retornou uma resposta inválida. Tente novamente."
      }, 502);
    }

    if (!respostaGemini.ok) {
      const mensagem =
        dadosGemini?.error?.message ||
        "Não foi possível consultar o Gemini.";

      return responder({
        erro: respostaGemini.status === 429
          ? "O limite de consultas do Gemini foi atingido. Tente mais tarde."
          : `Erro do Gemini (${respostaGemini.status}): ${mensagem}`
      }, respostaGemini.status === 429 ? 429 : 502);
    }

    const textoGerado =
      dadosGemini?.candidates?.[0]?.content?.parts
        ?.map(parte => parte.text || "")
        .join("")
        .trim();

    if (!textoGerado) {
      return responder({
        erro: "A inteligência artificial não conseguiu identificar a planta. Tente outra foto."
      }, 502);
    }

    let planta;

    try {
      planta = JSON.parse(textoGerado);
    } catch {
      return responder({
        erro: "Não foi possível interpretar a identificação. Tente novamente."
      }, 502);
    }

    return responder({
      sucesso: true,
      planta
    });

  } catch (erro) {
    return responder({
      erro: "Ocorreu um erro no servidor. Tente novamente.",
      detalhe: erro instanceof Error
        ? erro.message
        : "Erro desconhecido"
    }, 500);
  }
}


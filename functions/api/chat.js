// ============================================================
// Cloudflare Pages Function — OpenAI API Proxy
// ============================================================
// Runs at: /api/chat (same origin as the site, no CORS needed)
//
// Set your API key in the Cloudflare Pages dashboard:
//   Settings > Environment variables > Add: OPENAI_API_KEY

export async function onRequestPost(context) {
  const apiKey = context.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'OPENAI_API_KEY is not configured' },
      { status: 500 }
    );
  }

  try {
    const body = await context.request.json();

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json(
        { error: 'Invalid request: messages array required' },
        { status: 400 }
      );
    }

    const payload = {
      model: body.model || 'gpt-4o',
      messages: body.messages,
      temperature: body.temperature ?? 0.7,
      max_tokens: Math.min(body.max_tokens || 4000, 8000),
    };

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await openaiResponse.text();
    return new Response(data, {
      status: openaiResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return Response.json(
      { error: 'Proxy error: ' + err.message },
      { status: 500 }
    );
  }
}

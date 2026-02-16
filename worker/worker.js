// ============================================================
// Cloudflare Worker — OpenAI API Proxy for MTG Deck Builder
// ============================================================
// Deploy this as a Cloudflare Worker with the environment variable:
//   OPENAI_API_KEY = your OpenAI API key
//
// The worker proxies POST requests to OpenAI's chat completions
// endpoint, keeping the API key server-side and hidden from users.
// ============================================================

const ALLOWED_ORIGINS = [
  'https://yourusername.github.io',  // Update with your actual GitHub Pages URL
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.find(o => origin.startsWith(o)) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json();

      // Validate the request shape — only allow chat completions
      if (!body.messages || !Array.isArray(body.messages)) {
        return new Response(JSON.stringify({ error: 'Invalid request: messages array required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Enforce limits to prevent abuse
      const payload = {
        model: body.model || 'gpt-4o',
        messages: body.messages,
        temperature: body.temperature ?? 0.7,
        max_tokens: Math.min(body.max_tokens || 4000, 8000),
      };

      // Proxy to OpenAI
      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await openaiResponse.text();

      return new Response(data, {
        status: openaiResponse.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Internal worker error', details: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

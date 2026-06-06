'use strict';

/**
 * backend-handler.js — Shared backend Lambda
 *
 * This is the Lambda that ALL provisioned API Gateways integrate with.
 * Every API created via the portal routes its traffic here, regardless
 * of what route path or HTTP method was configured.
 *
 * Built-in routes:
 *   ANY /health  → health check response
 *   ANY /echo    → mirrors back the full request
 *   ANY *        → dynamic catch-all: returns 200 with request details
 *
 * To add real business logic, add explicit route handlers before the
 * catch-all block at the bottom of this file.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'Content-Type':                 'application/json',
};

function ok(body, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(body, null, 2) };
}

exports.handler = async (event) => {
  const method  = event.requestContext?.http?.method ?? event.httpMethod;
  const path    = event.requestContext?.http?.path   ?? event.path;
  const query   = event.queryStringParameters        ?? {};

  console.log(`[backend] ${method} ${path}`, { query });

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ── Health check ────────────────────────────────────────────────────────────
  if (path === '/health' || path?.endsWith('/health')) {
    return ok({
      status:      'healthy',
      service:     'api-portal-backend-lambda',
      environment: process.env.ENVIRONMENT,
      region:      process.env.AWS_REGION,
      timestamp:   new Date().toISOString(),
    });
  }

  // ── Echo endpoint ───────────────────────────────────────────────────────────
  if (path === '/echo' || path?.endsWith('/echo')) {
    let body = null;
    try { body = event.body ? JSON.parse(event.body) : null; } catch { body = event.body; }
    return ok({
      echo: { method, path, query, headers: event.headers, body },
      timestamp: new Date().toISOString(),
    });
  }

  // ── Add your real business routes here ──────────────────────────────────────
  //
  // Example:
  //   if (method === 'GET' && path === '/data') {
  //     return ok({ data: await fetchFromDB() });
  //   }
  //
  // ────────────────────────────────────────────────────────────────────────────

  // ── Dynamic catch-all — returns 200 for any provisioned route ───────────────
  // The API Portal can provision any path/method combination. This catch-all
  // ensures every provisioned API returns a valid 200 response out of the box.
  let parsedBody = null;
  try { parsedBody = event.body ? JSON.parse(event.body) : null; } catch { parsedBody = event.body; }

  console.log(`[backend] catch-all: ${method} ${path}`);
  return ok({
    message:   `✅ API Portal — ${method} ${path}`,
    service:   'api-portal-backend-lambda',
    request: {
      method,
      path,
      query:   Object.keys(query).length ? query : null,
      body:    parsedBody,
    },
    environment: process.env.ENVIRONMENT,
    timestamp:   new Date().toISOString(),
  });
};


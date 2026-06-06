'use strict';

/**
 * backend-handler.js — Shared backend Lambda
 *
 * This is the Lambda that ALL provisioned API Gateways integrate with.
 * Every API created via the portal routes its traffic here.
 *
 * Extend this file to add real business logic per route/api_name.
 * The api_name is available via the custom header X-Api-Name (set by
 * provisioners) or can be inferred from the domain / path context.
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

function notFound(path) {
  return {
    statusCode: 404,
    headers: CORS,
    body: JSON.stringify({ error: 'Not found', path }),
  };
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

  // ── Health / smoke-test ─────────────────────────────────────────────────────
  if (path === '/health' || path?.endsWith('/health')) {
    return ok({
      status:      'healthy',
      service:     'api-portal-backend-lambda',
      environment: process.env.ENVIRONMENT,
      region:      process.env.AWS_REGION,   // set automatically by Lambda runtime
      timestamp:   new Date().toISOString(),
    });
  }

  // ── Echo endpoint — useful for integration testing ──────────────────────────
  if (path === '/echo' || path?.endsWith('/echo')) {
    let body = null;
    try { body = event.body ? JSON.parse(event.body) : null; } catch { body = event.body; }
    return ok({
      echo: {
        method,
        path,
        query,
        headers: event.headers,
        body,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // ── Add your real business routes here ──────────────────────────────────────
  //
  // Example:
  //   if (method === 'GET' && path === '/data') {
  //     const data = await fetchFromDB();
  //     return ok({ data });
  //   }
  //
  // The provisioned API name is available via:
  //   event.headers?.['x-api-portal-name']  (set by the portal when provisioning)
  //   or derive it from path segments
  // ────────────────────────────────────────────────────────────────────────────

  console.warn(`[backend] unhandled route: ${method} ${path}`);
  return notFound(path);
};


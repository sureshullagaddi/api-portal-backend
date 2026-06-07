'use strict';

/**
 * handler.js — GUI Lambda entry point
 *
 * Routes:
 *   POST   /apis                        → provision a new API
 *   GET    /apis                        → list all provisioned APIs
 *   GET    /apis/{api_name}             → get details of one API
 *   DELETE /apis/{api_name}             → destroy an API and its AWS resources
 *   POST   /apis/{api_name}/force-clear → remove stuck FAILED record from registry
 */

const db = require('./db');

const provisioners = {
  'http-public':     require('./provisioners/http-public'),
  'http-jwt':        require('./provisioners/http-jwt'),
  'http-custom-key': require('./provisioners/http-custom-key'),
  'http-iam':        require('./provisioners/http-iam'),
  'rest-usage-plan': require('./provisioners/rest-usage-plan'),
};

const REQUIRED_ENV_VARS = {
  'http-public':     ['EXISTING_LAMBDA_ARN', 'EXISTING_LAMBDA_FUNCTION_NAME'],
  'http-jwt':        ['EXISTING_LAMBDA_ARN', 'EXISTING_LAMBDA_FUNCTION_NAME', 'EXISTING_COGNITO_POOL_ID', 'EXISTING_COGNITO_CLIENT_ID'],
  'http-custom-key': ['EXISTING_LAMBDA_ARN', 'EXISTING_LAMBDA_FUNCTION_NAME', 'EXISTING_AUTHORIZER_LAMBDA_ARN', 'EXISTING_AUTHORIZER_FUNCTION_NAME'],
  'http-iam':        ['EXISTING_LAMBDA_ARN', 'EXISTING_LAMBDA_FUNCTION_NAME'],
  'rest-usage-plan': ['EXISTING_LAMBDA_ARN', 'EXISTING_LAMBDA_FUNCTION_NAME'],
};

function checkEnvVars(apiType) {
  const required = REQUIRED_ENV_VARS[apiType] ?? [];
  return required.filter(v => !process.env[v]);
}

const VALID_API_TYPES    = Object.keys(provisioners);
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const VALID_ENVIRONMENTS = ['dev', 'sit', 'stage', 'prod'];
const API_NAME_REGEX     = /^[a-z][a-z0-9-]{2,28}[a-z0-9]$/;

function validate(body) {
  const errors = [];
  if (!body.api_name)                                  errors.push('api_name is required');
  if (body.api_name && !API_NAME_REGEX.test(body.api_name))
    errors.push('api_name must be lowercase letters, numbers, hyphens (4-30 chars)');
  if (!VALID_API_TYPES.includes(body.api_type))        errors.push(`api_type must be one of: ${VALID_API_TYPES.join(', ')}`);
  if (!VALID_HTTP_METHODS.includes(body.http_method))  errors.push(`http_method must be one of: ${VALID_HTTP_METHODS.join(', ')}`);
  if (!body.route_path?.startsWith('/'))               errors.push('route_path must start with /');
  if (!VALID_ENVIRONMENTS.includes(body.environment))  errors.push(`environment must be one of: ${VALID_ENVIRONMENTS.join(', ')}`);
  return errors;
}

const CORS = {
  'Access-Control-Allow-Origin':  process.env.CORS_ALLOWED_ORIGIN ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function ok(body, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(body, null, 2) };
}

function err(message, status = 400, details = null) {
  return { statusCode: status, headers: CORS, body: JSON.stringify({ error: message, details }) };
}

async function serializeAwsError(e) {
  const SKIP_NAMES = new Set(['Unknown', 'Error', 'UnknownError']);
  const code = (e.name && !SKIP_NAMES.has(e.name))
    ? e.name
    : (e.Code || e.code || e.__type || e.name || 'UnknownError');

  const GENERIC = new Set(['Unknown', 'UnknownError', 'undefined', '']);

  let bodyRaw = null;
  let bodyJson = null;
  try {
    // e.bodyRaw is pre-read by the apigw middleware in base.js (stream already consumed).
    // Fall back to e.$response?.body only if bodyRaw wasn't captured.
    const rawBody = e.bodyRaw ?? e.$response?.body;
    if (rawBody) {
      if (typeof rawBody === 'string')                          bodyRaw = rawBody;
      else if (Buffer.isBuffer(rawBody))                        bodyRaw = rawBody.toString('utf8');
      else if (ArrayBuffer.isView(rawBody))                     bodyRaw = Buffer.from(rawBody).toString('utf8');
      else if (typeof rawBody.transformToString === 'function') bodyRaw = await rawBody.transformToString('utf8');
      else if (typeof rawBody.text === 'function')              bodyRaw = await rawBody.text();

      if (bodyRaw) {
        try { bodyJson = JSON.parse(bodyRaw); } catch { /* not JSON */ }
      }
    }
  } catch (bodyErr) {
    console.warn('[serializeAwsError] could not read response body:', bodyErr?.message);
  }

  const bodyMessage = bodyJson
    ? (bodyJson.message || bodyJson.Message || bodyJson.errorMessage || bodyJson.__type || null)
    : (bodyRaw ? bodyRaw.substring(0, 500) : null);

  const bodyCode    = bodyJson ? (bodyJson.code || bodyJson.Code || bodyJson.__type || null) : null;
  const finalCode   = (code !== 'Unknown' && code !== 'UnknownError') ? code : (bodyCode || code);

  const message =
    (!GENERIC.has(e.message) ? e.message : null) ||
    bodyMessage ||
    e.Error?.Message || e.Message || e.errorMessage || e.detail ||
    (!GENERIC.has(finalCode) ? `AWS error: ${finalCode}` : 'Provisioning failed — check CloudWatch logs for details');

  const diag = {
    name: e.name, message: e.message, code: finalCode,
    httpStatus: e.$metadata?.httpStatusCode, requestId: e.$metadata?.requestId,
    fault: e.$fault, bodyRaw: bodyRaw ? bodyRaw.substring(0, 1000) : null, bodyJson,
  };
  console.error('[serializeAwsError] diagnostic:', JSON.stringify(diag));
  try {
    const safeProps = Object.getOwnPropertyNames(e).filter(k => k !== '$response');
    console.error('[serializeAwsError] full error props:', JSON.stringify(Object.fromEntries(safeProps.map(k => [k, e[k]]))));
  } catch { /* non-serializable */ }

  return {
    code:       finalCode,
    message,
    httpStatus: e.$metadata?.httpStatusCode ?? null,
    requestId:  e.$metadata?.requestId      ?? null,
    fault:      e.$fault                    ?? null,
    stack:      e.stack                     ?? null,
    ...(bodyJson?.code && { awsCode:    bodyJson.code }),
    ...(e.detail       && { detail:     e.detail }),
    ...(e.reason       && { reason:     e.reason }),
    ...(e.OAuthError   && { OAuthError: e.OAuthError }),
  };
}

exports.handler = async (event) => {
  const method  = event.requestContext?.http?.method;
  const path    = event.requestContext?.http?.path;
  const apiName = event.pathParameters?.api_name;

  console.log(`[handler] ${method} ${path}`);

  try {
    if (method === 'POST' && path === '/apis') {
      const body   = JSON.parse(event.body ?? '{}');
      const errors = validate(body);
      if (errors.length) return err('Validation failed', 400, errors);

      const existing = await db.getApi(body.api_name);
      if (existing) return err(`API '${body.api_name}' already exists. Use DELETE to remove it first.`, 409);

      const missingVars = checkEnvVars(body.api_type);
      if (missingVars.length) {
        return err(`Missing required environment variables for ${body.api_type}: ${missingVars.join(', ')}`, 500);
      }

      await db.saveApi({
        api_name: body.api_name, api_type: body.api_type,
        environment: body.environment, route_path: body.route_path,
        http_method: body.http_method, partner_name: body.partner_name ?? null,
        status: 'CREATING',
      });

      const provisioner = provisioners[body.api_type];
      let result;
      try {
        result = await provisioner.create({
          apiName:            body.api_name,
          environment:        body.environment,
          routePath:          body.route_path,
          httpMethod:         body.http_method,
          partnerName:        body.partner_name ?? 'partner',
          quotaPerDay:        body.quota_per_day ?? 5000,
          rateLimitPerSecond: body.rate_limit_per_second ?? 50,
          onApiCreated: async (apiId) => {
            await db.updateStatus(body.api_name, 'CREATING', { api_id: apiId });
          },
        });
      } catch (provisionError) {
        const errDetail = await serializeAwsError(provisionError);
        await db.updateStatus(body.api_name, 'FAILED', {
          error_message: errDetail.message,
          error_code:    errDetail.code    ?? null,
          error_status:  errDetail.httpStatus ? String(errDetail.httpStatus) : null,
          error_req_id:  errDetail.requestId  ?? null,
        });
        console.error('[handler] Provisioning failed:', provisionError);
        return err('Provisioning failed', 500, errDetail);
      }

      const resources = result.resources ?? {};
      await db.updateStatus(body.api_name, 'ACTIVE', {
        api_id: result.api_id, api_endpoint: result.api_endpoint,
        route_url: result.route_url, resources: JSON.stringify(resources),
        test_hint: result.test_hint ?? null,
        api_key_id: result.api_key_id ?? null,
        usage_plan_id: result.usage_plan_id ?? null,
        partner_name: result.partner_name ?? body.partner_name ?? null,
        cognito_pool_id:   resources.cognito_pool_id   ?? null,
        cognito_client_id: resources.cognito_client_id ?? null,
      });

      return ok({
        message: `API '${body.api_name}' created successfully`,
        api_name: body.api_name, api_type: body.api_type,
        route_url: result.route_url, api_endpoint: result.api_endpoint,
        test_hint: result.test_hint,
      }, 201);
    }

    if (method === 'GET' && path === '/apis') {
      const items = await db.listApis();
      return ok({ count: items.length, apis: items });
    }

    if (method === 'GET' && apiName) {
      const item = await db.getApi(apiName);
      if (!item) return err(`API '${apiName}' not found`, 404);
      return ok(item);
    }

    if (method === 'POST' && path.endsWith('/force-clear') && apiName) {
      const item = await db.getApi(apiName);
      if (!item) return err(`API '${apiName}' not found`, 404);
      if (item.status !== 'DELETE_FAILED' && item.status !== 'FAILED') {
        return err(`Force clear only allowed for DELETE_FAILED or FAILED status (current: ${item.status})`, 400);
      }
      await db.deleteApi(apiName);
      return ok({ message: `API '${apiName}' force-cleared from registry.` });
    }

    if (method === 'DELETE' && apiName) {
      const item = await db.getApi(apiName);
      if (!item) return err(`API '${apiName}' not found`, 404);
      if (item.status === 'DELETING') return err(`API '${apiName}' is already being deleted`, 409);
      if (!['ACTIVE', 'FAILED', 'DELETE_FAILED'].includes(item.status)) {
        return err(`Cannot delete API with status '${item.status}'`, 400);
      }

      await db.updateStatus(apiName, 'DELETING');
      const provisioner = provisioners[item.api_type];
      try {
        await provisioner.destroy({
          api_id: item.api_id, api_name: item.api_name,
          environment: item.environment,
          resources: item.resources ? JSON.parse(item.resources) : {},
        });
      } catch (destroyError) {
        const errDetail = await serializeAwsError(destroyError);
        await db.updateStatus(apiName, 'DELETE_FAILED', {
          error_message: errDetail.message,
          error_code:    errDetail.code    ?? null,
          error_status:  errDetail.httpStatus ? String(errDetail.httpStatus) : null,
          error_req_id:  errDetail.requestId  ?? null,
        });
        console.error('[handler] Destroy failed:', destroyError);
        return err('Destroy failed', 500, errDetail);
      }

      await db.deleteApi(apiName);
      return ok({ message: `API '${apiName}' and all its AWS resources have been deleted` });
    }

    // ── Mock backend catch-all (DEV ONLY) ────────────────────────────────────
    // Only active when EXISTING_LAMBDA_ARN falls back to this gui-lambda itself.
    // Remove this block once a real backend Lambda is deployed and its ARN is
    // published to SSM at /api-portal/{env}/lambda/arn.
    if (!path?.startsWith('/apis')) {
      console.log(`[handler] mock-backend hit: ${method} ${path}`);
      return ok({
        message:     '✅ API Portal — mock backend response (dev fallback)',
        note:        'Deploy a real backend Lambda and publish its ARN to SSM at /api-portal/dev/lambda/arn, then re-run the backend deploy workflow to remove this fallback.',
        request: {
          method,
          path,
          queryStringParameters: event.queryStringParameters ?? null,
          headers: {
            'user-agent':   event.headers?.['user-agent']    ?? null,
            'content-type': event.headers?.['content-type']  ?? null,
          },
          body: event.body ? (() => { try { return JSON.parse(event.body); } catch { return event.body; } })() : null,
        },
        environment: process.env.ENVIRONMENT ?? 'unknown',
        timestamp:   new Date().toISOString(),
      });
    }

    return err('Route not found', 404);

  } catch (e) {
    console.error('[handler] Unhandled error:', e);
    return err('Internal server error', 500, await serializeAwsError(e));
  }
};



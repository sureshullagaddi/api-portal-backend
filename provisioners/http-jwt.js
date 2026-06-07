'use strict';

const https = require('https');
const { createHttpApiBase, deleteHttpApiBase, apigw, CreateRouteCommand, enableAutoDeployAndDeploy } = require('./base');

const REGION = process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION;

// ── Raw SigV4-signed HTTPS call for CreateAuthorizer ─────────────────────────
// Bypasses the SDK — CLI test confirmed the raw API call works fine with these
// exact params. SDK 3.x swallows the 400 response body masking the real error.
async function createJwtAuthorizerRaw({ apiId, name, issuer, audience, identitySource, logTag }) {
  const { SignatureV4 } = require('@smithy/signature-v4');
  const { Hash }        = require('@smithy/hash-node');

  // Resolve credentials (config.credentials is a provider function, must be called)
  const creds    = await apigw.config.credentials();
  const hostname = `apigateway.${REGION}.amazonaws.com`;
  const path     = `/v2/apis/${apiId}/authorizers`;

  const bodyStr = JSON.stringify({
    authorizerType:   'JWT',
    identitySource,
    jwtConfiguration: { audience, issuer },
    name,
  });

  const signer = new SignatureV4({
    credentials: creds,          // pass resolved object, not the provider function
    region:      REGION,
    service:     'apigateway',
    sha256:      Hash.bind(null, 'sha256'),
  });

  // Build headers — always include x-amz-security-token for Lambda's temp credentials
  const inputHeaders = {
    host:             hostname,
    'content-type':   'application/json',
    'content-length': String(Buffer.byteLength(bodyStr)),
  };
  if (creds.sessionToken) {
    inputHeaders['x-amz-security-token'] = creds.sessionToken;
  }
  console.log(`${logTag} raw CreateAuthorizer — sessionToken present: ${!!creds.sessionToken}`);

  const signed = await signer.sign({
    method:   'POST',
    protocol: 'https:',
    hostname,
    path,
    headers:  inputHeaders,
    body:     bodyStr,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers: signed.headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`${logTag} raw CreateAuthorizer → HTTP ${res.statusCode} | body: ${data || '(empty)'}`);
        if (res.statusCode === 201) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Created (201) but failed to parse response: ${data}`)); }
        } else {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* not JSON */ }
          const msg = parsed?.message || parsed?.Message || data || `HTTP ${res.statusCode}`;
          reject(Object.assign(new Error(msg), {
            name:       String(res.statusCode),
            httpStatus: res.statusCode,
            bodyRaw:    data,
            bodyJson:   parsed,
          }));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function validateCognitoIssuer(issuer, poolId, logTag) {
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  console.log(`${logTag} pre-flight: validating ${discoveryUrl}`);

  return new Promise((resolve, reject) => {
    const req = https.get(discoveryUrl, { timeout: 6000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        console.log(`${logTag} pre-flight: pool valid (HTTP 200)`);
        resolve();
      } else {
        reject(Object.assign(new Error(
          `Cognito pool not found — OIDC endpoint returned HTTP ${res.statusCode}. ` +
          `Pool ID '${poolId}' in region '${REGION}'.`
        ), { name: 'CognitoPoolNotFound' }));
      }
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error(`Cognito OIDC timed out. Pool: '${poolId}'`), { name: 'CognitoPoolTimeout' })); });
    req.on('error',   (err) => reject(Object.assign(new Error(`Cognito OIDC unreachable: ${err.message}`), { name: 'CognitoPoolUnreachable' })));
  });
}

async function create({ apiName, environment, routePath, httpMethod, onApiCreated }) {
  let _apiId = null;
  const tag = () => `[http-jwt|${apiName}-${environment}|apiId=${_apiId ?? 'pending'}]`;

  const poolId   = process.env.EXISTING_COGNITO_POOL_ID;
  const clientId = process.env.EXISTING_COGNITO_CLIENT_ID;
  const issuer   = `https://cognito-idp.${REGION}.amazonaws.com/${poolId}`;

  console.log(`${tag()} create start | region=${REGION}`);
  console.log(`${tag()} env vars | COGNITO_POOL_ID=${poolId} CLIENT_ID=${clientId}`);

  if (!poolId || poolId === 'undefined') throw Object.assign(new Error(`EXISTING_COGNITO_POOL_ID not set`), { name: 'MissingCognitoPoolId' });
  if (!clientId || clientId === 'undefined') throw Object.assign(new Error(`EXISTING_COGNITO_CLIENT_ID not set`), { name: 'MissingCognitoClientId' });

  await validateCognitoIssuer(issuer, poolId, tag());

  const base = await createHttpApiBase(apiName, environment,
    `JWT-protected HTTP API — Cognito auth, ${httpMethod} ${routePath}`, { onApiCreated });
  _apiId = base.apiId;

  const safeAudience = [clientId].filter(Boolean);

  // Step 6 — Create JWT authorizer via raw signed HTTPS (same call the CLI makes successfully)
  console.log(`${tag()} step 6 — CreateAuthorizer (raw HTTPS) issuer=${issuer}`);
  const authorizerResult = await createJwtAuthorizerRaw({
    apiId:          base.apiId,
    name:           `${apiName}-${environment}-jwt-authorizer`,
    issuer,
    audience:       safeAudience,
    identitySource: '$request.header.Authorization',
    logTag:         tag(),
  });
  const authorizerId = authorizerResult.authorizerId;
  console.log(`${tag()} step 6 done | authorizerId=${authorizerId}`);

  // Step 7 — Create route with JWT auth
  await apigw.send(new CreateRouteCommand({
    ApiId:             base.apiId,
    RouteKey:          `${httpMethod} ${routePath}`,
    AuthorizationType: 'JWT',
    AuthorizerId:      authorizerId,
    Target:            `integrations/${base.integrationId}`,
  }));
  console.log(`${tag()} step 7 done`);

  // Step 8 — Enable AutoDeploy and deploy
  await enableAutoDeployAndDeploy(base.apiId, tag());

  return {
    api_id:        base.apiId,
    api_endpoint:  base.apiEndpoint,
    route_url:     `${base.apiEndpoint}${routePath}`,
    authorizer_id: authorizerId,
    resources: {
      api_id: base.apiId, authorizer_id: authorizerId,
      log_group: base.logGroupName, cognito_pool_id: poolId, cognito_client_id: clientId,
    },
    test_hint: 'Get an IdToken from Cognito and send as: Authorization: Bearer <IdToken>',
  };
}

async function destroy({ api_id, api_name, environment }) {
  console.log(`[http-jwt|${api_name}-${environment}|apiId=${api_id}] destroy start`);
  await deleteHttpApiBase(api_id, api_name, environment);
  console.log(`[http-jwt|${api_name}-${environment}|apiId=${api_id}] destroy complete`);
}

module.exports = { create, destroy };

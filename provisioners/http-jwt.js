'use strict';

const https = require('https');
const { createHttpApiBase, deleteHttpApiBase, apigw, CreateRouteCommand, CreateAuthorizerCommand, enableAutoDeployAndDeploy } = require('./base');

const REGION = process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION;

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
        const e = new Error(
          `Cognito pool not found — OIDC endpoint returned HTTP ${res.statusCode}. ` +
          `Pool ID '${poolId}' in region '${REGION}'. URL: ${discoveryUrl}`
        );
        e.name = 'CognitoPoolNotFound';
        reject(e);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      const e = new Error(`Cognito OIDC endpoint timed out (6s). Pool: '${poolId}' URL: ${discoveryUrl}`);
      e.name = 'CognitoPoolTimeout';
      reject(e);
    });
    req.on('error', (err) => {
      const e = new Error(`Cognito OIDC endpoint unreachable: ${err.message}. Pool: '${poolId}'`);
      e.name = 'CognitoPoolUnreachable';
      reject(e);
    });
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
  console.log(`${tag()} jwt config | issuer=${issuer} audience=["${clientId}"]`);

  if (!poolId || poolId === 'undefined') throw Object.assign(
    new Error(`EXISTING_COGNITO_POOL_ID not set (got: '${poolId}')`), { name: 'MissingCognitoPoolId' }
  );
  if (!clientId || clientId === 'undefined') throw Object.assign(
    new Error(`EXISTING_COGNITO_CLIENT_ID not set (got: '${clientId}')`), { name: 'MissingCognitoClientId' }
  );

  // Pre-flight: verify Cognito pool exists BEFORE creating any AWS resources
  await validateCognitoIssuer(issuer, poolId, tag());

  const base = await createHttpApiBase(apiName, environment,
    `JWT-protected HTTP API — Cognito auth, ${httpMethod} ${routePath}`, { onApiCreated });
  _apiId = base.apiId;
  console.log(`${tag()} base created | endpoint=${base.apiEndpoint}`);

  const safeAudience = [clientId].filter(Boolean);
  if (safeAudience.length === 0) throw Object.assign(
    new Error(`JWT audience is empty — EXISTING_COGNITO_CLIENT_ID='${clientId}'`), { name: 'EmptyJwtAudience' }
  );

  // Step 6 — Create JWT authorizer (stage AutoDeploy is OFF — no deployment lock)
  const authorizerInput = {
    ApiId:            base.apiId,
    Name:             `${apiName}-${environment}-jwt-authorizer`,
    AuthorizerType:   'JWT',
    IdentitySource:   '$request.header.Authorization',
    JwtConfiguration: { Issuer: issuer, Audience: safeAudience },
  };
  console.log(`${tag()} step 6 — CreateAuthorizer input:`, JSON.stringify(authorizerInput));
  const authorizer = await apigw.send(new CreateAuthorizerCommand(authorizerInput));
  console.log(`${tag()} step 6 done | authorizerId=${authorizer.AuthorizerId}`);

  // Step 7 — Create route
  await apigw.send(new CreateRouteCommand({
    ApiId:             base.apiId,
    RouteKey:          `${httpMethod} ${routePath}`,
    AuthorizationType: 'JWT',
    AuthorizerId:      authorizer.AuthorizerId,
    Target:            `integrations/${base.integrationId}`,
  }));
  console.log(`${tag()} step 7 done`);

  // Step 8 — Enable AutoDeploy and deploy (routes + authorizer are now in place)
  await enableAutoDeployAndDeploy(base.apiId, tag());

  return {
    api_id:        base.apiId,
    api_endpoint:  base.apiEndpoint,
    route_url:     `${base.apiEndpoint}${routePath}`,
    authorizer_id: authorizer.AuthorizerId,
    resources: {
      api_id: base.apiId, authorizer_id: authorizer.AuthorizerId,
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


'use strict';

const https = require('https');
const {
  createHttpApiBase, deleteHttpApiBase, apigw,
  CreateRouteCommand, CreateAuthorizerCommand, enableAutoDeployAndDeploy,
} = require('./base');
const { CreateStageCommand } = require('@aws-sdk/client-apigatewayv2');

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
        reject(Object.assign(new Error(
          `Cognito pool not found — OIDC endpoint returned HTTP ${res.statusCode}. Pool: '${poolId}'`
        ), { name: 'CognitoPoolNotFound' }));
      }
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error(`Cognito OIDC timed out`), { name: 'CognitoPoolTimeout' })); });
    req.on('error',   (err) => reject(Object.assign(new Error(`Cognito OIDC unreachable: ${err.message}`), { name: 'CognitoPoolUnreachable' })));
  });
}

async function create({ apiName, environment, routePath, httpMethod, onApiCreated }) {
  let _apiId = null;
  const tag = () => `[http-jwt|${apiName}-${environment}|apiId=${_apiId ?? 'pending'}]`;

  const poolId   = process.env.EXISTING_COGNITO_POOL_ID;
  const clientId = process.env.EXISTING_COGNITO_CLIENT_ID;
  const issuer   = `https://cognito-idp.${REGION}.amazonaws.com/${poolId}`;

  console.log(`${tag()} create start | region=${REGION} poolId=${poolId} clientId=${clientId}`);

  if (!poolId || poolId === 'undefined') throw Object.assign(new Error(`EXISTING_COGNITO_POOL_ID not set`), { name: 'MissingCognitoPoolId' });
  if (!clientId || clientId === 'undefined') throw Object.assign(new Error(`EXISTING_COGNITO_CLIENT_ID not set`), { name: 'MissingCognitoClientId' });

  await validateCognitoIssuer(issuer, poolId, tag());

  // skipStage=true: $default stage NOT created yet — JWT authorizer must be created
  // BEFORE the stage to avoid the AWS internal lock that returns 400 on CreateAuthorizer.
  const base = await createHttpApiBase(apiName, environment,
    `JWT-protected HTTP API — Cognito auth, ${httpMethod} ${routePath}`,
    { onApiCreated, skipStage: true });
  _apiId = base.apiId;
  console.log(`${tag()} base created (no stage yet) | endpoint=${base.apiEndpoint}`);

  // Step 6 — Create JWT authorizer BEFORE stage (avoids AWS internal lock → 400)
  const authorizerInput = {
    ApiId:            base.apiId,
    Name:             `${apiName}-${environment}-jwt-authorizer`,
    AuthorizerType:   'JWT',
    IdentitySource:   '$request.header.Authorization',
    JwtConfiguration: {
      Issuer:   issuer,
      Audience: [clientId],
    },
  };
  console.log(`${tag()} step 6 — CreateAuthorizer | issuer=${issuer}`);
  const authorizer = await apigw.send(new CreateAuthorizerCommand(authorizerInput));
  console.log(`${tag()} step 6 done | authorizerId=${authorizer.AuthorizerId}`);

  // Step 7 — Now create the $default stage (safe — authorizer already exists)
  await apigw.send(new CreateStageCommand({
    ApiId: base.apiId, StageName: '$default', AutoDeploy: false,
  }));
  console.log(`${tag()} step 7 done — stage created`);

  // Step 8 — Create route with JWT auth
  await apigw.send(new CreateRouteCommand({
    ApiId:             base.apiId,
    RouteKey:          `${httpMethod} ${routePath}`,
    AuthorizationType: 'JWT',
    AuthorizerId:      authorizer.AuthorizerId,
    Target:            `integrations/${base.integrationId}`,
  }));
  console.log(`${tag()} step 8 done — route created`);

  // Step 9 — Enable AutoDeploy and deploy
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

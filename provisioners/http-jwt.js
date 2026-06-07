'use strict';

const https = require('https');
const {
  apigw, lambda, logs,
  getAccountId, buildIntegrationUri,
  deleteHttpApiBase, enableAutoDeployAndDeploy,
  CreateRouteCommand, CreateAuthorizerCommand,
  AddPermissionCommand,
} = require('./base');

const {
  CreateApiCommand,
  CreateIntegrationCommand,
  CreateStageCommand,
} = require('@aws-sdk/client-apigatewayv2');

const { CreateLogGroupCommand, PutRetentionPolicyCommand } = require('@aws-sdk/client-cloudwatch-logs');

const REGION = process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION;

function validateCognitoIssuer(issuer, poolId, logTag) {
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  console.log(`${logTag} pre-flight: validating ${discoveryUrl}`);
  return new Promise((resolve, reject) => {
    const req = https.get(discoveryUrl, { timeout: 6000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) { console.log(`${logTag} pre-flight OK`); resolve(); }
      else reject(Object.assign(new Error(`Cognito OIDC returned ${res.statusCode}. Pool: '${poolId}'`), { name: 'CognitoPoolNotFound' }));
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('Cognito OIDC timed out'), { name: 'CognitoPoolTimeout' })); });
    req.on('error', (e) => reject(Object.assign(new Error(`Cognito OIDC error: ${e.message}`), { name: 'CognitoPoolUnreachable' })));
  });
}

async function create({ apiName, environment, routePath, httpMethod, onApiCreated }) {
  const tag = (apiId) => `[http-jwt|${apiName}-${environment}|apiId=${apiId ?? 'pending'}]`;

  const poolId   = process.env.EXISTING_COGNITO_POOL_ID;
  const clientId = process.env.EXISTING_COGNITO_CLIENT_ID;
  const issuer   = `https://cognito-idp.${REGION}.amazonaws.com/${poolId}`;

  if (!poolId || poolId === 'undefined') throw Object.assign(new Error('EXISTING_COGNITO_POOL_ID not set'), { name: 'MissingCognitoPoolId' });
  if (!clientId || clientId === 'undefined') throw Object.assign(new Error('EXISTING_COGNITO_CLIENT_ID not set'), { name: 'MissingCognitoClientId' });

  console.log(`${tag()} create start | region=${REGION} pool=${poolId}`);
  await validateCognitoIssuer(issuer, poolId, tag());

  // Step 1 — Create API
  const api = await apigw.send(new CreateApiCommand({
    Name: `${apiName}-${environment}-api`, ProtocolType: 'HTTP',
    Description: `JWT-protected HTTP API — Cognito auth, ${httpMethod} ${routePath}`,
  }));
  const apiId = api.ApiId;
  if (onApiCreated) await onApiCreated(apiId);
  console.log(`${tag(apiId)} step 1 done — endpoint=${api.ApiEndpoint}`);

  // Step 2 — Create JWT authorizer IMMEDIATELY after API (before integration/stage)
  // This is the exact order the CLI uses and it works. Integration creation puts
  // the API into an internal "updating" state that blocks CreateAuthorizer.
  const authorizer = await apigw.send(new CreateAuthorizerCommand({
    ApiId:            apiId,
    Name:             `${apiName}-${environment}-jwt-authorizer`,
    AuthorizerType:   'JWT',
    IdentitySource:   '$request.header.Authorization',
    JwtConfiguration: { Issuer: issuer, Audience: [clientId] },
  }));
  console.log(`${tag(apiId)} step 2 done — authorizerId=${authorizer.AuthorizerId}`);

  // Step 3 — Integration
  const integrationUri = buildIntegrationUri(process.env.EXISTING_LAMBDA_ARN);
  const integration = await apigw.send(new CreateIntegrationCommand({
    ApiId: apiId, IntegrationType: 'AWS_PROXY',
    IntegrationUri: integrationUri, PayloadFormatVersion: '2.0',
  }));
  console.log(`${tag(apiId)} step 3 done — integrationId=${integration.IntegrationId}`);

  // Step 4 — Stage
  await apigw.send(new CreateStageCommand({ ApiId: apiId, StageName: '$default', AutoDeploy: false }));
  console.log(`${tag(apiId)} step 4 done — stage created`);

  // Step 5 — Log group
  const logGroupName = `/aws/apigateway/${apiName}-${environment}-api`;
  try { await logs.send(new CreateLogGroupCommand({ logGroupName })); }
  catch (e) { if (e.name !== 'ResourceAlreadyExistsException') throw e; }
  try { await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: 14 })); } catch {}
  console.log(`${tag(apiId)} step 5 done — log group`);

  // Step 6 — Lambda permission
  const accountId = await getAccountId();
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: process.env.EXISTING_LAMBDA_FUNCTION_NAME,
      StatementId:  `AllowAPIGW-${apiName}-${environment}`,
      Action:       'lambda:InvokeFunction',
      Principal:    'apigateway.amazonaws.com',
      SourceArn:    `arn:aws:execute-api:${REGION}:${accountId}:${apiId}/*/*`,
    }));
  } catch (e) { if (e.name !== 'ResourceConflictException') throw e; }
  console.log(`${tag(apiId)} step 6 done — lambda permission`);

  // Step 7 — Route (JWT protected)
  await apigw.send(new CreateRouteCommand({
    ApiId: apiId, RouteKey: `${httpMethod} ${routePath}`,
    AuthorizationType: 'JWT', AuthorizerId: authorizer.AuthorizerId,
    Target: `integrations/${integration.IntegrationId}`,
  }));
  console.log(`${tag(apiId)} step 7 done — route created`);

  // Step 8 — Enable AutoDeploy + deploy
  await enableAutoDeployAndDeploy(apiId, tag(apiId));

  return {
    api_id: apiId, api_endpoint: api.ApiEndpoint,
    route_url: `${api.ApiEndpoint}${routePath}`,
    authorizer_id: authorizer.AuthorizerId,
    resources: { api_id: apiId, authorizer_id: authorizer.AuthorizerId, log_group: logGroupName, cognito_pool_id: poolId, cognito_client_id: clientId },
    test_hint: 'Get an IdToken from Cognito and send as: Authorization: Bearer <IdToken>',
  };
}

async function destroy({ api_id, api_name, environment }) {
  console.log(`[http-jwt|${api_name}-${environment}|apiId=${api_id}] destroy start`);
  await deleteHttpApiBase(api_id, api_name, environment);
  console.log(`[http-jwt|${api_name}-${environment}|apiId=${api_id}] destroy complete`);
}

module.exports = { create, destroy };

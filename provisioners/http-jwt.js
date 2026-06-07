'use strict';

const https = require('https');
const {
  apigw, lambda, logs,
  getAccountId, buildIntegrationUri,
  deleteHttpApiBase, enableAutoDeployAndDeploy,
  CreateRouteCommand,
  AddPermissionCommand,
} = require('./base');

const {
  CreateApiCommand,
  CreateIntegrationCommand,
  CreateStageCommand,
} = require('@aws-sdk/client-apigatewayv2');

const { CreateLogGroupCommand, PutRetentionPolicyCommand } = require('@aws-sdk/client-cloudwatch-logs');

const REGION = process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION;

// ── Raw HTTPS CreateAuthorizer — uses Lambda env credentials directly ──────────
// SDK's CreateAuthorizerCommand returns empty-body 400 for JWT type (SDK bug).
// AWS CLI works because it reads AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN directly.
// We do exactly the same here.
async function createJwtAuthorizerRaw({ apiId, name, issuer, audience, identitySource, logTag }) {
  const { SignatureV4 } = require('@smithy/signature-v4');
  const { Hash }        = require('@smithy/hash-node');

  const accessKeyId     = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken    = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials not found in Lambda environment');
  console.log(`${logTag} raw CreateAuthorizer — keyId=${accessKeyId.slice(0, 8)}... sessionToken=${sessionToken ? 'present' : 'MISSING'}`);

  const hostname = `apigateway.${REGION}.amazonaws.com`;
  const path     = `/v2/apis/${apiId}/authorizers`;

  const bodyStr = JSON.stringify({
    authorizerType:   'JWT',
    identitySource:   [identitySource],   // must be an ARRAY — botocore/CLI sends array, Node SDK sends string (wrong)
    jwtConfiguration: { audience, issuer },
    name,
  });

  const signer = new SignatureV4({
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    region:      REGION,
    service:     'apigateway',
    sha256:      Hash.bind(null, 'sha256'),
  });

  const headers = {
    host:             hostname,
    'content-type':   'application/json',
    'content-length': String(Buffer.byteLength(bodyStr)),
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };

  const signed = await signer.sign({ method: 'POST', protocol: 'https:', hostname, path, headers, body: bodyStr });

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers: signed.headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`${logTag} raw CreateAuthorizer → HTTP ${res.statusCode} | body: ${data || '(empty)'}`);
        if (res.statusCode === 201) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`201 but parse failed: ${data}`)); }
        } else {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* not json */ }
          reject(Object.assign(new Error(parsed?.message || data || `HTTP ${res.statusCode}`), {
            name: String(res.statusCode), httpStatus: res.statusCode, bodyRaw: data, bodyJson: parsed,
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

  // Step 2 — Create JWT authorizer via raw HTTPS (same creds source as CLI)
  const authorizerResult = await createJwtAuthorizerRaw({
    apiId, name: `${apiName}-${environment}-jwt-authorizer`,
    issuer, audience: [clientId],
    identitySource: '$request.header.Authorization',
    logTag: tag(apiId),
  });
  const authorizerId = authorizerResult.authorizerId;
  console.log(`${tag(apiId)} step 2 done — authorizerId=${authorizerId}`);

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
  try { await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: 14 })); } catch { /* non-fatal */ }
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
    AuthorizationType: 'JWT', AuthorizerId: authorizerId,
    Target: `integrations/${integration.IntegrationId}`,
  }));
  console.log(`${tag(apiId)} step 7 done — route created`);

  // Step 8 — Enable AutoDeploy + deploy
  await enableAutoDeployAndDeploy(apiId, tag(apiId));

  return {
    api_id: apiId, api_endpoint: api.ApiEndpoint,
    route_url: `${api.ApiEndpoint}${routePath}`,
    authorizer_id: authorizerId,
    resources: { api_id: apiId, authorizer_id: authorizerId, log_group: logGroupName, cognito_pool_id: poolId, cognito_client_id: clientId },
    test_hint: 'Get an IdToken from Cognito and send as: Authorization: Bearer <IdToken>',
  };
}

async function destroy({ api_id, api_name, environment }) {
  console.log(`[http-jwt|${api_name}-${environment}|apiId=${api_id}] destroy start`);
  await deleteHttpApiBase(api_id, api_name, environment);
  console.log(`[http-jwt|${api_name}-${environment}|apiId=${api_id}] destroy complete`);
}

module.exports = { create, destroy };

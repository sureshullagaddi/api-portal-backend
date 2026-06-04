'use strict';

const {
  createHttpApiBase, deleteHttpApiBase, apigw, lambda, getAccountId,
  CreateRouteCommand, CreateAuthorizerCommand,
  AddPermissionCommand, RemovePermissionCommand,
  enableAutoDeployAndDeploy,
} = require('./base');

const REGION = process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION;

function buildAuthorizerUri(lambdaArn) {
  if (!lambdaArn) return lambdaArn;
  if (lambdaArn.startsWith('arn:aws:apigateway:')) return lambdaArn;
  return `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${lambdaArn}/invocations`;
}

async function create({ apiName, environment, routePath, httpMethod, onApiCreated }) {
  let _apiId = null;
  const tag = () => `[http-custom-key|${apiName}-${environment}|apiId=${_apiId ?? 'pending'}]`;
  console.log(`${tag()} create start | region=${REGION}`);

  const base = await createHttpApiBase(apiName, environment,
    `Custom Lambda authorizer HTTP API — X-Api-Key, ${httpMethod} ${routePath}`, { onApiCreated });
  _apiId = base.apiId;

  // Step 6 — authorizer Lambda permission
  const accountId     = await getAccountId();
  const authSourceArn = `arn:aws:execute-api:${REGION}:${accountId}:${base.apiId}/authorizers/*`;
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: process.env.EXISTING_AUTHORIZER_FUNCTION_NAME,
      StatementId:  `AllowAuthorizerAPIGW-${apiName}-${environment}`,
      Action:       'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com',
      SourceArn:    authSourceArn,
    }));
  } catch (e) {
    if (e.name === 'ResourceConflictException') console.log(`${tag()} authorizer permission already exists`);
    else throw e;
  }

  // Step 7 — Create REQUEST authorizer (stage AutoDeploy is OFF — no lock)
  const authorizerUri = buildAuthorizerUri(process.env.EXISTING_AUTHORIZER_LAMBDA_ARN);
  const authorizer = await apigw.send(new CreateAuthorizerCommand({
    ApiId:                          base.apiId,
    Name:                           `${apiName}-${environment}-lambda-authorizer`,
    AuthorizerType:                 'REQUEST',
    AuthorizerUri:                  authorizerUri,
    AuthorizerPayloadFormatVersion: '2.0',
    EnableSimpleResponses:          true,
    AuthorizerResultTtlInSeconds:   300,
    IdentitySource:                 '$request.header.X-Api-Key',
  }));
  console.log(`${tag()} step 7 done | authorizerId=${authorizer.AuthorizerId}`);

  // Step 8 — Create route
  await apigw.send(new CreateRouteCommand({
    ApiId: base.apiId, RouteKey: `${httpMethod} ${routePath}`,
    AuthorizationType: 'CUSTOM', AuthorizerId: authorizer.AuthorizerId,
    Target: `integrations/${base.integrationId}`,
  }));

  // Step 9 — Enable AutoDeploy and deploy now that routes + authorizer exist
  await enableAutoDeployAndDeploy(base.apiId, tag());

  return {
    api_id: base.apiId, api_endpoint: base.apiEndpoint,
    route_url: `${base.apiEndpoint}${routePath}`,
    authorizer_id: authorizer.AuthorizerId,
    resources: {
      api_id: base.apiId, authorizer_id: authorizer.AuthorizerId,
      authorizer_permission_id: `AllowAuthorizerAPIGW-${apiName}-${environment}`,
      log_group: base.logGroupName,
    },
    test_hint: 'Send header: X-Api-Key: <your-key>',
  };
}

async function destroy({ api_id, api_name, environment, resources }) {
  const tag = `[http-custom-key|${api_name}-${environment}|apiId=${api_id ?? 'unknown'}]`;
  const res = typeof resources === 'string' ? JSON.parse(resources) : (resources ?? {});

  try {
    await lambda.send(new RemovePermissionCommand({
      FunctionName: process.env.EXISTING_AUTHORIZER_FUNCTION_NAME,
      StatementId:  res.authorizer_permission_id ?? `AllowAuthorizerAPIGW-${api_name}-${environment}`,
    }));
  } catch (e) {
    console.warn(`${tag} authorizer permission remove (non-fatal): ${e.name}`);
  }

  await deleteHttpApiBase(res.api_id ?? api_id, api_name, environment);
  console.log(`${tag} destroy complete`);
}

module.exports = { create, destroy };


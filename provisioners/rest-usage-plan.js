'use strict';

const {
  APIGatewayClient, CreateRestApiCommand, GetResourcesCommand, CreateResourceCommand,
  PutMethodCommand, PutIntegrationCommand, CreateDeploymentCommand, CreateStageCommand,
  CreateUsagePlanCommand, CreateApiKeyCommand, CreateUsagePlanKeyCommand,
  DeleteRestApiCommand, DeleteApiKeyCommand, DeleteUsagePlanCommand,
} = require('@aws-sdk/client-api-gateway');

const { LambdaClient, AddPermissionCommand, RemovePermissionCommand } = require('@aws-sdk/client-lambda');
const { STSClient, GetCallerIdentityCommand }  = require('@aws-sdk/client-sts');
const { buildIntegrationUri, extractLambdaQualifier } = require('./base');

const REGION      = process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION;
const apigwV1     = new APIGatewayClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const stsClient    = new STSClient({ region: REGION });

let _accountId = null;
async function getAccountId() {
  if (!_accountId) {
    const res = await stsClient.send(new GetCallerIdentityCommand({}));
    _accountId = res.Account;
  }
  return _accountId;
}

async function create({ apiName, environment, routePath, httpMethod, partnerName, quotaPerDay, rateLimitPerSecond, onApiCreated }) {
  let _apiId = null;
  const tag = () => `[rest-usage-plan|${apiName}-${environment}|apiId=${_apiId ?? 'pending'}]`;
  console.log(`${tag()} create start | partner=${partnerName} quota=${quotaPerDay}/day rate=${rateLimitPerSecond}/s`);

  const api = await apigwV1.send(new CreateRestApiCommand({
    name: `${apiName}-${environment}-rest-api`,
    description: `REST API — ${partnerName} partner, ${quotaPerDay} req/day`,
    endpointConfiguration: { types: ['REGIONAL'] },
  }));
  _apiId = api.id;
  if (onApiCreated) await onApiCreated(api.id);

  const resources = await apigwV1.send(new GetResourcesCommand({ restApiId: api.id }));
  const rootId    = resources.items.find(r => r.path === '/').id;

  const pathParts = routePath.replace(/^\//, '').split('/');
  let parentId = rootId, lastResourceId = rootId;
  for (const part of pathParts) {
    const r = await apigwV1.send(new CreateResourceCommand({ restApiId: api.id, parentId, pathPart: part }));
    parentId = r.id; lastResourceId = r.id;
  }

  await apigwV1.send(new PutMethodCommand({
    restApiId: api.id, resourceId: lastResourceId,
    httpMethod, authorizationType: 'NONE', apiKeyRequired: true,
  }));

  const integrationUri = buildIntegrationUri(process.env.EXISTING_LAMBDA_ARN);
  await apigwV1.send(new PutIntegrationCommand({
    restApiId: api.id, resourceId: lastResourceId, httpMethod,
    type: 'AWS_PROXY', integrationHttpMethod: 'POST', uri: integrationUri,
  }));

  const deployment = await apigwV1.send(new CreateDeploymentCommand({ restApiId: api.id }));
  await apigwV1.send(new CreateStageCommand({
    restApiId: api.id, stageName: environment, deploymentId: deployment.id,
  }));

  const usagePlan = await apigwV1.send(new CreateUsagePlanCommand({
    name:      `${apiName}-${environment}-${partnerName}-plan`,
    description: `${partnerName} — ${quotaPerDay} req/day, ${rateLimitPerSecond} req/s`,
    apiStages: [{ apiId: api.id, stage: environment }],
    quota:     { limit: Number(quotaPerDay), period: 'DAY' },
    throttle:  { rateLimit: Number(rateLimitPerSecond), burstLimit: Number(rateLimitPerSecond) * 2 },
  }));

  const apiKey = await apigwV1.send(new CreateApiKeyCommand({
    name: `${apiName}-${environment}-${partnerName}-key`, enabled: true,
  }));

  await apigwV1.send(new CreateUsagePlanKeyCommand({
    usagePlanId: usagePlan.id, keyId: apiKey.id, keyType: 'API_KEY',
  }));

  const accountId = await getAccountId();
  const sourceArn = `arn:aws:execute-api:${REGION}:${accountId}:${api.id}/*/*`;
  try {
    await lambdaClient.send(new AddPermissionCommand({
      FunctionName: process.env.EXISTING_LAMBDA_FUNCTION_NAME,
      StatementId:  `AllowRESTAPIGW-${apiName}-${environment}`,
      Action:       'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com',
      SourceArn:    sourceArn,
    }));
  } catch (e) {
    if (e.name !== 'ResourceConflictException') throw e;
  }

  const apiEndpoint = `https://${api.id}.execute-api.${REGION}.amazonaws.com/${environment}`;
  return {
    api_id: api.id, api_endpoint: apiEndpoint,
    route_url: `${apiEndpoint}${routePath}`,
    api_key_id: apiKey.id, usage_plan_id: usagePlan.id, partner_name: partnerName,
    resources: { rest_api_id: api.id, api_key_id: apiKey.id, usage_plan_id: usagePlan.id },
    test_hint: `Get key from AWS Console → API Gateway → API Keys → ${apiName}-${environment}-${partnerName}-key. Send as x-api-key header.`,
  };
}

async function destroy({ api_id, api_name, environment, resources }) {
  const tag = `[rest-usage-plan|${api_name}-${environment}|apiId=${api_id ?? 'unknown'}]`;
  const res = typeof resources === 'string' ? JSON.parse(resources) : (resources ?? {});

  const restApiId   = res.rest_api_id   ?? api_id;
  const apiKeyId    = res.api_key_id    ?? null;
  const usagePlanId = res.usage_plan_id ?? null;

  const qualifier = extractLambdaQualifier(process.env.EXISTING_LAMBDA_ARN);
  try {
    await lambdaClient.send(new RemovePermissionCommand({
      FunctionName: process.env.EXISTING_LAMBDA_FUNCTION_NAME,
      StatementId:  `AllowRESTAPIGW-${api_name}-${environment}`,
      ...(qualifier && { Qualifier: qualifier }),
    }));
  } catch (e) { console.warn(`${tag} Lambda permission remove (non-fatal): ${e.name}`); }

  if (apiKeyId) {
    try { await apigwV1.send(new DeleteApiKeyCommand({ apiKey: apiKeyId })); }
    catch (e) { console.warn(`${tag} API key delete (non-fatal): ${e.name}`); }
  }

  if (usagePlanId) {
    try { await apigwV1.send(new DeleteUsagePlanCommand({ usagePlanId })); }
    catch (e) { console.warn(`${tag} usage plan delete (non-fatal): ${e.name}`); }
  }

  if (restApiId) {
    try { await apigwV1.send(new DeleteRestApiCommand({ restApiId })); }
    catch (e) { console.warn(`${tag} REST API delete (non-fatal): ${e.name}`); }
  }

  console.log(`${tag} destroy complete`);
}

module.exports = { create, destroy };


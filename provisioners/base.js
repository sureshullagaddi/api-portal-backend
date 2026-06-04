'use strict';

const {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateStageCommand,
  CreateDeploymentCommand,
  CreateAuthorizerCommand,
  DeleteApiCommand,
} = require('@aws-sdk/client-apigatewayv2');

const { LambdaClient, AddPermissionCommand, RemovePermissionCommand } = require('@aws-sdk/client-lambda');
const { CloudWatchLogsClient, CreateLogGroupCommand, PutRetentionPolicyCommand, DeleteLogGroupCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

const REGION = process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION;

// ── Normalise Lambda ARN to unqualified API GW invoke URI ─────────────────────
function buildIntegrationUri(lambdaArn) {
  if (!lambdaArn) return lambdaArn;
  let base = lambdaArn;
  if (lambdaArn.startsWith('arn:aws:apigateway:')) {
    const m = lambdaArn.match(/^arn:aws:apigateway:[^:]+:lambda:path\/2015-03-31\/functions\/(.+)\/invocations$/);
    if (m) base = m[1];
    else { console.warn('[base] buildIntegrationUri: unrecognised invoke-ARN, passing through'); return lambdaArn; }
  }
  const parts    = base.split(':');
  const cleanArn = parts.length === 8 ? parts.slice(0, 7).join(':') : base;
  const region   = parts[3];
  if (region && region !== REGION) {
    console.warn(`[base] buildIntegrationUri: ARN region '${region}' ≠ REGION '${REGION}' — cross-region returns 400`);
  }
  const uri = `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${cleanArn}/invocations`;
  console.log(`[base] buildIntegrationUri: ...${lambdaArn.slice(-40)} → ${uri}`);
  return uri;
}

function extractLambdaQualifier(lambdaArn) {
  if (!lambdaArn) return undefined;
  const parts = lambdaArn.split(':');
  return parts.length === 8 ? parts[7] : undefined;
}

const apigw  = new ApiGatewayV2Client({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const logs   = new CloudWatchLogsClient({ region: REGION });
const sts    = new STSClient({ region: REGION });

// ── Raw HTTP error body interceptor ───────────────────────────────────────────
// Captures the response body the SDK would otherwise swallow, so CloudWatch
// always shows the real AWS error text (not just "Unknown: UnknownError").
apigw.middlewareStack.add(
  (next, context) => async (args) => {
    try {
      return await next(args);
    } catch (e) {
      if (e.$response) {
        try {
          const body = e.$response.body;
          let rawText = null;
          if (body && typeof body.transformToString === 'function') rawText = await body.transformToString('utf8');
          else if (body && typeof body.text === 'function')         rawText = await body.text();
          else if (typeof body === 'string')                        rawText = body;
          else if (Buffer.isBuffer(body))                           rawText = body.toString('utf8');
          console.error(`[apigw-middleware] HTTP ${e.$metadata?.httpStatusCode} body for ${context.commandName}:`, rawText ?? '(empty)');
          if (rawText && !e.bodyRaw) e.bodyRaw = rawText;
        } catch (readErr) {
          console.error('[apigw-middleware] could not read error body:', readErr?.message);
        }
      }
      throw e;
    }
  },
  { step: 'deserialize', name: 'rawErrorLogger', priority: 'low' }
);

let _accountId = null;
async function getAccountId() {
  if (!_accountId) {
    const res = await sts.send(new GetCallerIdentityCommand({}));
    _accountId = res.Account;
  }
  return _accountId;
}

/**
 * Creates the base HTTP API (v2) + Lambda integration.
 * Stage is created with AutoDeploy=FALSE intentionally — calling
 * enableAutoDeployAndDeploy() after routes/authorizers avoids the
 * AWS internal auto-deploy lock that causes CreateAuthorizer → 400.
 */
async function createHttpApiBase(apiName, environment, description, { onApiCreated } = {}) {
  let _apiId = null;
  const tag = () => `[base|${apiName}-${environment}|apiId=${_apiId ?? 'pending'}]`;

  console.log(`${tag()} start | region=${REGION} lambdaArn=${process.env.EXISTING_LAMBDA_ARN}`);

  // 1. Create API
  const api = await apigw.send(new CreateApiCommand({
    Name: `${apiName}-${environment}-api`, ProtocolType: 'HTTP', Description: description,
  }));
  _apiId = api.ApiId;
  console.log(`${tag()} step 1 done — endpoint=${api.ApiEndpoint}`);
  if (onApiCreated) await onApiCreated(api.ApiId);

  // 2. Integration
  const integrationUri = buildIntegrationUri(process.env.EXISTING_LAMBDA_ARN);
  const integration = await apigw.send(new CreateIntegrationCommand({
    ApiId: api.ApiId, IntegrationType: 'AWS_PROXY',
    IntegrationUri: integrationUri, PayloadFormatVersion: '2.0',
  }));
  console.log(`${tag()} step 2 done — integrationId=${integration.IntegrationId}`);

  // 3. Stage — AutoDeploy: FALSE (avoids deployment lock during authorizer creation)
  await apigw.send(new CreateStageCommand({
    ApiId: api.ApiId, StageName: '$default', AutoDeploy: false,
  }));
  console.log(`${tag()} step 3 done — stage created (AutoDeploy=false, deploy triggered after routes)`);

  // 4. CloudWatch log group
  const logGroupName = `/aws/apigateway/${apiName}-${environment}-api`;
  try {
    await logs.send(new CreateLogGroupCommand({ logGroupName }));
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') throw e;
    console.log(`${tag()} step 4 — log group already exists`);
  }
  try {
    await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: 14 }));
  } catch (e) {
    console.warn(`${tag()} step 4 — retention (non-fatal): ${e.name}`);
  }
  console.log(`${tag()} step 4 done`);

  // 5. Lambda permission
  const accountId = await getAccountId();
  const sourceArn = `arn:aws:execute-api:${REGION}:${accountId}:${api.ApiId}/*/*`;
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: process.env.EXISTING_LAMBDA_FUNCTION_NAME,
      StatementId:  `AllowAPIGW-${apiName}-${environment}`,
      Action:       'lambda:InvokeFunction',
      Principal:    'apigateway.amazonaws.com',
      SourceArn:    sourceArn,
    }));
  } catch (e) {
    if (e.name === 'ResourceConflictException') console.log(`${tag()} step 5 — permission already exists`);
    else throw e;
  }
  console.log(`${tag()} step 5 done — base complete`);

  return { apiId: api.ApiId, integrationId: integration.IntegrationId, apiEndpoint: api.ApiEndpoint, logGroupName };
}

/**
 * Switches stage to AutoDeploy=true and triggers an explicit deployment.
 * Call this AFTER all routes and authorizers have been created.
 */
async function enableAutoDeployAndDeploy(apiId, logTag) {
  console.log(`${logTag} enableAutoDeployAndDeploy — updating stage + deploying`);
  await apigw.send(new CreateStageCommand({ ApiId: apiId, StageName: '$default', AutoDeploy: true }));
  const deployment = await apigw.send(new CreateDeploymentCommand({ ApiId: apiId, StageName: '$default' }));
  console.log(`${logTag} enableAutoDeployAndDeploy done — deploymentId=${deployment.DeploymentId}`);
}

async function deleteHttpApiBase(apiId, apiName, environment) {
  const tag = `[base|${apiName}-${environment}|apiId=${apiId ?? 'unknown'}]`;

  try {
    await lambda.send(new RemovePermissionCommand({
      FunctionName: process.env.EXISTING_LAMBDA_FUNCTION_NAME,
      StatementId:  `AllowAPIGW-${apiName}-${environment}`,
    }));
    console.log(`${tag} permission removed`);
  } catch (e) {
    console.warn(`${tag} permission remove (non-fatal): ${e.name}`);
  }

  if (!apiId) {
    console.warn(`${tag} no apiId — skipping DeleteApi`);
  } else {
    try {
      await apigw.send(new DeleteApiCommand({ ApiId: apiId }));
      console.log(`${tag} API deleted`);
    } catch (e) {
      if (e.name !== 'NotFoundException') throw e;
      console.warn(`${tag} API not found, already deleted`);
    }
  }

  const logGroupName = `/aws/apigateway/${apiName}-${environment}-api`;
  try {
    await logs.send(new DeleteLogGroupCommand({ logGroupName }));
    console.log(`${tag} log group deleted`);
  } catch (e) {
    console.warn(`${tag} log group delete (non-fatal): ${e.name}`);
  }
  console.log(`${tag} deleteHttpApiBase complete`);
}

module.exports = {
  apigw, lambda, logs,
  getAccountId, buildIntegrationUri, extractLambdaQualifier,
  createHttpApiBase, enableAutoDeployAndDeploy, deleteHttpApiBase,
  CreateRouteCommand, CreateAuthorizerCommand,
  AddPermissionCommand, RemovePermissionCommand,
};


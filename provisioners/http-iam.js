'use strict';

const { createHttpApiBase, deleteHttpApiBase, apigw, CreateRouteCommand, enableAutoDeployAndDeploy } = require('./base');

async function create({ apiName, environment, routePath, httpMethod, onApiCreated }) {
  let _apiId = null;
  const tag = () => `[http-iam|${apiName}-${environment}|apiId=${_apiId ?? 'pending'}]`;
  console.log(`${tag()} create start`);

  const base = await createHttpApiBase(apiName, environment,
    `AWS_IAM SigV4 HTTP API — ${httpMethod} ${routePath}`, { onApiCreated });
  _apiId = base.apiId;

  await apigw.send(new CreateRouteCommand({
    ApiId: base.apiId, RouteKey: `${httpMethod} ${routePath}`,
    AuthorizationType: 'AWS_IAM', Target: `integrations/${base.integrationId}`,
  }));
  await enableAutoDeployAndDeploy(base.apiId, tag());

  return {
    api_id: base.apiId, api_endpoint: base.apiEndpoint,
    route_url: `${base.apiEndpoint}${routePath}`,
    resources: { api_id: base.apiId, log_group: base.logGroupName },
    test_hint: 'Sign requests with AWS SDK SignatureV4 (service: execute-api).',
  };
}

async function destroy({ api_id, api_name, environment }) {
  await deleteHttpApiBase(api_id, api_name, environment);
}

module.exports = { create, destroy };


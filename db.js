'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, GetCommand,
  DeleteCommand, ScanCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_ACCOUNT_REGION || process.env.AWS_REGION })
);
const TABLE = process.env.DYNAMODB_TABLE;

async function saveApi(record) {
  await client.send(new PutCommand({
    TableName: TABLE,
    Item: { ...record, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  }));
}

async function getApi(api_name) {
  const res = await client.send(new GetCommand({ TableName: TABLE, Key: { api_name } }));
  return res.Item ?? null;
}

async function listApis() {
  const res = await client.send(new ScanCommand({ TableName: TABLE }));
  return res.Items ?? [];
}

async function deleteApi(api_name) {
  await client.send(new DeleteCommand({ TableName: TABLE, Key: { api_name } }));
}

async function updateStatus(api_name, status, extra = {}) {
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { api_name },
    UpdateExpression: 'SET #s = :s, updated_at = :u' +
      (Object.keys(extra).length ? ', ' + Object.keys(extra).map((k, i) => `#k${i} = :v${i}`).join(', ') : ''),
    ExpressionAttributeNames: {
      '#s': 'status',
      ...Object.fromEntries(Object.keys(extra).map((k, i) => [`#k${i}`, k])),
    },
    ExpressionAttributeValues: {
      ':s': status,
      ':u': new Date().toISOString(),
      ...Object.fromEntries(Object.keys(extra).map((k, i) => [`:v${i}`, extra[k]])),
    },
  }));
}

module.exports = { saveApi, getApi, listApis, deleteApi, updateStatus };


locals {
  prefix      = "${var.project_name}-${var.environment}"
  lambda_zip  = "${path.module}/backend-lambda.zip"  # built by CI workflow

  gui_routes = {
    "POST /apis"                        = "provision"
    "GET /apis"                         = "list"
    "GET /apis/{api_name}"              = "get_one"
    "DELETE /apis/{api_name}"           = "destroy"
    "POST /apis/{api_name}/force-clear" = "force_clear"
  }

  # Upstream Lambda / Authorizer values — injected by CI via -var flags (read from SSM by the workflow).
  # Empty string when the upstream stack has not been deployed yet; resources deploy but env vars are blank.
  lambda_arn               = var.existing_lambda_arn
  lambda_function_name     = var.existing_lambda_function_name
  authorizer_arn           = var.existing_authorizer_arn
  authorizer_function_name = var.existing_authorizer_function_name
}

# ── Read shared values written by api-portal-core (via SSM) ──────────────────
data "aws_ssm_parameter" "cognito_pool_id" {
  name = "/${var.project_name}/${var.environment}/cognito/pool-id"
}

data "aws_ssm_parameter" "cognito_client_id" {
  name = "/${var.project_name}/${var.environment}/cognito/client-id"
}


# ── DynamoDB — API registry ───────────────────────────────────────────────────
resource "aws_dynamodb_table" "api_registry" {
  name         = "${local.prefix}-api-registry"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "api_name"

  attribute {
    name = "api_name"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}

# ── IAM — GUI Lambda ──────────────────────────────────────────────────────────
resource "aws_iam_role" "gui_lambda" {
  name = "${local.prefix}-gui-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "gui_basic" {
  role       = aws_iam_role.gui_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "gui_permissions" {
  name = "${local.prefix}-gui-lambda-policy"
  role = aws_iam_role.gui_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem", "dynamodb:GetItem",
          "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.api_registry.arn
      },
      {
        Sid      = "APIGatewayManage"
        Effect   = "Allow"
        Action   = ["apigateway:*"]
        Resource = "*"
      },
      {
        Sid    = "LambdaPermissions"
        Effect = "Allow"
        Action = [
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:GetPolicy"
        ]
        Resource = [
          "${local.lambda_arn}*",
          "${local.authorizer_arn}*",
        ]
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup", "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy", "logs:DescribeLogGroups"
        ]
        Resource = [
          "arn:aws:logs:*:*:log-group:/aws/apigateway/*",
          "arn:aws:logs:*:*:log-group:/aws/apigateway/*:log-stream:*"
        ]
      },
      {
        Sid      = "IAMPassRole"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "*"
        Condition = {
          StringLike = { "iam:PassedToService" = "apigateway.amazonaws.com" }
        }
      },
      {
        Sid      = "STS"
        Effect   = "Allow"
        Action   = ["sts:GetCallerIdentity"]
        Resource = "*"
      }
    ]
  })
}

# ── CloudWatch log group ──────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "gui_lambda" {
  name              = "/aws/lambda/${local.prefix}-gui-lambda"
  retention_in_days = var.log_retention_days
}

# ── GUI Lambda — pre-built zip from CI (includes node_modules) ────────────────
resource "aws_lambda_function" "gui" {
  function_name    = "${local.prefix}-gui-lambda"
  role             = aws_iam_role.gui_lambda.arn
  runtime          = "nodejs18.x"
  handler          = "handler.handler"
  filename         = local.lambda_zip
  source_code_hash = filebase64sha256(local.lambda_zip)
  architectures    = ["arm64"]
  timeout          = var.lambda_timeout_seconds

  environment {
    variables = {
      DYNAMODB_TABLE                    = aws_dynamodb_table.api_registry.name
      AWS_ACCOUNT_REGION                = var.aws_region
      EXISTING_LAMBDA_ARN               = local.lambda_arn
      EXISTING_LAMBDA_FUNCTION_NAME     = local.lambda_function_name
      EXISTING_COGNITO_POOL_ID          = data.aws_ssm_parameter.cognito_pool_id.value
      EXISTING_COGNITO_CLIENT_ID        = data.aws_ssm_parameter.cognito_client_id.value
      EXISTING_AUTHORIZER_LAMBDA_ARN    = local.authorizer_arn
      EXISTING_AUTHORIZER_FUNCTION_NAME = local.authorizer_function_name
      CORS_ALLOWED_ORIGIN               = var.cors_allowed_origin
    }
  }

  depends_on = [aws_cloudwatch_log_group.gui_lambda]
}

# ── API Gateway — GUI backend ─────────────────────────────────────────────────
resource "aws_apigatewayv2_api" "gui" {
  name          = "${local.prefix}-gui-api"
  protocol_type = "HTTP"
  description   = "API Portal backend — ${var.environment} provisioning engine"

  cors_configuration {
    allow_origins = [var.cors_allowed_origin]
    allow_methods = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "gui" {
  api_id                 = aws_apigatewayv2_api.gui.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.gui.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each  = local.gui_routes
  api_id    = aws_apigatewayv2_api.gui.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.gui.id}"
}

resource "aws_apigatewayv2_stage" "gui" {
  api_id      = aws_apigatewayv2_api.gui.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "gui_apigw" {
  statement_id  = "AllowGUIAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gui.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.gui.execution_arn}/*/*"
}

# ── SSM — publish backend API URL for api-portal-frontend to consume ──────────
resource "aws_ssm_parameter" "backend_api_url" {
  name      = "/${var.project_name}/${var.environment}/backend/api-url"
  type      = "String"
  value     = aws_apigatewayv2_stage.gui.invoke_url
  overwrite = true
}

project_name           = "api-portal"
environment            = "dev"
aws_region             = "eu-north-1"
log_retention_days     = 7
cors_allowed_origin    = "*"
lambda_timeout_seconds = 60

# Optional: override SSM lookups for upstream Lambda / Authorizer.
# Leave empty (or omit) to read live values from SSM at plan time.
# Set these if the upstream lambda stack has not been deployed yet.
# existing_lambda_arn               = "arn:aws:lambda:eu-north-1:ACCOUNT_ID:function:FUNCTION_NAME"
# existing_lambda_function_name     = "my-existing-function"
# existing_authorizer_arn           = "arn:aws:lambda:eu-north-1:ACCOUNT_ID:function:AUTHORIZER_NAME"
# existing_authorizer_function_name = "my-authorizer-function"

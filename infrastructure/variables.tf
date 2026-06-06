variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-north-1"
}

variable "project_name" {
  description = "Project name used as prefix for all AWS resource names"
  type        = string
  default     = "api-portal"
}

variable "environment" {
  description = "Deployment environment (dev | sit | stage | prod)"
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "sit", "stage", "prod"], var.environment)
    error_message = "environment must be one of: dev, sit, stage, prod."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 14
}

variable "cors_allowed_origin" {
  description = "CORS allowed origin for the GUI API (use * for dev/sit, specific domain for stage/prod)"
  type        = string
  default     = "*"
}

variable "lambda_timeout_seconds" {
  description = "Timeout for the GUI provisioner Lambda in seconds (provisioning can be slow)"
  type        = number
  default     = 60
}

# ── Upstream Lambda / Authorizer overrides ────────────────────────────────────
# These are read from SSM by default (published by the upstream lambda stack).
# Set them here to skip the SSM lookup (useful when that stack isn't deployed yet
# or when you want to pin specific values per environment).

variable "existing_lambda_arn" {
  description = "ARN of the existing (upstream) Lambda. Leave empty to read from SSM /lambda/arn."
  type        = string
  default     = ""
}

variable "existing_lambda_function_name" {
  description = "Function name of the existing Lambda. Leave empty to read from SSM /lambda/function-name."
  type        = string
  default     = ""
}

variable "existing_authorizer_arn" {
  description = "ARN of the Lambda authorizer. Leave empty to read from SSM /authorizer/arn."
  type        = string
  default     = ""
}

variable "existing_authorizer_function_name" {
  description = "Function name of the Lambda authorizer. Leave empty to read from SSM /authorizer/function-name."
  type        = string
  default     = ""
}


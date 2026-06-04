output "backend_api_url"  {
  description = "GUI backend API base URL"
  value       = aws_apigatewayv2_stage.gui.invoke_url
}

output "gui_lambda_name" {
  description = "GUI Lambda function name"
  value       = aws_lambda_function.gui.function_name
}

output "dynamodb_table" {
  description = "DynamoDB API registry table name"
  value       = aws_dynamodb_table.api_registry.name
}

output "list_apis_url" {
  description = "Endpoint to list all provisioned APIs"
  value       = "${aws_apigatewayv2_stage.gui.invoke_url}apis"
}

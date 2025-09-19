#!/bin/bash

# Create API Gateway for FirstAm Fee Calculator Lambda

echo "🌐 Creating API Gateway for Fee Calculator..."

export AWS_PROFILE=fnte
export AWS_REGION=us-east-1

# Configuration
API_NAME="fnte-fee-calculator-api"
FUNCTION_NAME="fnte-fee-calculator-prod"
STAGE_NAME="prod"

# Get Lambda function ARN
LAMBDA_ARN=$(aws lambda get-function --function-name $FUNCTION_NAME --query 'Configuration.FunctionArn' --output text)
if [ -z "$LAMBDA_ARN" ]; then
    echo "❌ Lambda function $FUNCTION_NAME not found. Please deploy it first."
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)
REGION="us-east-1"

# Check if API already exists
API_ID=$(aws apigateway get-rest-apis --query "items[?name=='$API_NAME'].id" --output text)

if [ -z "$API_ID" ]; then
    echo "✨ Creating new REST API..."
    API_ID=$(aws apigateway create-rest-api \
        --name "$API_NAME" \
        --description "API for FirstAm Fee Calculator Lambda" \
        --endpoint-configuration types=REGIONAL \
        --query 'id' \
        --output text)
else
    echo "📌 Using existing API: $API_ID"
fi

# Get root resource ID
ROOT_ID=$(aws apigateway get-resources --rest-api-id $API_ID --query 'items[?path==`/`].id' --output text)

# Create /fee-calculator resource if it doesn't exist
RESOURCE_ID=$(aws apigateway get-resources --rest-api-id $API_ID --query "items[?pathPart=='fee-calculator'].id" --output text)
if [ -z "$RESOURCE_ID" ]; then
    echo "📁 Creating /fee-calculator resource..."
    RESOURCE_ID=$(aws apigateway create-resource \
        --rest-api-id $API_ID \
        --parent-id $ROOT_ID \
        --path-part "fee-calculator" \
        --query 'id' \
        --output text)
fi

# Create /fee-calculator/quick-quote resource
QUICK_QUOTE_ID=$(aws apigateway get-resources --rest-api-id $API_ID --query "items[?pathPart=='quick-quote'].id" --output text)
if [ -z "$QUICK_QUOTE_ID" ]; then
    echo "📁 Creating /fee-calculator/quick-quote resource..."
    QUICK_QUOTE_ID=$(aws apigateway create-resource \
        --rest-api-id $API_ID \
        --parent-id $RESOURCE_ID \
        --path-part "quick-quote" \
        --query 'id' \
        --output text)
fi

# Create /fee-calculator/official-quote resource
OFFICIAL_QUOTE_ID=$(aws apigateway get-resources --rest-api-id $API_ID --query "items[?pathPart=='official-quote'].id" --output text)
if [ -z "$OFFICIAL_QUOTE_ID" ]; then
    echo "📁 Creating /fee-calculator/official-quote resource..."
    OFFICIAL_QUOTE_ID=$(aws apigateway create-resource \
        --rest-api-id $API_ID \
        --parent-id $RESOURCE_ID \
        --path-part "official-quote" \
        --query 'id' \
        --output text)
fi

# Function to create method and integration
create_method() {
    local RESOURCE_ID=$1
    local PATH_NAME=$2

    echo "🔧 Setting up POST method for $PATH_NAME..."

    # Delete existing method if it exists
    aws apigateway delete-method \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method POST 2>/dev/null || true

    # Create POST method
    aws apigateway put-method \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method POST \
        --authorization-type NONE \
        --no-api-key-required > /dev/null

    # Set up Lambda integration
    aws apigateway put-integration \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method POST \
        --type AWS_PROXY \
        --integration-http-method POST \
        --uri "arn:aws:apigateway:$REGION:lambda:path/2015-03-31/functions/$LAMBDA_ARN/invocations" > /dev/null

    # Set up method response
    aws apigateway put-method-response \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method POST \
        --status-code 200 \
        --response-models '{"application/json": "Empty"}' \
        --response-parameters '{"method.response.header.Access-Control-Allow-Origin": false}' > /dev/null

    # Set up integration response
    aws apigateway put-integration-response \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method POST \
        --status-code 200 \
        --response-parameters '{"method.response.header.Access-Control-Allow-Origin": "'"'"'*'"'"'"}' \
        --response-templates '{"application/json": ""}' > /dev/null

    # Enable CORS - OPTIONS method
    aws apigateway delete-method \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method OPTIONS 2>/dev/null || true

    aws apigateway put-method \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method OPTIONS \
        --authorization-type NONE \
        --no-api-key-required > /dev/null

    aws apigateway put-integration \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method OPTIONS \
        --type MOCK \
        --request-templates '{"application/json": "{\"statusCode\": 200}"}' > /dev/null

    aws apigateway put-method-response \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method OPTIONS \
        --status-code 200 \
        --response-models '{"application/json": "Empty"}' \
        --response-parameters '{
            "method.response.header.Access-Control-Allow-Headers": false,
            "method.response.header.Access-Control-Allow-Methods": false,
            "method.response.header.Access-Control-Allow-Origin": false
        }' > /dev/null

    aws apigateway put-integration-response \
        --rest-api-id $API_ID \
        --resource-id $RESOURCE_ID \
        --http-method OPTIONS \
        --status-code 200 \
        --response-parameters '{
            "method.response.header.Access-Control-Allow-Headers": "'"'"'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"'"'",
            "method.response.header.Access-Control-Allow-Methods": "'"'"'POST,OPTIONS'"'"'",
            "method.response.header.Access-Control-Allow-Origin": "'"'"'*'"'"'"
        }' \
        --response-templates '{"application/json": ""}' > /dev/null
}

# Create methods for each endpoint
create_method $QUICK_QUOTE_ID "/fee-calculator/quick-quote"
create_method $OFFICIAL_QUOTE_ID "/fee-calculator/official-quote"

# Grant API Gateway permission to invoke Lambda
echo "🔑 Adding Lambda invoke permissions..."
aws lambda add-permission \
    --function-name $FUNCTION_NAME \
    --statement-id "apigateway-invoke-$API_ID" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/*" 2>/dev/null || true

# Deploy the API
echo "🚀 Deploying API to $STAGE_NAME stage..."
aws apigateway create-deployment \
    --rest-api-id $API_ID \
    --stage-name $STAGE_NAME \
    --stage-description "Production stage" > /dev/null

# Get the invoke URL
INVOKE_URL="https://$API_ID.execute-api.$REGION.amazonaws.com/$STAGE_NAME"

echo "✅ API Gateway setup complete!"
echo ""
echo "🔗 API Endpoints:"
echo "  Quick Quote:    $INVOKE_URL/fee-calculator/quick-quote"
echo "  Official Quote: $INVOKE_URL/fee-calculator/official-quote"
echo ""
echo "📝 Test with:"
echo "curl -X POST $INVOKE_URL/fee-calculator/quick-quote \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"PostalCode\":\"06901\",\"SalesContractAmount\":500000,\"NoteAmount\":400000,\"LoanPurposeType\":\"Purchase\"}'"
echo ""
echo "Save this API URL for your web app integration: $INVOKE_URL"
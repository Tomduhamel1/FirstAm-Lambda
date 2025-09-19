#!/bin/bash

# Deploy script for FirstAm Fee Calculator Lambda functions
# This script creates deployment packages and updates Lambda functions

echo "🚀 Starting Lambda deployment process..."

# Check if AWS CLI is configured
if ! aws sts get-caller-identity --profile fnte > /dev/null 2>&1; then
    echo "❌ AWS CLI not configured with 'fnte' profile"
    echo "Please run: aws configure --profile fnte"
    exit 1
fi

# Set AWS profile and region
export AWS_PROFILE=fnte
export AWS_REGION=us-east-1

# Function name
FUNCTION_NAME="fnte-fee-calculator-prod"

# Create deployment package
echo "📦 Creating deployment package..."
rm -f function.zip
zip -r function.zip . -x "*.git*" -x "deploy.sh" -x "*.md" -x "test-events/*" -x ".DS_Store" -x "*/\.DS_Store" > /dev/null

# Check if Lambda function exists
if aws lambda get-function --function-name $FUNCTION_NAME 2>/dev/null; then
    echo "🔄 Updating existing Lambda function..."
    aws lambda update-function-code \
        --function-name $FUNCTION_NAME \
        --zip-file fileb://function.zip \
        --query 'LastModified' \
        --output text
else
    echo "✨ Creating new Lambda function..."
    aws lambda create-function \
        --function-name $FUNCTION_NAME \
        --runtime nodejs18.x \
        --role arn:aws:iam::$(aws sts get-caller-identity --query 'Account' --output text):role/fnte-lambda-execution-role \
        --handler index.handler \
        --timeout 60 \
        --memory-size 512 \
        --zip-file fileb://function.zip \
        --environment Variables="{
            FIRSTAM_CLIENT_ID=REPLACE_WITH_ACTUAL_ID,
            FIRSTAM_CLIENT_SECRET=REPLACE_WITH_ACTUAL_SECRET,
            FIRSTAM_USERNAME=REPLACE_WITH_ACTUAL_USERNAME,
            FIRSTAM_PASSWORD=REPLACE_WITH_ACTUAL_PASSWORD
        }" \
        --query 'FunctionArn' \
        --output text
fi

# Update function configuration
echo "⚙️  Updating function configuration..."
aws lambda update-function-configuration \
    --function-name $FUNCTION_NAME \
    --timeout 60 \
    --memory-size 512 \
    --environment Variables="{
        FIRSTAM_CLIENT_ID=${FIRSTAM_CLIENT_ID:-REPLACE_WITH_ACTUAL_ID},
        FIRSTAM_CLIENT_SECRET=${FIRSTAM_CLIENT_SECRET:-REPLACE_WITH_ACTUAL_SECRET},
        FIRSTAM_USERNAME=${FIRSTAM_USERNAME:-REPLACE_WITH_ACTUAL_USERNAME},
        FIRSTAM_PASSWORD=${FIRSTAM_PASSWORD:-REPLACE_WITH_ACTUAL_PASSWORD}
    }" \
    --query 'LastModified' \
    --output text > /dev/null

echo "✅ Lambda deployment complete!"
echo ""
echo "📋 Next steps:"
echo "1. Set environment variables in AWS Console or with AWS CLI"
echo "2. Create API Gateway (run: ./create-api-gateway.sh)"
echo ""
echo "Function ARN:"
aws lambda get-function --function-name $FUNCTION_NAME --query 'Configuration.FunctionArn' --output text
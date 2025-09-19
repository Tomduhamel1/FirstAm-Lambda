#!/bin/bash

# Create IAM role for Lambda function

echo "🔐 Creating IAM role for Lambda..."

export AWS_PROFILE=fnte
export AWS_REGION=us-east-1

ROLE_NAME="fnte-lambda-execution-role"
POLICY_NAME="fnte-lambda-execution-policy"

# Create trust policy document
cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create execution policy document
cat > execution-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:DeleteItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:*:*:table/ZipCodes",
        "arn:aws:dynamodb:*:*:table/FNTEFees",
        "arn:aws:dynamodb:*:*:table/L2Sessions",
        "arn:aws:dynamodb:*:*:table/QuoteSessionsV2"
      ]
    }
  ]
}
EOF

# Check if role exists
if aws iam get-role --role-name $ROLE_NAME 2>/dev/null; then
    echo "📌 Role already exists: $ROLE_NAME"
else
    echo "✨ Creating new IAM role..."
    aws iam create-role \
        --role-name $ROLE_NAME \
        --assume-role-policy-document file://trust-policy.json \
        --description "Execution role for FirstAm Fee Calculator Lambda" \
        --query 'Role.Arn' \
        --output text
fi

# Check if policy exists and delete if it does (to update it)
POLICY_ARN="arn:aws:iam::$(aws sts get-caller-identity --query 'Account' --output text):policy/$POLICY_NAME"
if aws iam get-policy --policy-arn $POLICY_ARN 2>/dev/null; then
    echo "🔄 Updating existing policy..."
    # Get all versions
    VERSIONS=$(aws iam list-policy-versions --policy-arn $POLICY_ARN --query 'Versions[?!IsDefaultVersion].VersionId' --output text)
    # Delete old versions if there are 5 (AWS limit)
    for VERSION in $VERSIONS; do
        aws iam delete-policy-version --policy-arn $POLICY_ARN --version-id $VERSION 2>/dev/null
    done
    # Create new version
    aws iam create-policy-version \
        --policy-arn $POLICY_ARN \
        --policy-document file://execution-policy.json \
        --set-as-default > /dev/null
else
    echo "✨ Creating new IAM policy..."
    aws iam create-policy \
        --policy-name $POLICY_NAME \
        --policy-document file://execution-policy.json \
        --description "Execution policy for FirstAm Fee Calculator Lambda" \
        --query 'Policy.Arn' \
        --output text
fi

# Attach policy to role
echo "🔗 Attaching policy to role..."
aws iam attach-role-policy \
    --role-name $ROLE_NAME \
    --policy-arn $POLICY_ARN 2>/dev/null || true

# Attach AWS managed policy for Lambda basic execution
aws iam attach-role-policy \
    --role-name $ROLE_NAME \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true

# Clean up temp files
rm -f trust-policy.json execution-policy.json

# Get the role ARN
ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --query 'Role.Arn' --output text)

echo "✅ IAM role setup complete!"
echo ""
echo "Role ARN: $ROLE_ARN"
echo ""
echo "📋 Next step: Run ./deploy.sh to deploy the Lambda function"
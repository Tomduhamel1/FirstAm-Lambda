#!/bin/bash

# ROLLBACK SCRIPT FOR ENDORSEMENT CHANGES
# This script will restore the Lambda function to the state before endorsement changes
# Created: $(date)
# Rollback commit: b813b7903db71ae9623dbd5b383484263ea7ec2c

set -e

echo "🔄 Starting rollback process..."
echo ""

# Step 1: Git rollback
echo "1️⃣ Reverting Git changes..."
git checkout main
git branch -D feature/enable-endorsements-with-pricing 2>/dev/null || true
echo "   ✅ Git restored to main branch"
echo ""

# Step 2: Restore backup deployment package (if exists)
if ls function.zip.backup-* 1> /dev/null 2>&1; then
    BACKUP_FILE=$(ls -t function.zip.backup-* | head -1)
    echo "2️⃣ Restoring deployment package from $BACKUP_FILE..."
    cp "$BACKUP_FILE" function.zip
    echo "   ✅ Deployment package restored"
else
    echo "2️⃣ No backup found, rebuilding from source..."
    zip -r function.zip index.js quick-quote/ enhanced-quote/ official-quote/ official-quote-v2/ greenlight/ shared/ node_modules/ package.json -x "*.git*" -x "*.DS_Store" > /dev/null
    echo "   ✅ Deployment package rebuilt"
fi
echo ""

# Step 3: Deploy to Lambda
echo "3️⃣ Deploying rollback to Lambda..."
for i in 1 2 3; do
    echo "   Attempt $i..."
    if AWS_PROFILE=fnte AWS_REGION=us-east-1 aws lambda update-function-code \
        --function-name fnte-fee-calculator-l2-test \
        --zip-file fileb://function.zip \
        --query 'LastModified' \
        --output text; then
        echo "   ✅ Lambda function rolled back successfully"
        break
    else
        if [ $i -lt 3 ]; then
            echo "   ⚠️  Attempt $i failed, retrying..."
            sleep 2
        else
            echo "   ❌ Rollback failed after 3 attempts"
            exit 1
        fi
    fi
done
echo ""

# Step 4: Verify rollback
echo "4️⃣ Verifying rollback..."
LAST_MODIFIED=$(AWS_PROFILE=fnte AWS_REGION=us-east-1 aws lambda get-function-configuration \
    --function-name fnte-fee-calculator-l2-test \
    --query 'LastModified' \
    --output text)
echo "   Lambda last modified: $LAST_MODIFIED"
echo ""

echo "✅ ROLLBACK COMPLETE!"
echo ""
echo "Verification test:"
echo "AWS_PROFILE=fnte AWS_REGION=us-east-1 aws lambda invoke \\"
echo "  --function-name fnte-fee-calculator-l2-test \\"
echo "  --payload '{\"httpMethod\":\"POST\",\"path\":\"/enhanced-quote\",\"body\":\"{\\\"PostalCode\\\":\\\"06901\\\",\\\"SalesContractAmount\\\":500000,\\\"NoteAmount\\\":400000,\\\"LoanPurposeType\\\":\\\"Purchase\\\"}\"}' \\"
echo "  /tmp/rollback-test.json && cat /tmp/rollback-test.json | jq"

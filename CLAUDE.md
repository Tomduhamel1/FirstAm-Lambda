# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an AWS Lambda function that calculates title insurance and settlement fees for real estate transactions. It integrates with the LVIS FirstAm RateCalcGuide API and uses DynamoDB for storing state-specific fee data and zip code information.

## Key Dependencies

The function relies on several npm packages that are bundled in the deployment:
- `aws-sdk` - AWS services integration (DynamoDB)
- `axios` - HTTP client for API calls
- `xml2js` - XML parsing and conversion
- `uuid` - Generate unique request IDs
- `fast-xml-parser` - Fast XML parsing (installed but not currently used in index.js)

## Architecture Components

### External APIs
- **LVIS FirstAm RateCalcGuide API** (`https://calculator.lvis.firstam.com/`)
  - OAuth2 authentication via Microsoft Azure AD
  - ProductList endpoint for fetching available products
  - RateCalc endpoint for fee calculations

### AWS Resources
- **DynamoDB Tables**:
  - `ZipCodes` - Maps zip codes to city, county, and state information
  - `FNTEFees` - Stores state-specific title and settlement fees

### Business Logic
- Handles both Purchase and Refinance transaction types
- Different fee structures and rate types based on state and transaction type
- Special handling for cash purchases (no lender's policy)
- State-specific agricultural tax calculations (RI zip codes)
- Dynamic service block generation based on enabled products

## Deployment

### Building Deployment Package

Since this is a Lambda function without traditional build scripts:

```bash
# Clean build
rm -f function.zip

# Create deployment package (Node.js 20.x runtime)
zip -q -r function.zip index.js quick-quote/ enhanced-quote/ greenlight/ agentnet/ centralized-rates/ official-quote/ official-quote-v2/ shared/ package.json node_modules/ -x "*node_modules/.cache/*" "*.DS_Store"

# Deploy to Lambda
AWS_PROFILE=fnte AWS_REGION=us-east-1 aws lambda update-function-code \
  --function-name fnte-fee-calculator-l2-test \
  --zip-file fileb://function.zip \
  --query 'LastModified' \
  --output text
```

### Important Deployment Notes

- **FirstAm credentials**: `FIRSTAM_CLIENT_SECRET` must be set in the Lambda environment (both `fnte-fee-calculator-prod` and `fnte-fee-calculator-l2-test`). There is no hard-coded fallback since the 2026-09-09 secret rotation; `shared/auth.js` logs an error at load if it is missing. Rotate with `aws lambda update-function-configuration --environment file://env.json` (keep `FIRSTAM_CLIENT_ID` and `FIRSTAM_TENANT_ID` in the same file, the call replaces the whole variable set).
- **Package Size**: Expect ~30-35MB with all dependencies (aws-sdk v2 alone is ~50MB)
- **aws-sdk**: Lambda Node.js 20.x runtime provides aws-sdk v3, but this code uses v2 APIs. Must bundle aws-sdk v2 in deployment package.
- **Zip Performance**: Creating zip with full node_modules can take 1-2 minutes due to aws-sdk's 191 service client files
- **Testing**: After deployment, test both hasCalculatedRates path (RI refinance) and L2 question path (CT purchase)

### Commands

- **Install dependencies**: `npm install` (ensures all required packages are available)
- **Test locally**: Use AWS SAM CLI or create a test event with the expected JSON structure
- **Quick update**: `zip -q -u function.zip path/to/file.js && aws lambda update-function-code ...` (update single file)

## API Endpoints

The Lambda function supports multiple endpoints, each optimized for different use cases:

### 1. Quick Quote API (`/` or `/quick-quote`)
**Purpose**: Fast fee estimation for initial quotes
**Returns**: Simplified fee structure with single amount per fee (uses estimated amount if available, otherwise actual)

**Request**:
```json
{
  "PostalCode": "06901",
  "SalesContractAmount": 500000,
  "NoteAmount": 400000,
  "LoanPurposeType": "Purchase"
}
```

**Response**: Single fee amount per line item (backward compatible)

### 2. Enhanced Quote API (`/enhanced-quote`) ⭐ NEW
**Purpose**: Complete fee disclosure with actual vs. disclosed amounts for TRID compliance and variance tracking
**Returns**: Detailed fee structure with both actual (charged at closing) and disclosed (Loan Estimate) amounts

**Request**:
```json
{
  "PostalCode": "06901",
  "SalesContractAmount": 500000,
  "NoteAmount": 400000,
  "LoanPurposeType": "Purchase"
}
```

**Response Structure**:
```json
{
  "message": "Enhanced quote with actual and disclosed amounts",
  "settlementFee": 550,
  "settlementFeeType": "Purchase",
  "stateCode": "CT",
  "fees": [
    {
      "FeeDescription": "Title - Owner's Title Insurance",
      "DisclosureItemName": "Title - Owner's Title Insurance (optional) (Eagle Owner's Policy)",
      "HUDLine": "HUD-1 Line 1103",
      "DisclosureSection": "H",
      "DisclosureSectionName": "Owner's Title Insurance",
      "Buyer": {
        "actualAmount": "2122.00",
        "disclosedAmount": "649.00",
        "variance": "1473.00",
        "variancePercent": 226.96
      },
      "Seller": {
        "actualAmount": "0.00",
        "disclosedAmount": "0.00",
        "variance": "0.00",
        "variancePercent": 0
      },
      "TotalActual": "2122.00",
      "TotalDisclosed": "649.00"
    }
  ],
  "totals": {
    "buyerActual": 3014.00,
    "buyerDisclosed": 2399.00,
    "buyerVariance": 615.00,
    "buyerVariancePercent": 25.64,
    "sellerActual": 5500.00,
    "sellerDisclosed": 0.00,
    "sellerVariance": 5500.00,
    "sellerVariancePercent": 0
  },
  "metadata": {
    "requestDate": "2025-11-13",
    "hasVariances": true,
    "largestVariance": {
      "fee": "Title - Owner's Title Insurance",
      "amount": "1473.00",
      "percent": 226.96,
      "party": "Buyer"
    }
  }
}
```

**Key Features**:
- ✅ **Actual amounts** - Real charges at closing (from FeeActualPaymentAmount)
- ✅ **Disclosed amounts** - Loan Estimate amounts (from FeeEstimatedPaymentAmount)
- ✅ **Variance tracking** - Differences and percentages for tolerance calculations
- ✅ **HUD line mapping** - Compliance with HUD-1/Closing Disclosure requirements
- ✅ **Disclosure sections** - LE/CD section numbers and names
- ✅ **Largest variance identification** - Highlights biggest discrepancies

**Use Cases**:
- TRID compliance and tolerance tracking
- Loan Estimate vs. Closing Disclosure comparison
- Consumer transparency (show both estimated and actual fees)
- Lender risk management (identify large variances)
- Cure tracking for tolerance violations

### 3. Official Quote API (`/official-quote-v2`)
**Purpose**: Interactive quote flow with Level 2 (L2) questions
**Returns**: Questions for additional property details, then final rates after submission

#### Architecture Flow

The Official Quote V2 API has two distinct code paths:

**Path 1: Immediate Rates (hasCalculatedRates = true)**
- Used when FirstAm returns rates immediately (no L2 questions needed)
- Common for states like Rhode Island (RI) on refinance transactions
- Flow: L1 Request → L1 Handler → **Main Handler fee processing** → Response with fees
- **Critical**: Main handler (`official-quote-v2/handler.js`) must process fees and add FNTE fees

**Path 2: L2 Questions Flow (hasCalculatedRates = false)**
- Used when FirstAm requires additional property details (page counts, consideration amounts)
- Common for states like Connecticut (CT), Delaware (DE)
- Flow: L1 Request → L1 Handler → Page Questions → L2 Request → **L2 Handler fee processing** → Response with fees
- **Critical**: L2 handler (`official-quote-v2/l2-handler.js`) processes fees and adds FNTE fees

#### FNTE Fee Processing

State-specific FNTE fees (settlement, notary, tax review, CPL, etc.) MUST be added in BOTH paths:

1. **Shared Function**: `/shared/fnte-fees.js` - `addFNTEFeesToResponse(fees, stateCode, loanPurposeType, handlerName)`
   - Fetches state fees from DynamoDB `FNTEFees` table
   - Adds settlement fee (uses `SettlementFeeRefi` for refinance, `SettlementFee` for purchase)
   - Adds other state-specific fees (notary, tax review, CPL, recording service, etc.)

2. **hasCalculatedRates Path** (handler.js lines 152-183):
   ```javascript
   if (l1Result.type === 'rates' && l1Result.hasCalculatedRates) {
       // Process MISMO XML fees to simple format
       const processedFees = processFees(l1Result.fees, l1Result.parties || []);

       // Add FNTE state-specific fees
       await addFNTEFeesToResponse(processedFees, l1Result.stateCode, l1Result.loanPurposeType, 'Handler (no L2)');
   }
   ```

3. **L2 Questions Path** (l2-handler.js lines 178-182):
   ```javascript
   // After processing MISMO XML to simple format
   await addFNTEFeesToResponse(finalFees, stateCode, loanPurposeType, 'L2 Handler');
   ```

**Important**: If FNTE fees are not added in the hasCalculatedRates path, states without L2 questions will be missing settlement fees and other state-specific charges.

### 4. Greenlight LOS/POS Integration (`/Token`, `/Direct/*`) 🆕
**Purpose**: Lender integration for LOS/POS systems (Encompass, Calyx, etc.)
**Format**: Greenlight API-compatible format for direct lender integration

#### Authentication: `/Token`
**Request:**
```json
{
  "userName": "lender_username",
  "password": "lender_password",
  "titleCompanyID": 1
}
```

**Response:**
```json
{
  "accessToken": "uuid-token",
  "expiresIn": 3600,
  "tokenType": "Bearer"
}
```

#### Quote Endpoints:
- **`/Direct/CreateQuoteExtended`** - Basic quote (no validation)
- **`/Direct/CreateQuoteExtendedVal`** - Quote with location validation
- **`/Direct/CreateQuoteFIPS`** - Quote using FIPS county codes

**Request Example:**
```json
{
  "titleCompanyID": 1,
  "partnerID": 503,
  "partnerTypeID": 1,
  "settlementStatementVersion": "CD",
  "isPrimary": true,
  "transactionID": "lender-generated-uuid",
  "loanAmount": 400000,
  "salesPrice": 500000,
  "lienPosition": 0,
  "city": "Fairfield",
  "county": "Fairfield",
  "state": "CT",
  "zip": "06901",
  "productTypeID": 38,
  "transactionTypeID": 2
}
```

**Response Format (Array of line items):**
```json
[
  {
    "lineNumber": "1104",
    "feeName": "Lender's Coverage",
    "paidTo": "First National Title & Escrow",
    "buyerAmount": 1758.00,
    "sellerAmount": 0.00,
    "paidToType": "O",
    "transactionId": "lender-generated-uuid"
  }
]
```

**Use Cases:**
- Direct integration with lender LOS systems
- Automated fee quotes during loan application
- HUD-1/CD line item mapping
- Multi-lender support with authentication

See `greenlight/README.md` for complete documentation.

## Testing

### Test Cases for Official Quote V2

**Test 1: RI Refinance (hasCalculatedRates path)**
- Tests immediate rates without L2 questions
- Verifies FNTE fees added in main handler

```bash
AWS_PROFILE=fnte AWS_REGION=us-east-1 aws lambda invoke \
  --function-name fnte-fee-calculator-l2-test \
  --cli-binary-format raw-in-base64-out \
  --payload '{"httpMethod":"POST","path":"/official-quote-v2","headers":{"Content-Type":"application/json"},"body":"{\"action\":\"start\",\"PostalCode\":\"02886\",\"SalesContractAmount\":500000,\"NoteAmount\":400000,\"LoanPurposeType\":\"Refinance\",\"forceL2Questions\":false}"}' \
  /tmp/ri-refi-test.json

# Verify settlement fee appears
cat /tmp/ri-refi-test.json | jq -r '.body' | jq '.fees[] | select(.FeeDescription | contains("Settlement"))'
# Expected: "BuyerFee": "350" (SettlementFeeRefi from DynamoDB)
```

**Test 2: CT Purchase (L2 questions path)**
- Tests L2 question flow with page numbers
- Verifies FNTE fees added in L2 handler

```bash
AWS_PROFILE=fnte AWS_REGION=us-east-1 aws lambda invoke \
  --function-name fnte-fee-calculator-l2-test \
  --cli-binary-format raw-in-base64-out \
  --payload '{"httpMethod":"POST","path":"/official-quote-v2","headers":{"Content-Type":"application/json"},"body":"{\"action\":\"start\",\"PostalCode\":\"06901\",\"SalesContractAmount\":500000,\"NoteAmount\":400000,\"LoanPurposeType\":\"Purchase\",\"forceL2Questions\":true}"}' \
  /tmp/ct-purchase-test.json

# Verify page questions returned
cat /tmp/ct-purchase-test.json | jq -r '.body' | jq '.status, .requiresPageNumbers'
# Expected: "pending_page_numbers", true
```

### General Testing Notes

All endpoints expect a POST request with JSON body containing:
- `PostalCode` - 5-digit zip code (required)
- `SalesContractAmount` - Purchase price (for purchases)
- `NoteAmount` - Loan amount (0 for cash purchases)
- `LoanPurposeType` - Either "Purchase", "Cash Purchase", or "Refinance"

## Refinance-Specific Behavior

For `LoanPurposeType: "Refinance"` requests, the following special handling applies:

**Excluded Fees**:
- Owner's Title Insurance (not applicable for refinance)
- Sales Tax on Owner's Policy
- Conveyance Deed recording fees
- Conveyance Deed transfer taxes
- Assignment-related fees

**Different Fee Amounts**:
- Uses `SettlementFeeRefi` instead of `SettlementFee` from DynamoDB
- Uses `AbstractorTitleSearchREFI` if available instead of standard version

**Transaction Amount**:
- `salesAmount` internally set to `NoteAmount` (refinance amount)
- `SalesContractAmount` parameter is ignored for refinance

## Error Handling

The function includes comprehensive error handling:
- Invalid JSON format returns 400
- Missing zip code data returns 404
- API failures return 500 with details
- All errors are logged to CloudWatch

## Troubleshooting

### Missing Settlement Fees or FNTE Fees

**Symptom**: Settlement fee or other state-specific fees (notary, tax review, CPL) missing from Official Quote V2 response

**Root Cause**: FNTE fees not added in the correct code path

**Check**:
1. Determine which path the transaction took:
   - View CloudWatch logs for `hasCalculatedRates` flag
   - RI refinance typically uses hasCalculatedRates=true (immediate rates)
   - CT/DE transactions typically use L2 questions flow

2. Verify fee processing:
   - **hasCalculatedRates path**: Check `official-quote-v2/handler.js` lines 152-183
   - **L2 questions path**: Check `official-quote-v2/l2-handler.js` lines 178-182
   - Both must call `addFNTEFeesToResponse()`

3. Verify shared function exists:
   - Check `/shared/fnte-fees.js` is present in deployment package
   - Verify DynamoDB `FNTEFees` table has data for the state

**Fix**: Ensure both code paths call `addFNTEFeesToResponse()` from shared function

### Upstream Timeouts (503 UPSTREAM_TIMEOUT)

**Symptom**: Clients get `503 {"error":"UPSTREAM_TIMEOUT","message":"The FirstAm rate calculator is not responding..."}`; CloudWatch shows `[FirstAm ProductList] Upstream timeout after 12000ms`.

**Meaning**: FirstAm's LVIS backend did not answer within the per-call limit. This is a FirstAm outage/slowdown (see 2026-09-09: ProductList took 25-60s per call). Not a bug in this code. Before the fail-fast change, the same condition surfaced as API Gateway's generic `504 {"message":"Endpoint request timed out"}` at 29s while the Lambda kept running to 60s.

**How it works** (`shared/firstam-retry.js`): `index.js` starts a per-invocation time budget from the Lambda context (default 26s, under the 29s API Gateway integration limit). Every FirstAm/OAuth call goes through `firstAmRequestWithRetry()` with `timeout = min(perCallCap, remainingBudget - 1.5s)`. Timeouts retry at most once and only if a full-size retry still fits; when no budget is left the request is not sent (`"exhausted": true`). Defaults: OAuth 5s, TransactionTypes 6s, ProductList 12s, RateCalc 20s. Override with env vars `FIRSTAM_REQUEST_BUDGET_MS`, `FIRSTAM_SAFETY_MARGIN_MS`, `FIRSTAM_MIN_CALL_MS`, `FIRSTAM_OAUTH_TIMEOUT_MS`, `FIRSTAM_TXTYPES_TIMEOUT_MS`, `FIRSTAM_PRODUCTLIST_TIMEOUT_MS`, `FIRSTAM_RATECALC_TIMEOUT_MS`.

**Check**: run a ProductList call directly with the real token (`shared/auth.js` `getOAuthToken()` + `buildProductListRequestXML`) and time it. A fast 401 with a bogus token but a 20s+ answer with the real one means FirstAm's application backend is degraded. Reproduce a timeout without FirstAm by setting `FIRSTAM_PRODUCTLIST_TIMEOUT_MS=1 FIRSTAM_MIN_CALL_MS=1` on the test function.

**Do not** raise the API Gateway 29s integration timeout: a longer window only makes users wait longer for the same failure.

### Deployment Module Errors

**Symptom**: `Cannot find module 'axios'` or `Cannot find module 'aws-sdk'` errors after deployment

**Root Cause**: Deployment package missing node_modules or specific dependencies

**Fix**:
```bash
# Ensure all dependencies installed
npm install

# Create complete deployment package
rm -f function.zip
zip -q -r function.zip index.js quick-quote/ enhanced-quote/ greenlight/ agentnet/ centralized-rates/ official-quote/ official-quote-v2/ shared/ package.json node_modules/ -x "*node_modules/.cache/*" "*.DS_Store"

# Deploy
AWS_PROFILE=fnte AWS_REGION=us-east-1 aws lambda update-function-code --function-name fnte-fee-calculator-l2-test --zip-file fileb://function.zip
```

### Variable Name Errors

**Symptom**: `parsedResponse is not defined` or similar reference errors

**Root Cause**: Variable name typos, especially in hasCalculatedRates path which is less frequently tested

**Common Issues**:
- `parsedResponse` vs `parsedL1Response` (line 364 in l1-handler.js)
- Copy/paste errors when adding new code paths

**Prevention**: Test BOTH code paths after any changes:
- Test hasCalculatedRates path: RI refinance (zip 02886)
- Test L2 questions path: CT purchase (zip 06901)
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

## Commands

Since this is a Lambda function without traditional build scripts:
- **Deploy**: Create a zip file with `index.js` and `node_modules`, then upload to AWS Lambda
- **Test locally**: Use AWS SAM CLI or create a test event with the expected JSON structure
- **Install dependencies**: `npm install` (ensures all required packages are available)

## Testing

The function expects a POST request with JSON body containing:
- `PostalCode` - 5-digit zip code (required)
- `SalesContractAmount` - Purchase price (for purchases)
- `NoteAmount` - Loan amount (0 for cash purchases)
- `LoanPurposeType` - Either "Purchase", "Cash Purchase", or "Refinance"

## Error Handling

The function includes comprehensive error handling:
- Invalid JSON format returns 400
- Missing zip code data returns 404
- API failures return 500 with details
- All errors are logged to CloudWatch
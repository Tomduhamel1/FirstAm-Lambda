# FNTE Fee Calculator - Modular Architecture

## Overview
This AWS Lambda function provides both quick quotes and official quotes for title insurance and settlement fees. It integrates with the LVIS FirstAm RateCalcGuide API and uses DynamoDB for data storage.

## Project Structure
```
fnte-fee-calculator/
├── index.js                    # Main Lambda handler with routing
├── shared/                     # Shared modules
│   ├── auth.js                # OAuth authentication
│   ├── database.js            # DynamoDB operations
│   ├── xml-builders.js        # XML request builders
│   └── constants.js           # Configuration constants
├── quick-quote/               # Quick quote functionality
│   └── handler.js             # Quick quote handler
├── official-quote/            # Official quote functionality
│   ├── handler.js            # Main official quote handler
│   ├── questions.js          # Question retrieval logic
│   └── submission.js         # Quote submission logic
└── package.json              # Dependencies

```

## Features

### Quick Quotes (Existing Functionality)
- Immediate fee calculations
- No additional questions required
- Single API call to get results

### Official Quotes (New Functionality)
- Multi-step process with location-specific questions
- Session management for stateful interactions
- More detailed and guaranteed fee quotes

## API Endpoints

### Quick Quote
```
POST /
POST /quick-quote

Body:
{
    "PostalCode": "10001",
    "SalesContractAmount": 500000,
    "NoteAmount": 400000,
    "LoanPurposeType": "Purchase"  // or "Refinance", "Cash Purchase"
}
```

### Official Quote - Start
```
POST /official-quote/start

Body:
{
    "action": "start",
    "PostalCode": "10001",
    "SalesContractAmount": 500000,
    "NoteAmount": 400000,
    "LoanPurposeType": "Purchase"
}

Response:
{
    "sessionId": "uuid",
    "questions": [...],
    "locationInfo": {...},
    "expiresIn": "24 hours"
}
```

### Official Quote - Submit
```
POST /official-quote/submit

Body:
{
    "action": "submit",
    "sessionId": "uuid",
    "answers": {
        "property_type_detail": "Single Family",
        "is_new_construction": false,
        "closing_date": "2024-02-15",
        // ... other answers
    }
}

Response:
{
    "quoteId": "OQ-uuid",
    "fees": [...],
    "totalBuyerFee": "5250.00",
    "totalSellerFee": "1200.00",
    "notes": "...",
    "guaranteedFor": "30 days"
}
```

### Official Quote - Status
```
POST /official-quote/status

Body:
{
    "action": "status",
    "sessionId": "uuid"
}
```

## Question Types

Official quotes support various question types:
- **select**: Dropdown with predefined options
- **boolean**: Yes/No questions
- **text**: Free text input
- **number**: Numeric input with optional min/max
- **date**: Date selection

## State-Specific Questions

The system generates state-specific questions based on property location:
- **NY**: Mansion tax, CEMA options
- **CA**: County transfer tax rates, homeowner's exemption
- **FL**: Homestead status, documentary stamp responsibility
- **TX**: Survey requirements, MUD district status

## Session Management

Official quote sessions are stored in DynamoDB with:
- 24-hour TTL for automatic cleanup
- Session states: `pending_answers`, `completed`, `error`
- Full audit trail of questions and answers

## Deployment

1. Install dependencies:
```bash
npm install
```

2. Create deployment package:
```bash
zip -r function.zip . -x "*.git*" -x "*.md"
```

3. Upload to AWS Lambda

4. Set environment variables:
- AWS_REGION
- Any other required config

5. Create/Update DynamoDB tables:
- `ZipCodes` - Zip code to location mapping
- `FNTEFees` - State-specific fees
- `QuoteSessions` - Official quote sessions (new)

## Integration with Web App

The web app should:

1. **Start Official Quote**:
   - Call `/official-quote/start` with property details
   - Store the `sessionId` 
   - Render questions dynamically based on response

2. **Collect Answers**:
   - Present questions to user with appropriate UI controls
   - Validate answers client-side based on question requirements

3. **Submit Quote**:
   - Call `/official-quote/submit` with sessionId and answers
   - Display final quote with all fees

4. **Handle Errors**:
   - Check session status if needed
   - Handle expired sessions gracefully
   - Provide retry mechanism for failed submissions

## Testing

Test events are included in the handlers for local testing:
```javascript
// Uncomment the test section at the bottom of handlers
// Run: node quick-quote/handler.js
// Or: node official-quote/handler.js
```

## Next Steps

To complete the official quote implementation:

1. **Obtain FirstAm Documentation**:
   - Get actual API endpoints for official quotes
   - Understand question response format
   - Learn submission requirements

2. **Update API Endpoints**:
   - Replace mock endpoints in `constants.js`
   - Update XML builders for actual request format

3. **Implement Response Parsing**:
   - Replace mock responses with actual API calls
   - Parse FirstAm's XML responses correctly

4. **Add Error Handling**:
   - Implement retry logic
   - Add comprehensive error messages
   - Log all API interactions

5. **Enhance Security**:
   - Move credentials to AWS Secrets Manager
   - Add API key authentication if needed
   - Implement rate limiting

## Notes

- The official quote implementation includes placeholder/mock functionality
- Actual FirstAm API integration requires their official documentation
- Mock questions and fees are generated for testing purposes
- Production implementation should replace all mock functions with real API calls
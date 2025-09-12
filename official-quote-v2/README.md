# Official Quote V2 - L2 Request Implementation

## Overview

This is a **completely separate implementation** from the existing quick quote functionality. It adds support for FirstAm's L2 (Level 2) requests, which are required for official quotes that need additional location-specific information.

**IMPORTANT**: This implementation does NOT modify or interact with the existing quick quote code in any way.

## Architecture

```
official-quote-v2/
├── handler.js           # Main orchestrator for L2 flow
├── l1-handler.js        # Handles initial RateCalc request
├── l2-handler.js        # Handles L2 request with answers
├── question-parser.js   # Formats L2 questions for web app
├── session-manager.js   # Manages quote sessions
├── test-l2-flow.js     # Test script for L2 flow
└── README.md           # This file
```

## L2 Request Flow

### Understanding L2 Requests

According to FirstAm documentation, there are three scenarios for rate calculation:

1. **Scenario 1**: Rates available immediately (no L2 needed)
2. **Scenario 2**: L2 questions required (must be answered)
3. **Scenario 3**: L2 questions with defaults (can accept or modify)

### Implementation Flow

```
1. Client → Start Quote (L1 Request)
   ↓
2. System → Check if L2 questions needed
   ↓
3a. If no L2 needed → Return rates immediately
3b. If L2 needed → Return questions to client
   ↓
4. Client → Submit answers
   ↓
5. System → Send L2 request with answers
   ↓
6. System → Return final rates
```

## API Endpoints

### Start Official Quote V2

```http
POST /official-quote-v2
Content-Type: application/json

{
    "action": "start",
    "PostalCode": "10001",
    "SalesContractAmount": 500000,
    "NoteAmount": 400000,
    "LoanPurposeType": "Purchase",
    "forceL2Questions": false  // Optional: force L2 even with defaults
}
```

**Response (with L2 questions):**
```json
{
    "sessionId": "uuid",
    "status": "pending_answers",
    "hasCalculatedRates": false,
    "questions": [
        {
            "id": "P0_1204",
            "question": "Is the Property Vacant Land?",
            "type": "select",
            "options": [
                {"label": "Yes", "value": "1"},
                {"label": "No", "value": "2"}
            ],
            "defaultAnswer": "2",
            "required": true
        }
    ],
    "locationInfo": {
        "city": "New York",
        "county": "New York",
        "state": "NY"
    }
}
```

**Response (immediate rates):**
```json
{
    "sessionId": "uuid",
    "status": "completed",
    "hasCalculatedRates": true,
    "fees": [...],
    "totalBuyerFee": "5250.00",
    "totalSellerFee": "1200.00"
}
```

### Submit Answers

```http
POST /official-quote-v2
Content-Type: application/json

{
    "action": "submit",
    "sessionId": "uuid",
    "answers": {
        "P0_1204": "2",
        "CT0_1107": "1",
        "CT0_1108": "2"
    }
}
```

**Response:**
```json
{
    "sessionId": "uuid",
    "status": "completed",
    "fees": [...],
    "totalBuyerFee": "5250.00",
    "totalSellerFee": "1200.00",
    "loanCommentText": "...",
    "questionSummary": [...]
}
```

### Check Status

```http
POST /official-quote-v2
Content-Type: application/json

{
    "action": "status",
    "sessionId": "uuid"
}
```

## L2 Question Types

Questions from FirstAm are parsed and formatted for easy web app consumption:

- **Select**: Multiple choice with predefined options
- **Currency**: Monetary amounts
- **Integer**: Whole numbers
- **String**: Text input

Each question includes:
- `id`: Unique identifier (LinkKey from FirstAm)
- `question`: Question text
- `description`: Help text
- `defaultAnswer`: Pre-filled default if available
- `required`: Whether answer is mandatory
- `options`: For select questions

## Session Management

Sessions are managed separately from existing functionality:

- **Table**: `QuoteSessionsV2` (separate from existing sessions)
- **TTL**: 24 hours
- **Fallback**: In-memory storage if DynamoDB unavailable

Session states:
- `pending_answers`: Waiting for L2 answers
- `answers_submitted`: Answers received, processing
- `completed`: Final rates available
- `error`: Something went wrong

## XML Structure

### L1 Request (RateCalc)
- Standard RateCalc request
- Can use `RateCalcNoAutoCalc` to force L2 questions

### L1 Response with L2 Questions
```xml
<CalcRateLevel2Data>
    <RateCalcQandA>
        <Question>Is the Property Vacant Land?</Question>
        <Options>
            <KeyValue>
                <Key>Yes</Key>
                <Value>1</Value>
            </KeyValue>
        </Options>
        <DefaultAnswer>2</DefaultAnswer>
        <IsPrompt>true</IsPrompt>
        <LinkKey>P0_1204</LinkKey>
    </RateCalcQandA>
</CalcRateLevel2Data>
```

### L2 Request
- Echo entire `CalcRateLevel2Data` with user answers
- Include original `MISMO_XML` from L1 request
- Maintain all namespace declarations

## Testing

### Run Tests
```bash
node official-quote-v2/test-l2-flow.js
```

The test script:
1. Tests L2 flow with forced questions
2. Submits mock answers
3. Verifies final rates
4. Tests quick quote compatibility (ensures no impact)

### Test Scenarios
- Purchase with L2 questions
- Refinance
- Cash purchase
- Quick quote compatibility check

## Important Notes

### Safety Measures

1. **Complete Isolation**: No shared code with quick quote
2. **Separate Sessions**: Uses `QuoteSessionsV2` table
3. **Different Endpoint**: `/official-quote-v2` vs `/`
4. **No Breaking Changes**: Quick quote remains untouched
5. **Easy Rollback**: Can disable L2 without affecting production

### Production Considerations

1. **Create DynamoDB Table**: 
   ```
   Table: QuoteSessionsV2
   Partition Key: sessionId (String)
   TTL Attribute: ttl
   ```

2. **Monitor Sessions**: Clean up expired sessions periodically

3. **Error Handling**: Falls back to in-memory storage if DynamoDB unavailable

4. **Feature Flag**: Can disable with environment variable if needed

### Migration Path

1. Test thoroughly in staging
2. Deploy alongside existing code
3. Route small percentage of traffic initially
4. Monitor for issues
5. Gradually increase traffic
6. Only deprecate old system after full validation

## Troubleshooting

### Common Issues

**Session Not Found**
- Session expired (24-hour TTL)
- Wrong sessionId
- DynamoDB table not created

**No L2 Questions Returned**
- State/location doesn't require L2
- Use `forceL2Questions: true` to test

**Invalid Answers**
- Check question IDs match
- Validate answer format matches question type
- Ensure required questions answered

### Debug Mode

Set environment variables:
```bash
DEBUG=official-quote-v2:*
LOG_LEVEL=debug
```

## Future Enhancements

- [ ] Add question caching by location
- [ ] Implement answer validation rules from FirstAm
- [ ] Add webhook for async processing
- [ ] Support bulk quote requests
- [ ] Add metrics and monitoring

## Support

This implementation is designed to be completely safe and isolated. If any issues arise:

1. Route `/official-quote-v2` to 501 (Not Implemented)
2. Quick quote continues working normally
3. Debug in isolation
4. No customer impact

The existing quick quote at `/` and `/quick-quote` remains completely unaffected.
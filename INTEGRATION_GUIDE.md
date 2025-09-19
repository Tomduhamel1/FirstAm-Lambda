# FirstAm Fee Calculator Integration Guide

## Quick Setup - API Gateway Integration

### Step 1: Create API Gateway
```bash
# In AWS Console or CLI
1. Create new REST API in API Gateway
2. Create resource `/fee-calculator`
3. Create POST method
4. Connect to your Lambda functions:
   - fnte-fee-calculator (for quick quotes)
   - fnte-fee-calculator-l2-test (for L2 questions)
```

### Step 2: Web App Integration

#### JavaScript/React Example
```javascript
class FeeCalculatorClient {
  constructor(apiUrl) {
    this.apiUrl = apiUrl; // Your API Gateway URL
  }

  // Quick quote (no L2 questions)
  async getQuickQuote(data) {
    const response = await fetch(`${this.apiUrl}/fee-calculator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        PostalCode: data.zipCode,
        SalesContractAmount: data.purchasePrice,
        NoteAmount: data.loanAmount,
        LoanPurposeType: data.transactionType // "Purchase" or "Refinance"
      })
    });
    return response.json();
  }

  // Start L2 flow (with questions)
  async startOfficialQuote(data) {
    const response = await fetch(`${this.apiUrl}/fee-calculator/official-quote-v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        PostalCode: data.zipCode,
        SalesContractAmount: data.purchasePrice,
        NoteAmount: data.loanAmount,
        LoanPurposeType: data.transactionType,
        forceL2Questions: true
      })
    });
    return response.json();
  }

  // Submit L2 answers
  async submitAnswers(sessionId, answers) {
    const response = await fetch(`${this.apiUrl}/fee-calculator/official-quote-v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit',
        sessionId: sessionId,
        answers: answers
      })
    });
    return response.json();
  }
}

// Usage in your web app
const calculator = new FeeCalculatorClient('https://your-api-gateway-url.execute-api.us-east-1.amazonaws.com/prod');

// Get fees for a file
async function populateFeesInFile(fileData) {
  try {
    // Step 1: Get initial quote with L2 questions
    const quoteResponse = await calculator.startOfficialQuote({
      zipCode: fileData.propertyZip,
      purchasePrice: fileData.purchasePrice,
      loanAmount: fileData.loanAmount,
      transactionType: 'Purchase'
    });

    if (quoteResponse.needsManualInput) {
      // Show page number questions to user
      const pageAnswers = await showPageNumberDialog(quoteResponse.pageQuestions);

      // Step 2: Submit page numbers and get L2 questions
      const l2Response = await calculator.submitAnswers(
        quoteResponse.sessionId,
        pageAnswers
      );

      if (l2Response.l2Questions && l2Response.l2Questions.length > 0) {
        // Show L2 questions to user
        const l2Answers = await showL2Dialog(l2Response.l2Questions);

        // Step 3: Submit L2 answers and get final fees
        const finalResponse = await calculator.submitAnswers(
          quoteResponse.sessionId,
          l2Answers
        );

        // Populate file with fees
        fileData.titleFees = finalResponse.fees;
        fileData.recordingFees = finalResponse.recordingFees;
        fileData.settlementFees = finalResponse.settlementFees;
        return fileData;
      }
    }

    // No L2 questions needed
    fileData.titleFees = quoteResponse.fees;
    return fileData;

  } catch (error) {
    console.error('Error calculating fees:', error);
    throw error;
  }
}
```

### Step 3: Environment Variables

Set these in your Lambda functions:
```bash
FIRSTAM_CLIENT_ID=your-client-id
FIRSTAM_CLIENT_SECRET=your-client-secret
FIRSTAM_USERNAME=your-username
FIRSTAM_PASSWORD=your-password
```

### Step 4: CORS Configuration

In API Gateway, enable CORS:
```json
{
  "Access-Control-Allow-Origin": "https://your-web-app.com",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
}
```

## Response Format

### Quick Quote Response
```json
{
  "fees": {
    "OwnersPolicyAmount": 1250.00,
    "LendersPolicyAmount": 875.00,
    "SettlementFee": 500.00,
    "RecordingFees": 125.00,
    "TotalFees": 2750.00
  }
}
```

### L2 Flow Response
```json
{
  "sessionId": "uuid",
  "needsManualInput": true,
  "pageQuestions": [
    {
      "id": "deedPages",
      "question": "Number of pages for deed",
      "defaultAnswer": "4"
    }
  ],
  "l2Questions": [
    {
      "paramCode": "RFC_17_0",
      "question": "Is this property agricultural?",
      "defaultAnswer": "N"
    }
  ],
  "fees": {
    // Final fees after all questions answered
  }
}
```

## Testing Your Integration

```javascript
// Test script
const testData = {
  zipCode: "06901",
  purchasePrice: 500000,
  loanAmount: 400000,
  transactionType: "Purchase"
};

calculator.getQuickQuote(testData)
  .then(result => console.log('Fees calculated:', result))
  .catch(error => console.error('Error:', error));
```
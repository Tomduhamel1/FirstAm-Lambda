const axios = require('axios');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const { getOAuthToken } = require('../shared/auth');
const { getStateFees } = require('../shared/database');
const constants = require('../shared/constants');

/**
 * Submit an official quote with answers to location-specific questions
 * This function sends the completed quote request to FirstAm's API
 * 
 * @param {Object} quoteData - Complete quote data including answers
 * @returns {Object} Final official quote with fees
 */
async function submitOfficialQuote(quoteData) {
    const {
        PostalCode,
        SalesContractAmount,
        NoteAmount,
        LoanPurposeType,
        locationData,
        questions,
        answers
    } = quoteData;
    
    console.info('Submitting official quote with answers:', { PostalCode, LoanPurposeType });
    
    try {
        // Get OAuth token
        const token = await getOAuthToken();
        
        // Get state fees from DynamoDB
        const stateFeeData = await getStateFees(locationData.state);
        
        // Build the official quote submission XML with answers
        const requestXML = buildOfficialQuoteRequestXML({
            PostalCode,
            SalesContractAmount,
            NoteAmount,
            LoanPurposeType,
            locationData,
            questions,
            answers
        });
        
        console.info('Official Quote Submission XML:', requestXML);
        
        // NOTE: This is a placeholder implementation
        // The actual endpoint and response parsing would need to be
        // implemented based on FirstAm's official quote API documentation
        
        // For now, return mock response
        const mockResponse = generateMockOfficialQuoteResponse({
            PostalCode,
            SalesContractAmount,
            NoteAmount,
            LoanPurposeType,
            locationData,
            stateFeeData,
            answers
        });
        
        return mockResponse;
        
        // Actual implementation would look like:
        /*
        const response = await axios.post(
            constants.OFFICIAL_QUOTE_SUBMIT_URL,
            requestXML,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/xml'
                }
            }
        );
        
        console.info('Official Quote Response:', response.data);
        
        const parsedResponse = await xml2js.parseStringPromise(response.data, {
            explicitArray: false,
            ignoreAttrs: false
        });
        
        return parseOfficialQuoteResponse(parsedResponse, stateFeeData);
        */
        
    } catch (error) {
        console.error('Error submitting official quote:', error);
        throw new Error('Failed to submit official quote');
    }
}

/**
 * Build XML request for submitting official quote with answers
 */
function buildOfficialQuoteRequestXML({ PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType, locationData, questions, answers }) {
    const transactionType = LoanPurposeType === 'Refinance' ? 'Refinance' : 'Sale w/ Mortgage';
    const salesAmount = LoanPurposeType === 'Refinance' ? NoteAmount : SalesContractAmount;
    const noteAmountToUse = Number(NoteAmount) === 0 ? constants.DEFAULT_NOTE_AMOUNT : NoteAmount;
    
    // Build answers XML section
    const answersXML = buildAnswersXML(questions, answers);
    
    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>OfficialQuoteSubmit</lvis:LVISActionType>
    <lvis:ClientCustomerId>${constants.CLIENT_CUSTOMER_ID}</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>OFFICIAL-SUBMIT-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_OFFICIAL_QUOTE_SUBMISSION>
    <lvis:PROPERTY_INFO>
      <lvis:PropertyStateCode>${locationData.state}</lvis:PropertyStateCode>
      <lvis:PropertyCountyName>${locationData.county}</lvis:PropertyCountyName>
      <lvis:PropertyCityName>${locationData.city}</lvis:PropertyCityName>
      <lvis:PropertyPostalCode>${PostalCode}</lvis:PropertyPostalCode>
      <lvis:PropertyType>Residential</lvis:PropertyType>
    </lvis:PROPERTY_INFO>
    <lvis:TRANSACTION_INFO>
      <lvis:TransactionType>${transactionType}</lvis:TransactionType>
      <lvis:SalesAmount>${salesAmount}</lvis:SalesAmount>
      <lvis:LoanAmount>${noteAmountToUse}</lvis:LoanAmount>
      <lvis:LoanPurposeType>${LoanPurposeType}</lvis:LoanPurposeType>
    </lvis:TRANSACTION_INFO>
    <lvis:QUESTION_ANSWERS>
      ${answersXML}
    </lvis:QUESTION_ANSWERS>
    <lvis:SERVICE_OPTIONS>
      <lvis:IncludeTitle>True</lvis:IncludeTitle>
      <lvis:IncludeClosing>True</lvis:IncludeClosing>
      <lvis:IncludeRecording>True</lvis:IncludeRecording>
      <lvis:IncludeEndorsements>True</lvis:IncludeEndorsements>
      <lvis:IncludeAllFees>True</lvis:IncludeAllFees>
    </lvis:SERVICE_OPTIONS>
  </lvis:LVIS_OFFICIAL_QUOTE_SUBMISSION>
</lvis:LVIS_XML>`;
}

/**
 * Build answers XML section
 */
function buildAnswersXML(questions, answers) {
    return questions.map(question => {
        const answer = answers[question.id];
        if (answer === undefined || answer === null) return '';
        
        return `
      <lvis:ANSWER>
        <lvis:QuestionId>${question.id}</lvis:QuestionId>
        <lvis:QuestionText>${escapeXml(question.label)}</lvis:QuestionText>
        <lvis:AnswerValue>${escapeXml(String(answer))}</lvis:AnswerValue>
        <lvis:AnswerType>${question.type}</lvis:AnswerType>
      </lvis:ANSWER>`;
    }).join('');
}

/**
 * Escape XML special characters
 */
function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Generate mock official quote response for testing
 */
function generateMockOfficialQuoteResponse({ PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType, locationData, stateFeeData, answers }) {
    const quoteId = `OQ-${uuidv4()}`;
    const isRefinance = LoanPurposeType === 'Refinance';
    const isCashPurchase = LoanPurposeType === 'Cash Purchase';
    
    // Base fees similar to quick quote
    const fees = [];
    
    // Owner's Title Insurance (not for refinance)
    if (!isRefinance) {
        const ownersPremium = calculateTitlePremium(SalesContractAmount, 'owners');
        fees.push({
            FeeDescription: "Title - Owner's Title Insurance",
            BuyerFee: ownersPremium.toFixed(2),
            SellerFee: '0.00',
            FeeType: 'Title',
            IsGuaranteed: true
        });
    }
    
    // Lender's Title Insurance (not for cash purchase)
    if (!isCashPurchase) {
        const lendersPremium = calculateTitlePremium(NoteAmount, 'lenders');
        fees.push({
            FeeDescription: "Title - Lender's Title Insurance",
            BuyerFee: lendersPremium.toFixed(2),
            SellerFee: '0.00',
            FeeType: 'Title',
            IsGuaranteed: true
        });
    }
    
    // Settlement Fee
    const settlementFee = isRefinance
        ? (stateFeeData?.SettlementFeeRefi || 850)
        : (stateFeeData?.SettlementFee || 1250);
    
    fees.push({
        FeeDescription: 'Title - Settlement Fee',
        BuyerFee: settlementFee.toString(),
        SellerFee: '0.00',
        FeeType: 'Settlement',
        IsGuaranteed: true
    });
    
    // Add fees based on answers
    if (answers.is_new_construction === true || answers.is_new_construction === 'true') {
        fees.push({
            FeeDescription: 'New Construction Inspection',
            BuyerFee: '350.00',
            SellerFee: '0.00',
            FeeType: 'Inspection',
            IsGuaranteed: false
        });
    }
    
    if (answers.tx_survey_required === true || answers.tx_survey_required === 'true') {
        fees.push({
            FeeDescription: 'Property Survey',
            BuyerFee: '450.00',
            SellerFee: '0.00',
            FeeType: 'Survey',
            IsGuaranteed: false
        });
    }
    
    // Recording fees
    if (!isRefinance) {
        fees.push({
            FeeDescription: 'Recording - Deed',
            BuyerFee: '125.00',
            SellerFee: '0.00',
            FeeType: 'Recording',
            IsGuaranteed: false
        });
    }
    
    if (!isCashPurchase) {
        fees.push({
            FeeDescription: 'Recording - Mortgage',
            BuyerFee: '225.00',
            SellerFee: '0.00',
            FeeType: 'Recording',
            IsGuaranteed: false
        });
    }
    
    // State-specific fees
    if (locationData.state === 'NY' && (answers.ny_mansion_tax === true || answers.ny_mansion_tax === 'true')) {
        const mansionTax = SalesContractAmount * 0.01; // 1% mansion tax
        fees.push({
            FeeDescription: 'NY Mansion Tax',
            BuyerFee: mansionTax.toFixed(2),
            SellerFee: '0.00',
            FeeType: 'Tax',
            IsGuaranteed: true
        });
    }
    
    if (locationData.state === 'FL' && answers.fl_doc_stamps_paid_by) {
        const docStamps = calculateDocStamps(SalesContractAmount, NoteAmount);
        if (answers.fl_doc_stamps_paid_by === 'Buyer') {
            fees.push({
                FeeDescription: 'Documentary Stamps',
                BuyerFee: docStamps.toFixed(2),
                SellerFee: '0.00',
                FeeType: 'Tax',
                IsGuaranteed: true
            });
        } else if (answers.fl_doc_stamps_paid_by === 'Seller') {
            fees.push({
                FeeDescription: 'Documentary Stamps',
                BuyerFee: '0.00',
                SellerFee: docStamps.toFixed(2),
                FeeType: 'Tax',
                IsGuaranteed: true
            });
        } else {
            // Split
            fees.push({
                FeeDescription: 'Documentary Stamps',
                BuyerFee: (docStamps / 2).toFixed(2),
                SellerFee: (docStamps / 2).toFixed(2),
                FeeType: 'Tax',
                IsGuaranteed: true
            });
        }
    }
    
    // Calculate totals
    const totalBuyerFee = fees.reduce((sum, fee) => sum + parseFloat(fee.BuyerFee), 0);
    const totalSellerFee = fees.reduce((sum, fee) => sum + parseFloat(fee.SellerFee), 0);
    
    // Generate notes based on answers
    const notes = generateQuoteNotes(answers, locationData);
    
    return {
        quoteId,
        fees,
        totalBuyerFee: totalBuyerFee.toFixed(2),
        totalSellerFee: totalSellerFee.toFixed(2),
        notes,
        guaranteedFor: '30 days',
        expirationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
}

/**
 * Calculate title insurance premium
 */
function calculateTitlePremium(amount, type) {
    // Simplified calculation - actual rates would come from FirstAm
    const baseRate = type === 'owners' ? 0.0055 : 0.0045;
    return amount * baseRate;
}

/**
 * Calculate documentary stamps for Florida
 */
function calculateDocStamps(salesAmount, loanAmount) {
    // FL doc stamps: $0.70 per $100 for deed, $0.35 per $100 for mortgage
    const deedStamps = (salesAmount / 100) * 0.70;
    const mortgageStamps = (loanAmount / 100) * 0.35;
    return deedStamps + mortgageStamps;
}

/**
 * Generate quote notes based on answers
 */
function generateQuoteNotes(answers, locationData) {
    const notes = [];
    
    notes.push(`This is an official quote for property located in ${locationData.city}, ${locationData.county} County, ${locationData.state}.`);
    
    if (answers.property_type_detail) {
        notes.push(`Property Type: ${answers.property_type_detail}`);
    }
    
    if (answers.closing_date) {
        notes.push(`Expected Closing Date: ${answers.closing_date}`);
    }
    
    if (answers.buyer_representation) {
        notes.push(`Buyer will hold title as: ${answers.buyer_representation}`);
    }
    
    if (answers.first_time_buyer === true || answers.first_time_buyer === 'true') {
        notes.push('First-time homebuyer discounts have been applied where applicable.');
    }
    
    if (answers.loan_type) {
        notes.push(`Loan Type: ${answers.loan_type}`);
    }
    
    notes.push('All fees marked as "Guaranteed" are fixed for 30 days from the quote date.');
    notes.push('Non-guaranteed fees are estimates and may vary based on final transaction details.');
    
    return notes.join(' ');
}

/**
 * Parse official quote response from FirstAm API
 * This would be implemented based on actual API response structure
 */
function parseOfficialQuoteResponse(parsedResponse, stateFeeData) {
    // This would parse the actual XML response from FirstAm
    // Implementation depends on FirstAm's response structure
    
    // Example parsing logic (would need to be adapted to actual response):
    /*
    const quoteData = parsedResponse['lvis:LVIS_XML']?.['lvis:OFFICIAL_QUOTE_RESPONSE'];
    const fees = [];
    
    const feeNodes = quoteData?.['lvis:FEES']?.['lvis:FEE'];
    if (feeNodes) {
        const feeArray = Array.isArray(feeNodes) ? feeNodes : [feeNodes];
        
        feeArray.forEach(fee => {
            fees.push({
                FeeDescription: fee['lvis:Description'],
                BuyerFee: fee['lvis:BuyerAmount'] || '0.00',
                SellerFee: fee['lvis:SellerAmount'] || '0.00',
                FeeType: fee['lvis:FeeType'],
                IsGuaranteed: fee['lvis:IsGuaranteed'] === 'true'
            });
        });
    }
    
    // Add state-specific fees from database
    // ... additional processing ...
    
    return {
        quoteId: quoteData['lvis:QuoteId'],
        fees,
        totalBuyerFee: quoteData['lvis:TotalBuyerFee'],
        totalSellerFee: quoteData['lvis:TotalSellerFee'],
        notes: quoteData['lvis:Notes'],
        guaranteedFor: quoteData['lvis:GuaranteedDays'],
        expirationDate: quoteData['lvis:ExpirationDate']
    };
    */
    
    return {};
}

module.exports = {
    submitOfficialQuote
};
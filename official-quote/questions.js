const axios = require('axios');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const { getOAuthToken } = require('../shared/auth');
const { getZipCodeData } = require('../shared/database');
const constants = require('../shared/constants');

/**
 * Get location-specific questions for an official quote
 * This function calls FirstAm's API to retrieve questions that need to be answered
 * for generating an official quote based on the property location
 * 
 * @param {Object} params - Quote parameters
 * @param {string} params.PostalCode - Property zip code
 * @param {number} params.SalesContractAmount - Sale price
 * @param {number} params.NoteAmount - Loan amount
 * @param {string} params.LoanPurposeType - Purchase, Cash Purchase, or Refinance
 * @returns {Object} Questions and location data
 */
async function getQuestions({ PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType }) {
    console.info('Getting questions for official quote:', { PostalCode, LoanPurposeType });
    
    try {
        // Get OAuth token
        const token = await getOAuthToken();
        
        // Get location data from DynamoDB
        const zipCodeData = await getZipCodeData(PostalCode);
        const { city, county_name: countyName, state_id: stateCode } = zipCodeData;
        
        // Build request XML for getting questions
        const requestXML = buildQuestionsRequestXML({
            stateCode,
            countyName,
            city,
            PostalCode,
            SalesContractAmount,
            NoteAmount,
            LoanPurposeType
        });
        
        console.info('Questions Request XML:', requestXML);
        
        // NOTE: The actual endpoint for getting official quote questions would need to be
        // provided by FirstAm documentation. This is a placeholder implementation.
        // In production, this would call the actual FirstAm API endpoint.
        
        // For now, return mock questions based on state
        // These would be replaced with actual API response parsing
        const questions = generateMockQuestions(stateCode, LoanPurposeType);
        
        return {
            questions,
            locationData: {
                city,
                county: countyName,
                state: stateCode
            }
        };
        
        // Actual implementation would look like:
        /*
        const response = await axios.post(
            constants.OFFICIAL_QUOTE_QUESTIONS_URL,
            requestXML,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/xml'
                }
            }
        );
        
        const parsedResponse = await xml2js.parseStringPromise(response.data, {
            explicitArray: false,
            ignoreAttrs: false
        });
        
        const questions = parseQuestionsFromResponse(parsedResponse);
        
        return {
            questions,
            locationData: {
                city,
                county: countyName,
                state: stateCode
            }
        };
        */
        
    } catch (error) {
        console.error('Error getting questions:', error);
        throw new Error('Failed to retrieve questions for official quote');
    }
}

/**
 * Build XML request for getting official quote questions
 */
function buildQuestionsRequestXML({ stateCode, countyName, city, PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType }) {
    const transactionType = LoanPurposeType === 'Refinance' ? 'Refinance' : 'Sale w/ Mortgage';
    
    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>OfficialQuoteQuestions</lvis:LVISActionType>
    <lvis:ClientCustomerId>${constants.CLIENT_CUSTOMER_ID}</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>OFFICIAL-QUESTIONS-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_OFFICIAL_QUOTE_QUESTIONS_REQUEST>
    <lvis:PropertyStateCode>${stateCode}</lvis:PropertyStateCode>
    <lvis:PropertyCountyName>${countyName}</lvis:PropertyCountyName>
    <lvis:PropertyCityName>${city}</lvis:PropertyCityName>
    <lvis:PropertyPostalCode>${PostalCode}</lvis:PropertyPostalCode>
    <lvis:TransactionType>${transactionType}</lvis:TransactionType>
    <lvis:SalesAmount>${SalesContractAmount || 0}</lvis:SalesAmount>
    <lvis:LoanAmount>${NoteAmount || 0}</lvis:LoanAmount>
    <lvis:PropertyType>Residential</lvis:PropertyType>
  </lvis:LVIS_OFFICIAL_QUOTE_QUESTIONS_REQUEST>
</lvis:LVIS_XML>`;
}

/**
 * Generate mock questions for testing
 * In production, these would come from the FirstAm API
 */
function generateMockQuestions(stateCode, loanPurposeType) {
    const baseQuestions = [
        {
            id: 'property_type_detail',
            label: 'Property Type Details',
            type: 'select',
            required: true,
            options: ['Single Family', 'Condo', 'Townhouse', 'Multi-Family', 'Vacant Land'],
            helpText: 'Select the specific type of residential property'
        },
        {
            id: 'is_new_construction',
            label: 'Is this new construction?',
            type: 'boolean',
            required: true,
            helpText: 'Indicate if this is a newly constructed property'
        },
        {
            id: 'closing_date',
            label: 'Expected Closing Date',
            type: 'date',
            required: true,
            helpText: 'When do you expect to close on this property?'
        },
        {
            id: 'buyer_representation',
            label: 'Buyer Representation',
            type: 'select',
            required: true,
            options: ['Individual', 'Joint Tenants', 'Tenants in Common', 'LLC', 'Corporation', 'Trust'],
            helpText: 'How will the buyer hold title?'
        }
    ];
    
    // Add state-specific questions
    const stateSpecificQuestions = getStateSpecificQuestions(stateCode);
    
    // Add transaction-specific questions
    const transactionQuestions = getTransactionSpecificQuestions(loanPurposeType);
    
    return [...baseQuestions, ...stateSpecificQuestions, ...transactionQuestions];
}

/**
 * Get state-specific questions
 */
function getStateSpecificQuestions(stateCode) {
    const questions = [];
    
    // Example state-specific questions
    switch (stateCode) {
        case 'NY':
            questions.push({
                id: 'ny_mansion_tax',
                label: 'Is the purchase price over $1 million? (Mansion Tax)',
                type: 'boolean',
                required: true,
                helpText: 'Properties over $1 million are subject to additional mansion tax'
            });
            questions.push({
                id: 'ny_cema',
                label: 'Will you be requesting a CEMA (Consolidation Extension Modification Agreement)?',
                type: 'boolean',
                required: false,
                helpText: 'CEMA can reduce mortgage recording tax on refinances'
            });
            break;
            
        case 'CA':
            questions.push({
                id: 'ca_county_transfer_tax',
                label: 'County Transfer Tax Rate',
                type: 'number',
                required: true,
                min: 0,
                max: 10,
                helpText: 'Enter the county transfer tax rate as a percentage'
            });
            questions.push({
                id: 'ca_homeowners_exemption',
                label: 'Will you be claiming homeowner\'s exemption?',
                type: 'boolean',
                required: false,
                helpText: 'Homeowner\'s exemption may affect property taxes'
            });
            break;
            
        case 'FL':
            questions.push({
                id: 'fl_homestead',
                label: 'Will this be your primary residence (Homestead)?',
                type: 'boolean',
                required: true,
                helpText: 'Homestead properties have different fee structures'
            });
            questions.push({
                id: 'fl_doc_stamps_paid_by',
                label: 'Who pays documentary stamps?',
                type: 'select',
                required: true,
                options: ['Buyer', 'Seller', 'Split'],
                helpText: 'Documentary stamp tax payment responsibility'
            });
            break;
            
        case 'TX':
            questions.push({
                id: 'tx_survey_required',
                label: 'Is a new survey required?',
                type: 'boolean',
                required: true,
                helpText: 'New survey may be required for title insurance'
            });
            questions.push({
                id: 'tx_mud_district',
                label: 'Is the property in a MUD district?',
                type: 'boolean',
                required: true,
                helpText: 'Municipal Utility District properties have additional fees'
            });
            break;
    }
    
    return questions;
}

/**
 * Get transaction-specific questions
 */
function getTransactionSpecificQuestions(loanPurposeType) {
    const questions = [];
    
    if (loanPurposeType === 'Refinance') {
        questions.push({
            id: 'current_loan_amount',
            label: 'Current Loan Balance',
            type: 'number',
            required: true,
            min: 0,
            helpText: 'Enter the current outstanding loan balance'
        });
        questions.push({
            id: 'cash_out_amount',
            label: 'Cash Out Amount',
            type: 'number',
            required: false,
            min: 0,
            helpText: 'Enter cash out amount if this is a cash-out refinance'
        });
        questions.push({
            id: 'original_purchase_date',
            label: 'Original Purchase Date',
            type: 'date',
            required: true,
            helpText: 'When was the property originally purchased?'
        });
    } else if (loanPurposeType === 'Purchase' || loanPurposeType === 'Cash Purchase') {
        questions.push({
            id: 'first_time_buyer',
            label: 'Are you a first-time homebuyer?',
            type: 'boolean',
            required: true,
            helpText: 'First-time buyers may qualify for reduced fees'
        });
        questions.push({
            id: 'seller_concessions',
            label: 'Seller Concessions Amount',
            type: 'number',
            required: false,
            min: 0,
            helpText: 'Enter any seller concessions toward closing costs'
        });
    }
    
    if (loanPurposeType !== 'Cash Purchase') {
        questions.push({
            id: 'loan_type',
            label: 'Loan Type',
            type: 'select',
            required: true,
            options: ['Conventional', 'FHA', 'VA', 'USDA', 'Jumbo', 'Other'],
            helpText: 'Select the type of loan'
        });
        questions.push({
            id: 'lender_name',
            label: 'Lender Name',
            type: 'text',
            required: false,
            helpText: 'Enter the name of the lending institution'
        });
    }
    
    return questions;
}

/**
 * Parse questions from FirstAm API response
 * This would be implemented based on actual API response structure
 */
function parseQuestionsFromResponse(parsedResponse) {
    // This would parse the actual XML response from FirstAm
    // and convert it to our question format
    // Implementation depends on FirstAm's response structure
    
    const questions = [];
    
    // Example parsing logic (would need to be adapted to actual response):
    /*
    const questionNodes = parsedResponse['lvis:LVIS_XML']?.['lvis:QUESTIONS']?.['lvis:QUESTION'];
    
    if (questionNodes) {
        const questionArray = Array.isArray(questionNodes) ? questionNodes : [questionNodes];
        
        questionArray.forEach(q => {
            questions.push({
                id: q['lvis:QuestionId'],
                label: q['lvis:QuestionText'],
                type: mapQuestionType(q['lvis:QuestionType']),
                required: q['lvis:IsRequired'] === 'true',
                options: parseOptions(q['lvis:Options']),
                helpText: q['lvis:HelpText'],
                validation: q['lvis:ValidationRules']
            });
        });
    }
    */
    
    return questions;
}

module.exports = {
    getQuestions
};
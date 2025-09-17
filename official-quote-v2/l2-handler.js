const axios = require('axios');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const { getOAuthToken } = require('../shared/auth');
const { mapAnswersToL2Format } = require('./question-parser');

/**
 * Handle L2 request with user answers to get final rates
 * 
 * @param {Object} params - L2 request parameters
 * @param {Object} params.calcRateLevel2Data - Original L2 data from L1 response
 * @param {Object} params.originalMISMO - Original MISMO XML from L1 request
 * @param {Object} params.userAnswers - User-provided answers to L2 questions
 * @returns {Object} Final rates and fees
 */
async function handleL2Request(params) {
    const {
        calcRateLevel2Data,
        originalMISMO,
        userAnswers
    } = params;
    
    console.info('Processing L2 request with user answers');
    
    try {
        // Get OAuth token
        const token = await getOAuthToken();
        
        // Update CalcRateLevel2Data with user answers
        const updatedL2Data = mapAnswersToL2Format(calcRateLevel2Data, userAnswers);
        
        if (!updatedL2Data) {
            throw new Error('Failed to map user answers to L2 format');
        }
        
        // Build L2 request XML
        const l2RequestXML = buildL2RequestXML({
            calcRateLevel2Data: updatedL2Data,
            originalMISMO
        });
        
        console.info('Sending L2 RateCalc request...');
        
        // Send L2 request
        const l2Response = await axios.post(
            'https://calculator.lvis.firstam.com/',
            l2RequestXML,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/xml'
                }
            }
        );
        
        console.info('L2 Response received, parsing final rates...');
        
        // Parse L2 response
        const parsedL2Response = await xml2js.parseStringPromise(l2Response.data, {
            explicitArray: false,
            ignoreAttrs: false,
        });
        
        // Debug log the raw response (first 2000 chars)
        console.info('L2 Raw Response (first 2000 chars):', l2Response.data.substring(0, 2000));
        
        // Extract fees and loan comments
        const fees = extractFeesFromL2Response(parsedL2Response);
        const loanComments = extractLoanCommentsFromL2Response(parsedL2Response);
        
        // Process fees similar to quick quote
        const processedFees = processFees(fees);
        
        // Calculate totals
        const totalBuyerFee = processedFees.reduce((sum, fee) => 
            sum + parseFloat(fee.BuyerFee || 0), 0
        );
        const totalSellerFee = processedFees.reduce((sum, fee) => 
            sum + parseFloat(fee.SellerFee || 0), 0
        );
        
        // Extract and clean loan comment text
        const loanComment = loanComments.find(comment => 
            comment['$']?.['xlink:label'] === 'RESPONSE_NOTE_1'
        );
        let loanCommentText = loanComment ? loanComment.LoanCommentText : '';
        if (Array.isArray(loanCommentText)) {
            loanCommentText = loanCommentText[0];
        }
        loanCommentText = (loanCommentText || '').replace(/<[^>]+>/g, ''); // Remove HTML tags
        
        return {
            type: 'final_rates',
            hasCalculatedRates: true,
            fees: processedFees,
            totalBuyerFee: totalBuyerFee.toFixed(2),
            totalSellerFee: totalSellerFee.toFixed(2),
            loanCommentText,
            rawResponse: {
                fees,
                loanComments
            }
        };
        
    } catch (error) {
        console.error('Error in L2 request:', error);
        throw new Error(`Failed to process L2 request: ${error.message}`);
    }
}

/**
 * Build L2 request XML with answers and original data
 */
function buildL2RequestXML({ calcRateLevel2Data, originalMISMO }) {
    // Convert the updated L2 data back to XML format
    const builder = new xml2js.Builder({
        renderOpts: { pretty: false },
        xmldec: { version: '1.0', encoding: 'utf-8' }
    });
    
    // Build the CalcRateLevel2Data XML - will be namespaced properly
    const l2DataObj = {
        'lvis:CalcRateLevel2Data': calcRateLevel2Data
    };
    const l2DataXML = builder.buildObject(l2DataObj)
        .replace('<?xml version="1.0" encoding="utf-8"?>', '')
        .replace('<lvis:CalcRateLevel2Data', '<lvis:CalcRateLevel2Data')
        .replace('</lvis:CalcRateLevel2Data>', '</lvis:CalcRateLevel2Data>')
        .trim();
    
    // Build the MISMO XML if provided - should be included in L2 submit based on simulator
    let mismoXML = '';
    if (originalMISMO) {
        const mismoObj = {
            'lvis:MISMO_XML': originalMISMO
        };
        mismoXML = builder.buildObject(mismoObj)
            .replace('<?xml version="1.0" encoding="utf-8"?>', '')
            .replace('<lvis:MISMO_XML', '<lvis:MISMO_XML')
            .replace('</lvis:MISMO_XML>', '</lvis:MISMO_XML>')
            .trim();
    }
    
    // Construct the complete L2 request - includes both CalcRateLevel2Data AND MISMO_XML
    // This matches the simulator's second RateCalcNoAutoCalc request structure
    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>RateCalcNoAutoCalc</lvis:LVISActionType>
    <lvis:ClientCustomerId>FNTE</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>L2-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_CALCULATOR_REQUEST>
    ${l2DataXML}
    ${mismoXML}
  </lvis:LVIS_CALCULATOR_REQUEST>
</lvis:LVIS_XML>`;
}

/**
 * Extract fees from L2 response
 */
function extractFeesFromL2Response(parsedResponse) {
    try {
        // Debug log the structure
        console.info('L2 Response structure keys:', Object.keys(parsedResponse));
        
        // Check if we have the expected structure
        const lvisXML = parsedResponse['lvis:LVIS_XML'];
        if (lvisXML) {
            const calcResponse = lvisXML['lvis:LVIS_CALCULATOR_RESPONSE'];
            if (calcResponse) {
                console.info('Calculator response keys:', Object.keys(calcResponse));
                
                // The MISMO_XML section doesn't have lvis: namespace
                const mismoXML = calcResponse['lvis:MISMO_XML'];
                if (mismoXML) {
                    console.info('MISMO_XML type:', typeof mismoXML);
                    
                    // Handle both array and non-array formats
                    const message = Array.isArray(mismoXML) ? mismoXML[0]['MESSAGE'] : mismoXML['MESSAGE'];
                    
                    if (message) {
                        const messageParsed = Array.isArray(message) ? message[0] : message;
                        const path = messageParsed?.['DEAL_SETS']?.['DEAL_SET']?.
                            ['DEALS']?.['DEAL']?.['LOANS']?.['LOAN']?.['FEE_INFORMATION']?.
                            ['FEES']?.['FEE'];
                        
                        if (path) {
                            console.info(`Found ${Array.isArray(path) ? path.length : 1} fees in L2 response`);
                            return Array.isArray(path) ? path : [path];
                        }
                    }
                }
            }
        }
        
        console.warn('No fees found in L2 response - structure not as expected');
        return [];
    } catch (error) {
        console.error('Error extracting fees from L2 response:', error);
        return [];
    }
}

/**
 * Extract loan comments from L2 response
 */
function extractLoanCommentsFromL2Response(parsedResponse) {
    try {
        const lvisXML = parsedResponse['lvis:LVIS_XML'];
        if (lvisXML) {
            const calcResponse = lvisXML['lvis:LVIS_CALCULATOR_RESPONSE'];
            if (calcResponse) {
                // The MISMO_XML section doesn't have lvis: namespace
                const mismoXML = calcResponse['lvis:MISMO_XML'];
                if (mismoXML) {
                    // Handle both array and non-array formats
                    const message = Array.isArray(mismoXML) ? mismoXML[0]['MESSAGE'] : mismoXML['MESSAGE'];
                    
                    if (message) {
                        const messageParsed = Array.isArray(message) ? message[0] : message;
                        const path = messageParsed?.['DEAL_SETS']?.['DEAL_SET']?.
                            ['DEALS']?.['DEAL']?.['LOANS']?.['LOAN']?.['LOAN_COMMENTS']?.
                            ['LOAN_COMMENT'];
                        
                        if (path) {
                            console.info(`Found ${Array.isArray(path) ? path.length : 1} loan comments in L2 response`);
                            return Array.isArray(path) ? path : [path];
                        }
                    }
                }
            }
        }
        
        console.warn('No loan comments found in L2 response');
        return [];
    } catch (error) {
        console.error('Error extracting loan comments from L2 response:', error);
        return [];
    }
}

/**
 * Process fees to extract buyer/seller amounts
 */
function processFees(fees) {
    const processedFees = [];
    
    fees.forEach((fee, index) => {
        try {
            // Debug first fee structure
            if (index === 0) {
                console.info('First fee structure:', JSON.stringify(fee).substring(0, 500));
            }
            
            const feeDetail = fee['FEE_DETAIL'];
            const feePayments = fee['FEE_PAYMENTS']?.['FEE_PAYMENT'] || [];
            
            // Handle both string and array formats - with explicitArray: false, it's a string
            const feeDescription = feeDetail?.['FeeDescription'] || 'Unknown Fee';
            
            const disclosureItemName = feeDetail?.['DisclosureItemName'] || '';
            
            // Extract buyer and seller amounts
            let buyerAmount = 0;
            let sellerAmount = 0;
            
            const payments = Array.isArray(feePayments) ? feePayments : [feePayments];
            
            payments.forEach(payment => {
                // With explicitArray: false, these are direct strings/numbers
                const paidByType = payment['FeePaymentPaidByType'];
                
                const actualAmount = parseFloat(
                    payment['FeeActualPaymentAmount'] || 0
                );
                
                const estimatedAmount = parseFloat(
                    payment['FeeEstimatedPaymentAmount'] || 0
                );
                
                const amount = actualAmount || estimatedAmount;
                
                if (paidByType === 'Buyer') {
                    buyerAmount += amount;
                } else if (paidByType === 'Seller') {
                    sellerAmount += amount;
                }
            });
            
            processedFees.push({
                FeeDescription: feeDescription,
                DisclosureItemName: disclosureItemName,
                BuyerFee: buyerAmount.toFixed(2),
                SellerFee: sellerAmount.toFixed(2)
            });
        } catch (error) {
            console.error('Error processing fee:', error);
        }
    });
    
    return processedFees;
}

/**
 * Build summary of L2 transaction
 */
function buildL2Summary(fees, answers, questions) {
    const summary = {
        totalFees: fees.length,
        questionsAnswered: Object.keys(answers).length,
        totalQuestions: questions.length,
        timestamp: new Date().toISOString()
    };
    
    // Group fees by type
    summary.feesByType = {
        title: fees.filter(f => f.FeeDescription.toLowerCase().includes('title')),
        recording: fees.filter(f => f.FeeDescription.toLowerCase().includes('recording')),
        settlement: fees.filter(f => f.FeeDescription.toLowerCase().includes('settlement')),
        tax: fees.filter(f => f.FeeDescription.toLowerCase().includes('tax')),
        other: fees.filter(f => 
            !f.FeeDescription.toLowerCase().includes('title') &&
            !f.FeeDescription.toLowerCase().includes('recording') &&
            !f.FeeDescription.toLowerCase().includes('settlement') &&
            !f.FeeDescription.toLowerCase().includes('tax')
        )
    };
    
    return summary;
}

module.exports = {
    handleL2Request,
    buildL2Summary
};
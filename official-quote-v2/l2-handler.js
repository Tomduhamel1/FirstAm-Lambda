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
    
    // Build the CalcRateLevel2Data XML
    const l2DataXML = builder.buildObject({ 
        'lvis:CalcRateLevel2Data': calcRateLevel2Data 
    }).replace('<?xml version="1.0" encoding="utf-8"?>', '');
    
    // Build the original MISMO XML
    const mismoXML = builder.buildObject({ 
        'lvis:MISMO_XML': originalMISMO 
    }).replace('<?xml version="1.0" encoding="utf-8"?>', '');
    
    // Construct the complete L2 request
    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>RateCalc</lvis:LVISActionType>
    <lvis:ClientCustomerId>FNTE</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>L2-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_CALCULATOR_RESPONSE>
    ${l2DataXML}
    <lvis:HasCalculatedRates>false</lvis:HasCalculatedRates>
    ${mismoXML}
  </lvis:LVIS_CALCULATOR_RESPONSE>
</lvis:LVIS_XML>`;
}

/**
 * Extract fees from L2 response
 */
function extractFeesFromL2Response(parsedResponse) {
    try {
        const path = parsedResponse['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_RESPONSE']?.
            ['lvis:MISMO_XML']?.['MESSAGE']?.['DEAL_SETS']?.['DEAL_SET']?.
            ['DEALS']?.['DEAL']?.['LOANS']?.['LOAN']?.['FEE_INFORMATION']?.
            ['FEES']?.['FEE'];
        
        if (!path) {
            console.warn('No fees found in L2 response');
            return [];
        }
        
        return Array.isArray(path) ? path : [path];
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
        const path = parsedResponse['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_RESPONSE']?.
            ['lvis:MISMO_XML']?.['MESSAGE']?.['DEAL_SETS']?.['DEAL_SET']?.
            ['DEALS']?.['DEAL']?.['LOANS']?.['LOAN']?.['LOAN_COMMENTS']?.
            ['LOAN_COMMENT'];
        
        if (!path) {
            console.warn('No loan comments found in L2 response');
            return [];
        }
        
        return Array.isArray(path) ? path : [path];
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
    
    fees.forEach(fee => {
        try {
            const feeDetail = fee['FEE_DETAIL']?.[0] || fee['FEE_DETAIL'];
            const feePayments = fee['FEE_PAYMENTS']?.[0]?.['FEE_PAYMENT'] || 
                               fee['FEE_PAYMENTS']?.['FEE_PAYMENT'] || [];
            
            const feeDescription = feeDetail?.['FeeDescription']?.[0] || 
                                 feeDetail?.['FeeDescription'] || 
                                 'Unknown Fee';
            
            const disclosureItemName = feeDetail?.['DisclosureItemName']?.[0] || 
                                      feeDetail?.['DisclosureItemName'] || '';
            
            // Extract buyer and seller amounts
            let buyerAmount = 0;
            let sellerAmount = 0;
            
            const payments = Array.isArray(feePayments) ? feePayments : [feePayments];
            
            payments.forEach(payment => {
                const paidByType = payment['FeePaymentPaidByType']?.[0] || 
                                 payment['FeePaymentPaidByType'];
                
                const actualAmount = parseFloat(
                    payment['FeeActualPaymentAmount']?.[0] || 
                    payment['FeeActualPaymentAmount'] || 0
                );
                
                const estimatedAmount = parseFloat(
                    payment['FeeEstimatedPaymentAmount']?.[0] || 
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
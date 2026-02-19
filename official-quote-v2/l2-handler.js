const axios = require('axios');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const { getOAuthToken } = require('../shared/auth');
const { getStateFees } = require('../shared/database');
const { mapAnswersToL2Format } = require('./question-parser');
const { applyCentralizedRateIfEligible } = require('../shared/centralized-integration');
const { extractEndorsementFees, buildEndorsementFeeLineItems } = require('./endorsement-utils');
const { addFNTEFeesToResponse } = require('../shared/fnte-fees');

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
        userAnswers,
        pageNumbers = null,
        // Centralized rate integration parameters
        stateCode,
        countyName,
        loanPurposeType,
        noteAmount,
        originalNoteAmount,  // For zeroing out lender's policy on cash deals
        // Endorsements metadata from L1
        endorsements = null
    } = params;

    console.info('Processing L2 request with user answers');
    if (pageNumbers) {
        console.info('Page numbers provided for L2 request:', pageNumbers);
    }
    
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
        
        // Extract fees, parties and loan comments
        const { fees, parties } = extractFeesAndPartiesFromL2Response(parsedL2Response);
        const loanComments = extractLoanCommentsFromL2Response(parsedL2Response);

        // Process fees similar to quick quote, including party information
        const processedFees = processFees(fees, parties);

        // Apply centralized rates if eligible (refinance + centralized state)
        let finalFees = processedFees;
        if (stateCode && loanPurposeType && noteAmount !== undefined) {
            const centralizedResult = applyCentralizedRateIfEligible(
                processedFees,
                stateCode,
                loanPurposeType,
                noteAmount,
                countyName,
                'simple'
            );

            finalFees = centralizedResult.fees;

            // Zero out lender's policy amounts if original NoteAmount was 0 (cash deal)
            if (originalNoteAmount === 0 && loanPurposeType !== 'Cash Purchase') {
                console.info(`💰 NoteAmount was 0 - zeroing out lender's policy amounts for backward compatibility`);
                finalFees.forEach(fee => {
                    if (fee.FeeDescription && fee.FeeDescription.includes('Lender')) {
                        console.info(`   Zeroing: ${fee.FeeDescription}`);
                        fee.BuyerFee = "0";
                        fee.SellerFee = "0";
                    }
                });
            }

            if (centralizedResult.centralizedRateApplied) {
                console.info(`[L2 Handler] Using centralized rate: $${centralizedResult.centralizedRate} for ${stateCode} refinance`);
            } else {
                console.info(`[L2 Handler] Using RateCalc fees: ${centralizedResult.reason || 'Not applicable'}`);
            }
        } else {
            console.info('[L2 Handler] Skipping centralized rate check - missing required parameters');
        }

        // Extract and add endorsement fees if endorsements metadata was provided from L1
        if (endorsements && endorsements.defaults && endorsements.defaults.length > 0) {
            console.info(`📋 L2 Handler: Extracting endorsement fees from L2 response`);

            // Extract endorsement fees from L2 response
            const endorsementFees = extractEndorsementFees(fees);
            console.info(`Found ${endorsementFees.length} endorsement fees in L2 response`);

            // Match L1 default endorsements with L2 pricing
            const defaultsWithL2Pricing = endorsements.defaults.map(defaultEndorsement => {
                const matchingFee = endorsementFees.find(fee => {
                    // Try exact name match first
                    if (fee.name === defaultEndorsement.name) return true;
                    // Try partial name match
                    if (fee.name.includes(defaultEndorsement.name) || defaultEndorsement.name.includes(fee.name)) return true;
                    return false;
                });

                if (matchingFee) {
                    console.info(`✓ Matched endorsement "${defaultEndorsement.name}" with pricing from L2`);
                    return { ...defaultEndorsement, pricing: matchingFee.pricing };
                }
                console.warn(`✗ No pricing found for endorsement "${defaultEndorsement.name}" in L2 response`);
                return defaultEndorsement;
            });

            // Build endorsement fee line items (only includes endorsements with pricing)
            const endorsementFeeLineItems = buildEndorsementFeeLineItems(defaultsWithL2Pricing);

            if (endorsementFeeLineItems.length > 0) {
                console.info(`Adding ${endorsementFeeLineItems.length} default endorsement fees to response`);

                // Convert to simple fee format for backward compatibility
                // Use disclosed amounts when available, otherwise use actual amounts
                const simpleEndorsementFees = endorsementFeeLineItems.map(item => {
                    // For endorsements: use disclosed if > 0, otherwise use actual
                    const buyerFee = parseFloat(item.Buyer.disclosedAmount) > 0
                        ? item.Buyer.disclosedAmount
                        : item.Buyer.actualAmount;
                    const sellerFee = parseFloat(item.Seller.disclosedAmount) > 0
                        ? item.Seller.disclosedAmount
                        : item.Seller.actualAmount;

                    return {
                        FeeDescription: item.FeeDescription,
                        DisclosureItemName: item.DisclosureItemName || item.FeeDescription,
                        BuyerFee: buyerFee,
                        SellerFee: sellerFee,
                        HUDLine: item.HUDLine || '',
                        DisclosureSection: item.DisclosureSection || 'B or C',
                        DisclosureSectionName: item.DisclosureSectionName || 'Title Services - Endorsements'
                    };
                });

                // Add endorsement fees to final fees array
                finalFees.push(...simpleEndorsementFees);
                console.info(`✅ Successfully added ${simpleEndorsementFees.length} endorsement fees to final fees`);
            } else {
                console.info('No endorsement fees with pricing found to add');
            }
        } else if (endorsements) {
            console.info('L2 Handler: Endorsements metadata provided but no defaults found');
        } else {
            console.info('L2 Handler: No endorsements metadata provided from L1');
        }

        // Add FNTE state-specific fees (settlement, notary, tax review, etc.)
        await addFNTEFeesToResponse(finalFees, stateCode, loanPurposeType, 'L2 Handler');

        // Calculate totals
        const totalBuyerFee = finalFees.reduce((sum, fee) =>
            sum + parseFloat(fee.BuyerFee || 0), 0
        );
        const totalSellerFee = finalFees.reduce((sum, fee) =>
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
            fees: finalFees,
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
 * Extract fees and parties from L2 response
 */
function extractFeesAndPartiesFromL2Response(parsedResponse) {
    try {
        // Debug log the structure
        console.info('L2 Response structure keys:', Object.keys(parsedResponse));

        let fees = [];
        let parties = [];

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

                    // Log the raw XML for debugging
                    console.info('Raw MISMO XML (first 3000 chars):', JSON.stringify(mismoXML).substring(0, 3000));

                    // Handle both array and non-array formats
                    const message = Array.isArray(mismoXML) ? mismoXML[0]['MESSAGE'] : mismoXML['MESSAGE'];

                    if (message) {
                        const messageParsed = Array.isArray(message) ? message[0] : message;

                        // Extract fees
                        const feePath = messageParsed?.['DEAL_SETS']?.['DEAL_SET']?.
                            ['DEALS']?.['DEAL']?.['LOANS']?.['LOAN']?.['FEE_INFORMATION']?.
                            ['FEES']?.['FEE'];

                        if (feePath) {
                            console.info(`Found ${Array.isArray(feePath) ? feePath.length : 1} fees in L2 response`);
                            fees = Array.isArray(feePath) ? feePath : [feePath];
                        }

                        // Extract parties for contact information
                        const partiesPath = messageParsed?.['DEAL_SETS']?.['DEAL_SET']?.
                            ['DEALS']?.['DEAL']?.['PARTIES']?.['PARTY'];

                        if (partiesPath) {
                            console.info(`Found ${Array.isArray(partiesPath) ? partiesPath.length : 1} parties in L2 response`);
                            parties = Array.isArray(partiesPath) ? partiesPath : [partiesPath];
                        }
                    }
                }
            }
        }

        if (fees.length === 0) {
            console.warn('No fees found in L2 response - structure not as expected');
        }

        return { fees, parties };
    } catch (error) {
        console.error('Error extracting fees from L2 response:', error);
        return { fees: [], parties: [] };
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
 * Process fees to extract buyer/seller amounts and payee information
 */
function processFees(fees, parties = []) {
    // Build a map of party names to their contact information
    const partyMap = {};
    parties.forEach(party => {
        const legalEntity = party['LEGAL_ENTITY'];
        if (legalEntity) {
            // Try to get the name from AttentionToName or FullName
            const addresses = party['ADDRESSES']?.['ADDRESS'];
            let partyName = null;

            if (addresses) {
                const addressArray = Array.isArray(addresses) ? addresses : [addresses];
                for (const address of addressArray) {
                    if (address['AttentionToName']) {
                        partyName = address['AttentionToName'];
                        break;
                    }
                }
            }

            // Fallback to FullName if no AttentionToName
            if (!partyName && legalEntity['LEGAL_ENTITY_DETAIL']) {
                partyName = legalEntity['LEGAL_ENTITY_DETAIL']['FullName'];
            }

            if (partyName) {
                // Extract address information
                let address = '';
                let website = '';

                if (addresses) {
                    const addressArray = Array.isArray(addresses) ? addresses : [addresses];
                    for (const addr of addressArray) {
                        if (addr['$']?.['xlink:label'] === 'MAILING' || addr['AddressLineText']) {
                            const parts = [];
                            if (addr['AddressAdditionalLineText']) parts.push(addr['AddressAdditionalLineText']);
                            if (addr['AddressLineText']) parts.push(addr['AddressLineText']);
                            if (addr['CityName']) parts.push(addr['CityName']);
                            if (addr['StateCode']) parts.push(addr['StateCode']);
                            if (addr['PostalCode']) parts.push(addr['PostalCode']);
                            if (parts.length > 0) {
                                address = parts.join(', ');
                                break;
                            }
                        }
                    }
                }

                // Extract website from CONTACTS
                const contacts = legalEntity['CONTACTS']?.['CONTACT'];
                if (contacts) {
                    const contactArray = Array.isArray(contacts) ? contacts : [contacts];
                    for (const contact of contactArray) {
                        if (contact['$']?.['xlink:label'] === 'RelatedOfficeWebsite' ||
                            contact['$']?.['xlink:label']?.includes('Website')) {
                            const contactPoints = contact['CONTACT_POINTS']?.['CONTACT_POINT'];
                            if (contactPoints) {
                                const pointArray = Array.isArray(contactPoints) ? contactPoints : [contactPoints];
                                for (const point of pointArray) {
                                    const otherContact = point['OTHER_CONTACT_POINT'];
                                    if (otherContact?.['ContactPointOtherValueDescription']) {
                                        const desc = otherContact['ContactPointOtherValueDescription'];
                                        if (desc.includes('http') || desc.includes('www')) {
                                            website = desc;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                partyMap[partyName] = { address, website };
            }
        }
    });

    console.info('Party map built:', JSON.stringify(partyMap));

    const processedFees = [];

    fees.forEach((fee, index) => {
        try {
            // Extract fee label and description for filtering
            const feeLabel = fee['$']?.['xlink:label'] || '';
            const feeDetail = fee['FEE_DETAIL'];
            const feeDescription = feeDetail?.['FeeDescription'] || 'Unknown Fee';

            // Skip Simultaneous Issue fees (lender's policy discount, not a standalone fee)
            if (feeDescription.toLowerCase().includes('simultaneous')) {
                console.info(`Skipping Simultaneous Issue fee: ${feeDescription}`);
                return;
            }

            // Skip endorsement fees (will be added separately with metadata)
            if (feeLabel.includes('ENDR') || feeDescription.includes('Endorsement')) {
                console.info(`Skipping endorsement (will be added separately): ${feeDescription}`);
                return;
            }

            // Debug first fee structure
            if (index === 0) {
                console.info('First fee structure:', JSON.stringify(fee).substring(0, 1500));
                console.info('Fee keys:', Object.keys(fee));
            }
            const feePayments = fee['FEE_PAYMENTS']?.['FEE_PAYMENT'] || [];
            const feePaidTo = fee['FEE_PAID_TO'];

            // Debug: Check if FEE_PAID_TO exists
            if (index < 5) {
                console.info(`Fee ${index} has FEE_PAID_TO:`, !!feePaidTo, feePaidTo ? JSON.stringify(feePaidTo).substring(0, 200) : 'undefined');
            }

            // Handle both string and array formats - with explicitArray: false, it's a string
            // feeDescription already extracted at the top for filtering
            const disclosureItemName = feeDetail?.['DisclosureItemName'] || '';

            // Extract payee name from FEE_PAID_TO structure
            let payeeName = '';
            let payeeAddress = '';
            let payeeWebsite = '';

            if (feePaidTo) {
                const legalEntity = feePaidTo['LEGAL_ENTITY'];
                if (legalEntity) {
                    const legalEntityDetail = legalEntity['LEGAL_ENTITY_DETAIL'];
                    if (legalEntityDetail) {
                        payeeName = legalEntityDetail['FullName'] || '';
                    }
                }
            }

            // Look up contact information from party map
            if (payeeName && partyMap[payeeName]) {
                const partyInfo = partyMap[payeeName];
                payeeAddress = partyInfo.address || '';
                payeeWebsite = partyInfo.website || '';
                console.info(`Found party info for ${payeeName}:`, partyInfo);
            }

            // Also check FeePaidToType for generic type if no specific name
            const feePaidToType = feeDetail?.['FeePaidToType'] || '';

            // Extract buyer and seller amounts
            let buyerAmount = 0;
            let sellerAmount = 0;

            const payments = Array.isArray(feePayments) ? feePayments : [feePayments];

            // FIRST: Determine if ANY payment has estimated amounts in sequences 3-4
            // This prevents double-counting by choosing one strategy for the entire fee
            const hasAnyEstimated = payments.some(payment => {
                const sequenceNumber = payment['$']?.['SequenceNumber'];
                const isEstimatedSequence = sequenceNumber === '3' || sequenceNumber === '4';
                if (!isEstimatedSequence) return false;

                const estimatedAmount = payment['FeeEstimatedPaymentAmount'];
                return estimatedAmount !== undefined &&
                       estimatedAmount !== null &&
                       estimatedAmount !== '' &&
                       parseFloat(estimatedAmount) > 0;
            });

            console.info(`Fee "${feeDescription}": hasAnyEstimated=${hasAnyEstimated}`);

            // SECOND: Process payments using the chosen strategy
            payments.forEach(payment => {
                const paidByType = payment['FeePaymentPaidByType'];
                const sequenceNumber = payment['$']?.['SequenceNumber'];

                let amount;

                if (hasAnyEstimated) {
                    // Strategy 1: Use ONLY estimated amounts from sequences 3-4
                    if (sequenceNumber === '3' || sequenceNumber === '4') {
                        amount = parseFloat(payment['FeeEstimatedPaymentAmount'] || 0);
                        console.info(`  Seq ${sequenceNumber} (${paidByType}): Using ESTIMATED $${amount}`);
                    } else {
                        // Skip sequences 1-2 when estimated amounts exist
                        console.info(`  Seq ${sequenceNumber} (${paidByType}): Skipping (using estimated instead)`);
                        return;
                    }
                } else {
                    // Strategy 2: Use ONLY actual amounts from sequences 1-2
                    if (sequenceNumber === '1' || sequenceNumber === '2') {
                        amount = parseFloat(payment['FeeActualPaymentAmount'] || 0);
                        console.info(`  Seq ${sequenceNumber} (${paidByType}): Using ACTUAL $${amount}`);
                    } else {
                        // Skip sequences 3-4 when no estimated amounts exist
                        console.info(`  Seq ${sequenceNumber} (${paidByType}): Skipping (no estimated available)`);
                        return;
                    }
                }

                if (paidByType === 'Buyer') {
                    buyerAmount += amount;
                } else if (paidByType === 'Seller') {
                    sellerAmount += amount;
                }
            });

            processedFees.push({
                FeeDescription: feeDescription,
                DisclosureItemName: disclosureItemName,
                PayeeName: payeeName,
                PayeeAddress: payeeAddress,
                PayeeWebsite: payeeWebsite,
                FeePaidToType: feePaidToType,
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
    buildL2Summary,
    processFees
};
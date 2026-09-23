const axios = require('axios');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const { getOAuthToken } = require('../shared/auth');
const { getZipCodeData, getStateFees } = require('../shared/database');
const {
    buildProductListRequestXML,
    buildRateCalcRequestXML,
    parseProductList,
    buildTitleServiceBlock,
    buildSettlementServiceBlock,
    buildRecordingServiceBlock,
    buildTransactionTypesRequestXML,
    parseTransactionTypesResponse,
    normalizeCountyForFirstAm
} = require('../shared/xml-builders');
const constants = require('../shared/constants');
const { applyCentralizedRateIfEligible } = require('../shared/centralized-integration');
const { firstAmRequestWithRetry } = require('../shared/firstam-retry');

/**
 * Handle L1 (initial) RateCalc request for official quotes
 * This checks if L2 questions are needed or if rates are immediately available
 * 
 * @param {Object} params - Quote parameters
 * @returns {Object} Either rates or L2 questions
 */
async function handleL1Request(params) {
    const {
        PostalCode,
        SalesContractAmount,
        NoteAmount,
        LoanPurposeType,
        forceL2Questions = false, // Use RateCalcNoAutoCalc to force L2 questions
        pageNumbers = null // Optional page numbers for recording documents
    } = params;

    console.info('L1 Request for official quote:', { PostalCode, LoanPurposeType, forceL2Questions });
    
    try {
        // Get OAuth token
        const token = await getOAuthToken();
        
        // Get location data
        const zipCodeData = await getZipCodeData(PostalCode);
        const { city, county_name: countyName, state_id: stateCode } = zipCodeData;
        
        // Get state fees
        const stateFeeData = await getStateFees(stateCode);

        // Prepare transaction details
        const salesAmount = LoanPurposeType === 'Refinance' ? NoteAmount : SalesContractAmount;
        const originalNoteAmount = Number(NoteAmount);
        const noteAmount = originalNoteAmount === 0 ? 1000 : originalNoteAmount;

        const effectiveDate = new Date().toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: true
        });

        // Discover transaction type dynamically for TN (safe implementation)
        let transactionType;
        if (stateCode === 'TN') {
            try {
                console.info('🔍 TN detected - discovering available transaction types via TransactionTypes pre-request');

                const transactionTypesRequestXML = buildTransactionTypesRequestXML({
                    stateCode,
                    propertyType: 'Residential',
                    effectiveDate
                });

                console.info('📄 TransactionTypes Request XML:\n', transactionTypesRequestXML);

                const transactionTypesResponse = await firstAmRequestWithRetry({
                    method: 'post',
                    url: 'https://calculator.lvis.firstam.com/ProductList',
                    data: transactionTypesRequestXML,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/xml',
                    }
                }, { label: 'FirstAm TransactionTypes' });

                console.info("📦 TransactionTypes raw XML response:\n", transactionTypesResponse.data);

                const parsedTransactionTypes = await xml2js.parseStringPromise(transactionTypesResponse.data, {
                    explicitArray: false,
                    ignoreAttrs: false,
                });

                const availableTypes = parseTransactionTypesResponse(parsedTransactionTypes);

                if (availableTypes.length > 0) {
                    // Select appropriate type based on LoanPurposeType with smarter matching
                    if (LoanPurposeType === 'Refinance') {
                        // Prefer "Property Already Owned" for refinance, then any with "refinance"
                        transactionType = availableTypes.find(t =>
                            t.toLowerCase().includes('already owned')
                        ) || availableTypes.find(t =>
                            t.toLowerCase().includes('refinance')
                        ) || availableTypes[0];
                    } else {
                        // For Purchase, prefer "Simo" (simultaneous owner + loan), then "purchase", then "sale"
                        transactionType = availableTypes.find(t =>
                            t.toLowerCase().includes('simo')
                        ) || availableTypes.find(t =>
                            t.toLowerCase().includes('purchase')
                        ) || availableTypes.find(t =>
                            t.toLowerCase().includes('sale')
                        ) || availableTypes[0];
                    }
                    console.info(`✅ TN: Using discovered transaction type: "${transactionType}"`);
                } else {
                    throw new Error('No transaction types returned');
                }
            } catch (error) {
                // Fallback to hardcoded value if discovery fails
                console.warn(`⚠️ TN transaction type discovery failed: ${error.message}`);
                console.warn('Falling back to hardcoded transaction type');
                const stateSpecificTypes = constants.STATE_TRANSACTION_TYPES[stateCode];
                transactionType = LoanPurposeType === 'Refinance' ?
                    (stateSpecificTypes?.REFINANCE || constants.TRANSACTION_TYPES.REFINANCE) :
                    (stateSpecificTypes?.PURCHASE || constants.TRANSACTION_TYPES.PURCHASE);
            }
        } else {
            // All other states: use existing hardcoded logic
            transactionType = LoanPurposeType === 'Refinance' ? 'Refinance' : 'Sale w/ Mortgage';
        }

        console.info(`📋 Using transaction type: "${transactionType}" for ${stateCode}`);
        
        // Step 1: Get Product List (same as quick quote)
        const productListRequestXML = buildProductListRequestXML({
            stateCode,
            countyName,
            city,
            transactionType,
            salesContractAmount: salesAmount,
            noteAmount,
            effectiveDate,
        });
        
        console.info('Sending ProductList request...');
        
        const productListResponse = await firstAmRequestWithRetry({
            method: 'post',
            url: 'https://calculator.lvis.firstam.com/ProductList',
            data: productListRequestXML,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/xml',
            }
        }, { label: 'FirstAm ProductList' });

        // Log full ProductList response for debugging
        console.info('📦 ProductList raw XML response:\n', productListResponse.data);

        const parsedProductList = await xml2js.parseStringPromise(productListResponse.data, {
            explicitArray: false,
            ignoreAttrs: false,
        });
        
        const responseBody = parsedProductList?.['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_TYPE_DATA_RESPONSE']?.['lvis:CalcTypeData'];
        const productList = responseBody?.['lvis:ProductsList'];
        
        if (!productList) {
            throw new Error('No valid ProductsList found in ProductList response');
        }
        
        // Parse products
        const {
            titlePolicies,
            lenderPolicies,
            endorsementProducts,
            allEndorsements,  // NEW - full endorsement list for feature flag
            closingProducts,
            recordingProducts
        } = parseProductList(productList, transactionType);

        // Log all available endorsements for debugging
        console.info(`\n📚 AVAILABLE ENDORSEMENTS FOR ${stateCode}: ${allEndorsements.length} total`);
        if (allEndorsements.length > 0) {
            console.info('Full endorsement catalog:');
            allEndorsements.forEach((endr, idx) => {
                const id = endr['lvis:EndorsementId'];
                const name = endr['lvis:EndorsementName'] || 'Unknown';
                const validCategories = endr['lvis:ValidPolicyCategoryIds']?.['lvis:string'];
                const categories = Array.isArray(validCategories) ? validCategories.join(',') : validCategories;
                console.info(`  ${idx + 1}. ID ${id}: ${name} (Valid for categories: ${categories})`);
            });
        }

        // Build services block
        let currentSeq = 1;
        let servicesParts = [];

        servicesParts.push(
            buildTitleServiceBlock(
                titlePolicies,
                lenderPolicies,
                endorsementProducts,
                noteAmount,
                salesAmount,
                new Date().toISOString().split('T')[0],
                LoanPurposeType,
                stateCode,
                LoanPurposeType !== 'Refinance' && stateCode !== 'TX', // Disable endorsements for refinances and TX
                allEndorsements,          // Full endorsements list
                [],                       // Selected endorsement IDs (empty for L1)
                transactionType           // Transaction type for TN and other states
            )
        );
        
        // Skip settlement services for all states - causes errors with invalid closing product IDs
        console.info(`Skipping settlement services for ${stateCode} - prevents closing product errors`);
        currentSeq = 2; // Settlement would have been seq 2, so recording starts at 2
        
        const recordingResult = buildRecordingServiceBlock(recordingProducts, currentSeq, pageNumbers, salesAmount, noteAmount);
        if (recordingResult.xml) {
            servicesParts.push(recordingResult.xml);
        }
        
        const servicesBlock = servicesParts.join('\n');
        
        // Step 2: Send RateCalc L1 request
        const actionType = forceL2Questions ? 'RateCalcNoAutoCalc' : 'RateCalc';
        
        const requestXML = buildRateCalcRequestXML({
            actionType,
            PostalCode,
            SalesContractAmount: salesAmount,
            NoteAmount: noteAmount,
            LoanPurposeType,
            city,
            countyName,
            stateCode,
            servicesBlock
        });
        
        console.info(`Sending L1 RateCalc request (${actionType})...`);
        // Log full request XML for debugging
        console.info('📤 Full RateCalc Request XML:\n', requestXML);
        
        const l1Response = await firstAmRequestWithRetry({
            method: 'post',
            url: 'https://calculator.lvis.firstam.com/',
            data: requestXML,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/xml'
            }
        }, { label: 'FirstAm L1 RateCalc' });
        
        console.info('L1 Response received, parsing...');
        
        const parsedL1Response = await xml2js.parseStringPromise(l1Response.data, {
            explicitArray: false,
            ignoreAttrs: false,
        });
        
        // Debug: Check top-level structure
        console.info('Top level keys:', Object.keys(parsedL1Response));
        if (parsedL1Response['lvis:LVIS_XML']) {
            console.info('LVIS_XML keys:', Object.keys(parsedL1Response['lvis:LVIS_XML']));
            // Check for ACK_NACK
            const ackNack = parsedL1Response['lvis:LVIS_XML']['lvis:LVIS_ACK_NACK'];
            if (ackNack) {
                console.info('ACK_NACK Status:', ackNack['lvis:StatusCd'], 'Description:', ackNack['lvis:StatusDescription']);
                if (ackNack['lvis:StatusCd'] !== '1000') {
                    // Error occurred - log more details
                    console.error('Full ACK_NACK:', JSON.stringify(ackNack, null, 2));
                    const errorDetail = ackNack['lvis:StatusDetail'] || ackNack['lvis:StatusComment'] || ackNack['lvis:Comments'];
                    if (errorDetail) {
                        console.error('Error detail:', errorDetail);
                    }
                    // Log the echo'd request to see what we sent
                    const echoedRequest = parsedL1Response['lvis:LVIS_XML']['lvis:LVIS_CALCULATOR_REQUEST'];
                    if (echoedRequest) {
                        console.error('FirstAm echoed our request - checking MISMO structure');
                        const mismo = echoedRequest['lvis:MISMO_XML'];
                        if (mismo) {
                            console.info('MISMO present in echoed request');
                        }
                    }
                }
            }
        }
        
        // Check if rates are calculated or L2 questions are needed
        const calculatorResponse = parsedL1Response['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_RESPONSE'];
        console.info('Calculator response keys:', calculatorResponse ? Object.keys(calculatorResponse) : 'No calculator response');
        // Note: FirstAm has a typo in their field name - missing 'l' in Calculated
        const hasCalculatedRates = calculatorResponse?.['lvis:HasCalcuatedRates'] === 'true' || 
                                   calculatorResponse?.['lvis:HasCalculatedRates'] === 'true';
        
        if (hasCalculatedRates) {
            console.info('Rates calculated in L1 response');

            // Parse and return rates (similar to quick quote)
            const fees = parseFees(parsedL1Response);
            const loanComments = parseLoanComments(parsedL1Response);

            // Extract endorsement fees from RateCalc response
            const endorsementFees = extractEndorsementFees(fees);
            console.info(`📋 Extracted ${endorsementFees.length} endorsement fees from response`);

            // Categorize endorsements with pricing (now that we have fees)
            const availableEndorsements = allEndorsements.length > 0
                ? categorizeEndorsements(
                    titlePolicies,
                    lenderPolicies,
                    allEndorsements,
                    stateCode,
                    endorsementFees
                )
                : { defaults: [], optional: [] };

            console.info(`📚 Categorized endorsements: ${availableEndorsements.defaults.length} defaults, ${availableEndorsements.optional.length} optional`);

            // Apply centralized rates if eligible (refinance + centralized state)
            const centralizedResult = applyCentralizedRateIfEligible(
                fees,
                stateCode,
                LoanPurposeType,
                noteAmount,
                countyName,
                'raw'
            );

            // Use centralized fees if applied, otherwise use RateCalc fees
            const finalFees = centralizedResult.fees;

            if (centralizedResult.centralizedRateApplied) {
                console.info(`[L1 Handler] Using centralized rate: $${centralizedResult.centralizedRate} for ${stateCode} refinance`);
            } else {
                console.info(`[L1 Handler] Using RateCalc fees: ${centralizedResult.reason || 'Not applicable'}`);
            }

            // Add default endorsement fees to the fees array
            const endorsementFeeLineItems = buildEndorsementFeeLineItems(availableEndorsements.defaults);
            if (endorsementFeeLineItems.length > 0) {
                console.info(`Adding ${endorsementFeeLineItems.length} default endorsement fees to fees array`);
                finalFees.push(...endorsementFeeLineItems);
            }

            return {
                type: 'rates',
                hasCalculatedRates: true,
                fees: finalFees,
                loanComments,
                endorsements: availableEndorsements,
                locationData: {
                    city,
                    county: countyName,
                    state: stateCode
                },
                // Pass metadata needed for fee processing in handler.js
                stateCode,
                loanPurposeType: LoanPurposeType,
                noteAmount,
                originalNoteAmount,  // For zeroing out lender's policy on cash deals
                parties: parsedL1Response['lvis:MESSAGE']?.['lvis:DEAL_SETS']?.['lvis:DEAL_SET']?.['lvis:DEALS']?.['lvis:DEAL']?.['lvis:PARTIES']?.['lvis:PARTY'] || []
            };
        } else {
            console.info('L2 questions required');

            // Parse L2 questions
            const calcRateLevel2Data = calculatorResponse?.['lvis:CalcRateLevel2Data'];
            console.info('CalcRateLevel2Data present:', !!calcRateLevel2Data);
            if (calcRateLevel2Data) {
                console.info('CalcRateLevel2Data keys:', Object.keys(calcRateLevel2Data));
                // Check for RateCalcRequest
                const rateCalcRequest = calcRateLevel2Data['lvis:RateCalcRequest'];
                console.info('RateCalcRequest present:', !!rateCalcRequest);
                if (rateCalcRequest) {
                    const qandas = rateCalcRequest['lvis:QandAs'];
                    console.info('QandAs present:', !!qandas);
                }
            }
            const questions = parseL2Questions(calcRateLevel2Data);
            console.info('Parsed questions count:', questions.length);

            // Categorize endorsements (no pricing yet since no fees in L2 question response)
            const availableEndorsements = allEndorsements.length > 0
                ? categorizeEndorsements(
                    titlePolicies,
                    lenderPolicies,
                    allEndorsements,
                    stateCode,
                    [] // No fees yet - pricing will be null
                )
                : { defaults: [], optional: [] };

            console.info(`📚 Categorized endorsements (no pricing): ${availableEndorsements.defaults.length} defaults, ${availableEndorsements.optional.length} optional`);

            // Store original MISMO_XML for L2 request
            const originalMISMO = calculatorResponse?.['lvis:MISMO_XML'];

            return {
                type: 'questions',
                hasCalculatedRates: false,
                questions,
                endorsements: availableEndorsements,
                calcRateLevel2Data, // Store entire L2 data for echoing back
                originalMISMO, // Store for L2 request
                locationData: {
                    city,
                    county: countyName,
                    state: stateCode
                },
                // Pass metadata for L2 handler
                stateCode,
                loanPurposeType: LoanPurposeType,
                noteAmount,
                originalNoteAmount  // For zeroing out lender's policy on cash deals
            };
        }
        
    } catch (error) {
        console.error('Error in L1 request:', error);
        if (error.code === 'UPSTREAM_TIMEOUT') throw error; // preserve typed timeout for the 503 path
        throw new Error(`Failed to process L1 request: ${error.message}`);
    }
}

/**
 * Build RateCalc request XML for L1 with action type
 */
function buildRateCalcRequestXMLForL1(params) {
    const {
        actionType,
        PostalCode,
        SalesContractAmount,
        NoteAmount,
        LoanPurposeType,
        city,
        countyName,
        stateCode,
        servicesBlock
    } = params;
    
    const salesAmount = LoanPurposeType === 'Refinance' ? NoteAmount : SalesContractAmount;
    const noteAmountToUse = Number(NoteAmount) === 0 ? 1000 : NoteAmount;
    const firstAmCounty = normalizeCountyForFirstAm(countyName);

    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>${actionType}</lvis:LVISActionType>
    <lvis:ClientCustomerId>FNTE</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>L1-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_CALCULATOR_REQUEST>
    <lvis:MISMO_XML>
      <MESSAGE xlink:label="M1" SequenceNumber="1">
        <DEAL_SETS>
          <DEAL_SET xlink:label="DS1" SequenceNumber="1">
            <DEALS>
              <DEAL xlink:label="D1" SequenceNumber="1">
                <PARTIES>
                  <PARTY xlink:label="Party_ID" SequenceNumber="1">
                    <INDIVIDUAL>
                      <NAME>
                        <FirstName>Test</FirstName>
                        <LastName>User</LastName>
                      </NAME>
                    </INDIVIDUAL>
                    <ROLES>
                      <ROLE SequenceNumber="1">
                        <ROLE_DETAIL>
                          <PartyRoleType>Borrower</PartyRoleType>
                        </ROLE_DETAIL>
                      </ROLE>
                    </ROLES>
                  </PARTY>
                </PARTIES>
                <COLLATERALS>
                  <COLLATERAL xlink:label="PropertyLocations" SequenceNumber="1">
                    <SUBJECT_PROPERTY>
                      <ADDRESS>
                        <CityName>${city}</CityName>
                        <CountyName>${firstAmCounty}</CountyName>
                        <PostalCode>${PostalCode}</PostalCode>
                        <StateCode>${stateCode}</StateCode>
                      </ADDRESS>
                      <SALES_CONTRACTS>
                        <SALES_CONTRACT>
                          <SALES_CONTRACT_DETAIL>
                            <SalesContractAmount>${salesAmount}</SalesContractAmount>
                          </SALES_CONTRACT_DETAIL>
                        </SALES_CONTRACT>
                      </SALES_CONTRACTS>
                      <SITE>
                        <SITE_LOCATIONS>
                          <SITE_LOCATION>
                            <LocationType>Residential</LocationType>
                          </SITE_LOCATION>
                        </SITE_LOCATIONS>
                      </SITE>
                    </SUBJECT_PROPERTY>
                  </COLLATERAL>
                </COLLATERALS>
                <LOANS>
                  <LOAN xlink:label="SubjectLoan" SequenceNumber="1">
                    <LOAN_IDENTIFIERS>
                      <LOAN_IDENTIFIER SequenceNumber="1">
                        <LoanIdentifier>1234567</LoanIdentifier>
                        <LoanIdentifierType>LenderLoan</LoanIdentifierType>
                      </LOAN_IDENTIFIER>
                    </LOAN_IDENTIFIERS>
                    <TERMS_OF_LOAN>
                      ${LoanPurposeType === 'Refinance' ? `
                        <LoanPurposeType>Refinance</LoanPurposeType>
                        <NoteAmount>${noteAmountToUse}</NoteAmount>
                      ` : `
                        <LoanPurposeType>Other</LoanPurposeType>
                        <LoanPurposeTypeOtherDescription>Sale w/ Mortgage</LoanPurposeTypeOtherDescription>
                        <NoteAmount>${noteAmountToUse}</NoteAmount>
                      `}
                    </TERMS_OF_LOAN>
                  </LOAN>
                </LOANS>
                <SERVICES>
                ${servicesBlock}
                </SERVICES>
              </DEAL>
            </DEALS>
          </DEAL_SET>
        </DEAL_SETS>
      </MESSAGE>
    </lvis:MISMO_XML>
  </lvis:LVIS_CALCULATOR_REQUEST>
</lvis:LVIS_XML>`;
}

/**
 * Parse L2 questions from CalcRateLevel2Data
 */
function parseL2Questions(calcRateLevel2Data) {
    if (!calcRateLevel2Data) return [];
    
    const questions = [];
    const rateCalcQandA = calcRateLevel2Data['lvis:RateCalcRequest']?.['lvis:QandAs']?.['lvis:RateCalcQandA'];
    
    if (!rateCalcQandA) return questions;
    
    const qandaArray = Array.isArray(rateCalcQandA) ? rateCalcQandA : [rateCalcQandA];
    
    qandaArray.forEach(qa => {
        // Only include questions where IsPrompt is true
        if (qa['lvis:IsPrompt'] === 'true') {
            const question = {
                linkKey: qa['lvis:LinkKey'],
                questionText: qa['lvis:Question'],
                description: qa['lvis:Description'] || '',
                defaultAnswer: qa['lvis:DefaultAnswer'],
                paramCode: qa['lvis:Param']?.['lvis:ParamCode'],
                paramName: qa['lvis:Param']?.['lvis:Name'],
                valueType: qa['lvis:Param']?.['lvis:ValueType'],
                options: []
            };
            
            // Parse options if available
            const options = qa['lvis:Options']?.['lvis:KeyValue'];
            if (options) {
                const optionsArray = Array.isArray(options) ? options : [options];
                question.options = optionsArray.map(opt => ({
                    label: opt['lvis:Key'],
                    value: opt['lvis:Value']
                }));
            }

            // FirstAm sometimes returns placeholder prompt rows with no question text, no
            // LinkKey, a ParamCode with a missing rate key (e.g. "RFC__0") and a single option
            // whose key/value are empty (seen for Marion County, FL recording fees, 2026-09-23).
            // They cannot be answered and would fail validation, so skip them.
            const hasText = Boolean((question.questionText || '').trim());
            const hasUsableOption = question.options.some(opt => String(opt.value ?? '').trim() !== '');
            if (!hasText && !hasUsableOption) {
                console.warn(`Skipping blank L2 question row from FirstAm (paramCode="${question.paramCode}", linkKey="${question.linkKey || ''}")`);
                return;
            }
            // Same ParamCode listed twice: keep the first.
            if (question.paramCode && questions.some(q => q.paramCode === question.paramCode)) {
                console.warn(`Skipping duplicate L2 question row (paramCode="${question.paramCode}")`);
                return;
            }

            questions.push(question);
        }
    });
    
    return questions;
}

/**
 * Parse fees from L1 response (when rates are calculated)
 */
function parseFees(parsedResponse) {
    try {
        const fees = parsedResponse['lvis:LVIS_XML']['lvis:LVIS_CALCULATOR_RESPONSE']['lvis:MISMO_XML']
            ['MESSAGE']['DEAL_SETS']['DEAL_SET']['DEALS']['DEAL']
            ['LOANS']['LOAN']['FEE_INFORMATION']['FEES']['FEE'];
        
        return Array.isArray(fees) ? fees : [fees];
    } catch (error) {
        console.error('Error parsing fees:', error);
        return [];
    }
}

/**
 * Parse loan comments from L1 response
 */
function parseLoanComments(parsedResponse) {
    try {
        const comments = parsedResponse['lvis:LVIS_XML']['lvis:LVIS_CALCULATOR_RESPONSE']['lvis:MISMO_XML']
            ['MESSAGE']['DEAL_SETS']['DEAL_SET']['DEALS']['DEAL']
            ['LOANS']['LOAN']['LOAN_COMMENTS']['LOAN_COMMENT'];

        return Array.isArray(comments) ? comments : [comments];
    } catch (error) {
        console.error('Error parsing loan comments:', error);
        return [];
    }
}

/**
 * Extract endorsement fees from RateCalc response
 * Returns array of endorsement fee objects with pricing
 */
function extractEndorsementFees(fees) {
    if (!fees || !Array.isArray(fees)) return [];

    // Filter for endorsement fees - look for ENDR labels or Endorsement in description
    const endorsementFees = fees.filter(fee => {
        const label = fee['$']?.['xlink:label'] || '';
        const feeDetail = Array.isArray(fee['FEE_DETAIL']) ? fee['FEE_DETAIL'][0] : fee['FEE_DETAIL'];
        const description = feeDetail?.['FeeDescription']?.[0] || '';

        return label.includes('ENDR') || description.includes('Endorsement');
    });

    console.info(`Found ${endorsementFees.length} endorsement fees in RateCalc response`);

    // Extract pricing for each endorsement
    return endorsementFees.map(fee => {
        const label = fee['$']['xlink:label'];
        const feeDetail = Array.isArray(fee['FEE_DETAIL']) ? fee['FEE_DETAIL'][0] : fee['FEE_DETAIL'];
        const feePayments = fee['FEE_PAYMENTS'][0]['FEE_PAYMENT'];

        // Extract amounts using same pattern as other fees
        const buyerActualPayment = feePayments.find(p => p['$']['SequenceNumber'] === '1');
        const buyerActual = buyerActualPayment ? parseFloat(buyerActualPayment['FeeActualPaymentAmount'][0]) || 0 : 0;

        const sellerActualPayment = feePayments.find(p => p['$']['SequenceNumber'] === '2');
        const sellerActual = sellerActualPayment ? parseFloat(sellerActualPayment['FeeActualPaymentAmount'][0]) || 0 : 0;

        const buyerDisclosedPayment = feePayments.find(p => p['$']['SequenceNumber'] === '3');
        const buyerDisclosed = buyerDisclosedPayment ? parseFloat(buyerDisclosedPayment['FeeEstimatedPaymentAmount'][0]) || 0 : 0;

        const sellerDisclosedPayment = feePayments.find(p => p['$']['SequenceNumber'] === '4');
        const sellerDisclosed = sellerDisclosedPayment ? parseFloat(sellerDisclosedPayment['FeeEstimatedPaymentAmount'][0]) || 0 : 0;

        const totalActual = buyerActual + sellerActual;
        const totalDisclosed = buyerDisclosed + sellerDisclosed;
        const variance = totalActual - totalDisclosed;
        const variancePercent = totalDisclosed > 0 ? (variance / totalDisclosed) * 100 : 0;

        return {
            label,
            name: feeDetail['FeeDescription']?.[0] || feeDetail['DisclosureItemName']?.[0] || 'Unknown Endorsement',
            pricing: {
                buyerActual: buyerActual.toFixed(2),
                buyerDisclosed: buyerDisclosed.toFixed(2),
                sellerActual: sellerActual.toFixed(2),
                sellerDisclosed: sellerDisclosed.toFixed(2),
                totalActual: totalActual.toFixed(2),
                totalDisclosed: totalDisclosed.toFixed(2),
                variance: variance.toFixed(2),
                variancePercent: parseFloat(variancePercent.toFixed(2))
            }
        };
    });
}

/**
 * Categorize endorsements into defaults and optional WITH PRICING
 * Returns structured metadata for each endorsement including fees
 */
function categorizeEndorsements(titlePolicies, lenderPolicies, allEndorsements, stateCode, endorsementFees = []) {
    // Extract default endorsement IDs from policies
    const defaultIds = new Set();

    // Get defaults from title (owner's) policies
    titlePolicies.forEach(policy => {
        const defaultEndorsementIds = policy['lvis:DefaultEndorsementIds'];
        if (defaultEndorsementIds && defaultEndorsementIds['lvis:string']) {
            const ids = Array.isArray(defaultEndorsementIds['lvis:string'])
                ? defaultEndorsementIds['lvis:string']
                : [defaultEndorsementIds['lvis:string']];
            ids.forEach(id => defaultIds.add(id));
        }
    });

    // Get defaults from lender policies
    lenderPolicies.forEach(policy => {
        const defaultEndorsementIds = policy['lvis:DefaultEndorsementIds'];
        if (defaultEndorsementIds && defaultEndorsementIds['lvis:string']) {
            const ids = Array.isArray(defaultEndorsementIds['lvis:string'])
                ? defaultEndorsementIds['lvis:string']
                : [defaultEndorsementIds['lvis:string']];
            ids.forEach(id => defaultIds.add(id));
        }
    });

    console.info(`Found ${defaultIds.size} default endorsement IDs across all policies`);

    // Map category IDs to readable names
    const mapPolicyCategories = (validCategoryIds) => {
        if (!validCategoryIds) return 'unknown';

        const categories = Array.isArray(validCategoryIds['lvis:string'])
            ? validCategoryIds['lvis:string']
            : [validCategoryIds['lvis:string']];

        if (categories.includes('-1')) return 'all';

        const names = [];
        if (categories.includes('1')) names.push('owner');
        if (categories.includes('2')) names.push('lender');

        return names.length > 0 ? names.join(',') : 'unknown';
    };

    // Categorize endorsements with pricing
    const defaults = [];
    const optional = [];

    allEndorsements.forEach(endorsement => {
        const id = endorsement['lvis:EndorsementId'];
        const name = endorsement['lvis:EndorsementName'] || 'Unknown';
        const validCategories = mapPolicyCategories(endorsement['lvis:ValidPolicyCategoryIds']);

        // Try to match with fee data - match by name since we don't have ID in fee labels
        const matchingFee = endorsementFees.find(fee => {
            // Try exact name match first
            if (fee.name === name) return true;
            // Try partial name match (endorsement name might be prefix of fee name)
            if (fee.name.includes(name) || name.includes(fee.name)) return true;
            return false;
        });

        const metadata = {
            id,
            name,
            validFor: validCategories,
            stateCode
        };

        // Add pricing if we found a matching fee
        if (matchingFee) {
            metadata.pricing = matchingFee.pricing;
        } else {
            // No fee found - endorsement may be included in policy or not requested
            metadata.pricing = null;
        }

        if (defaultIds.has(id)) {
            defaults.push(metadata);
        } else {
            optional.push(metadata);
        }
    });

    console.info(`Categorized: ${defaults.length} defaults, ${optional.length} optional`);
    console.info(`Matched pricing for ${defaults.filter(d => d.pricing).length + optional.filter(o => o.pricing).length} endorsements`);

    return {
        defaults,
        optional
    };
}

/**
 * Build endorsement fee line items for inclusion in main fees array
 * Converts default endorsements with pricing into fee objects matching the standard fee format
 */
function buildEndorsementFeeLineItems(defaultEndorsements) {
    return defaultEndorsements
        .filter(endorsement => endorsement.pricing !== null)  // Only include endorsements with pricing
        .map(endorsement => {
            const pricing = endorsement.pricing;
            return {
                FeeDescription: `Title - Endorsement: ${endorsement.name}`,
                DisclosureItemName: `Title - Endorsement: ${endorsement.name}`,
                HUDLine: "",
                DisclosureSection: "B or C",
                DisclosureSectionName: "Title Services - Endorsements",
                Buyer: {
                    actualAmount: pricing.buyerActual,
                    disclosedAmount: pricing.buyerDisclosed
                },
                Seller: {
                    actualAmount: pricing.sellerActual,
                    disclosedAmount: pricing.sellerDisclosed
                },
                TotalActual: pricing.totalActual,
                TotalDisclosed: pricing.totalDisclosed
            };
        });
}

module.exports = {
    handleL1Request
};
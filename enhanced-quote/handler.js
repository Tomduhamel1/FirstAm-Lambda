const axios = require('axios');
const xml2js = require('xml2js');
const { getOAuthToken } = require('../shared/auth');
const { getZipCodeData, getStateFees, logAwsIdentity } = require('../shared/database');
const {
    buildTitleServiceBlock,
    buildSettlementServiceBlock,
    buildRecordingServiceBlock,
    buildProductListRequestXML,
    buildRateCalcRequestXML,
    parseProductList,
    buildTransactionTypesRequestXML,
    parseTransactionTypesResponse
} = require('../shared/xml-builders');
const constants = require('../shared/constants');
const { applyCentralizedRateIfEligible } = require('../shared/centralized-integration');

async function handleEnhancedQuote(event) {
    console.info('Received enhanced quote event:', JSON.stringify(event, null, 2));

    let requestBody;
    try {
        requestBody = JSON.parse(event.body);
        console.info('Parsed body:', requestBody);
    } catch (e) {
        console.error('Error parsing JSON:', e);
        return {
            statusCode: 400,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({ error: 'Invalid JSON format' }),
        };
    }

    const { PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType, selectedEndorsementIds } = requestBody;

    // Parse selectedEndorsementIds if provided (for user-selected endorsements beyond defaults)
    const selectedIds = Array.isArray(selectedEndorsementIds) ? selectedEndorsementIds :
                        (selectedEndorsementIds ? [selectedEndorsementIds] : []);
    if (selectedIds.length > 0) {
        console.info(`Selected endorsement IDs: ${JSON.stringify(selectedIds)}`);
    }

    if (!PostalCode) {
        console.error('Missing PostalCode parameter');
        return {
            statusCode: 400,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({ error: 'Missing or invalid PostalCode parameter' }),
        };
    }

    const normalizedZip = PostalCode.toString().padStart(5, '0');
    let noteAmount = Number(NoteAmount) === 0 ? constants.DEFAULT_NOTE_AMOUNT : Number(NoteAmount);
    let salesAmount = LoanPurposeType === 'Refinance' ? noteAmount : Number(SalesContractAmount);

    try {
        // Log AWS identity for debugging
        await logAwsIdentity();

        // Get OAuth token
        const token = await getOAuthToken();

        // Query DynamoDB for Zip Code data
        const zipCodeData = await getZipCodeData(PostalCode);
        const { city, county_name: countyName, state_id: stateCode } = zipCodeData;

        // Get state fees
        const stateFeeData = await getStateFees(stateCode);
        console.info('State Fee Data:', stateFeeData);

        // Normalize request fields
        const loanPurposeType = LoanPurposeType;

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

                const transactionTypesResponse = await axios.post(
                    constants.PRODUCT_LIST_URL,  // Same endpoint, different action type
                    transactionTypesRequestXML,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/xml',
                        },
                    }
                );

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
            const stateSpecificTypes = constants.STATE_TRANSACTION_TYPES[stateCode];
            transactionType = LoanPurposeType === 'Refinance' ?
                (stateSpecificTypes?.REFINANCE || constants.TRANSACTION_TYPES.REFINANCE) :
                (stateSpecificTypes?.PURCHASE || constants.TRANSACTION_TYPES.PURCHASE);
        }

        console.info(`📋 Using transaction type: "${transactionType}" for ${stateCode}`);

        // Build and send ProductList request
        const productListRequestXML = buildProductListRequestXML({
            stateCode,
            countyName,
            city,
            transactionType,
            salesAmount,
            noteAmount,
            effectiveDate,
        });

        console.info('📄 Enhanced Quote ProductList Request');
        console.info(`Request parameters: State=${stateCode}, County=${countyName}, City=${city}, TransactionType=${transactionType}`);
        console.info('ProductList Request XML:', productListRequestXML);

        const productListResponse = await axios.post(
            constants.PRODUCT_LIST_URL,
            productListRequestXML,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/xml',
                },
            }
        );

        const parsedProductList = await xml2js.parseStringPromise(productListResponse.data, {
            explicitArray: false,
            ignoreAttrs: false,
        });

        // Check for ACK_NACK error response first
        const productListAckNack = parsedProductList?.['lvis:LVIS_XML']?.['lvis:LVIS_ACK_NACK'];
        if (productListAckNack && productListAckNack['lvis:StatusCd'] !== '1000') {
            const statusCd = productListAckNack['lvis:StatusCd'] || 'Unknown';
            const statusDesc = productListAckNack['lvis:StatusDescription'] || 'No description';
            const exceptionMsg = productListAckNack['lvis:ExceptionMessage'] || '';
            console.error(`❌ FirstAm ProductList ACK_NACK Error - Status: ${statusCd}, Description: ${statusDesc}, Exception: ${exceptionMsg}`);
            console.error('Full ACK_NACK response:', JSON.stringify(productListAckNack, null, 2));
            throw new Error(`FirstAm ProductList Error: ${statusDesc} (${statusCd}) ${exceptionMsg}`);
        }

        const productListResponseBody = parsedProductList?.['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_TYPE_DATA_RESPONSE']?.['lvis:CalcTypeData'];
        const productList = productListResponseBody?.['lvis:ProductsList'];

        if (!productList) {
            console.error("❌ No valid ProductsList found in ProductList response");
            console.error(`Request was for: State=${stateCode}, County=${countyName}, City=${city}`);
            console.error('Response structure keys:', Object.keys(parsedProductList?.['lvis:LVIS_XML'] || {}));
            console.error('Full parsed response:', JSON.stringify(parsedProductList, null, 2));
            throw new Error(`No valid ProductsList found for ${city}, ${countyName}, ${stateCode}. FirstAm may not support this location.`);
        }

        // Parse products from the response
        const {
            titlePolicies,
            lenderPolicies,
            endorsementProducts,
            allEndorsements,  // NEW - full endorsement list for feature flag
            closingProducts,
            recordingProducts,
            otherProducts
        } = parseProductList(productList, transactionType);

        console.log('✅ Enabled Title Policies:', titlePolicies.map(p => p['lvis:PolicyName']));

        // Note: Endorsement categorization with pricing happens AFTER RateCalc response
        // Build services block
        let currentSeq = 1;
        let servicesParts = [];

        // Title block (always Sequence 1)
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
                allEndorsements,          // Full endorsements list
                selectedIds               // User-selected endorsement IDs (beyond defaults)
            )
        );

        // Skip settlement services for all states - causes errors with invalid closing product IDs
        console.info(`Skipping settlement services for ${stateCode} - prevents closing product errors`);
        currentSeq = 2; // Settlement would have been seq 2, so recording starts at 2

        // Recording blocks
        const recordingResult = buildRecordingServiceBlock(recordingProducts, currentSeq);
        if (recordingResult.xml) {
            servicesParts.push(recordingResult.xml);
        }

        const servicesBlock = servicesParts.join('\n');
        console.log('✅ Built Services Block for Enhanced Quote');

        // Build and send RateCalc request
        const requestXML = buildRateCalcRequestXML({
            PostalCode,
            SalesContractAmount: salesAmount,
            NoteAmount: noteAmount,
            LoanPurposeType,
            city,
            countyName,
            stateCode,
            servicesBlock
        });

        console.info('Calling RateCalcGuide API for enhanced quote...');
        const rateCalcGuideResponse = await axios.post(constants.RATE_CALC_URL, requestXML, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/xml'
            }
        });

        // Parse the XML response
        const parser = new xml2js.Parser();
        const parsedResponse = await parser.parseStringPromise(rateCalcGuideResponse.data);

        // Check for error response
        const ackNack = parsedResponse['lvis:LVIS_XML']?.['lvis:LVIS_ACK_NACK'];
        if (ackNack && ackNack.length > 0 && ackNack[0]['lvis:StatusCd']?.[0] !== '1000') {
            const errorMsg = ackNack[0]['lvis:StatusDescription']?.[0] || 'Unknown error from FirstAm';
            const errorDetail = ackNack[0]['lvis:ExceptionMessage']?.[0] || '';
            console.error('FirstAm API Error:', errorMsg, errorDetail);
            throw new Error(`FirstAm API Error: ${errorMsg}`);
        }

        // Extract fees from response - handle both array and non-array formats
        const calculatorResponse = parsedResponse['lvis:LVIS_XML']['lvis:LVIS_CALCULATOR_RESPONSE'];
        let response = Array.isArray(calculatorResponse) ? calculatorResponse[0] : calculatorResponse;

        if (!response || !response['lvis:MISMO_XML']) {
            throw new Error('Invalid response structure from FirstAm API');
        }

        // Check if L2 questions are required (HasCalculatedRates=false means L2 required)
        // NOTE: FirstAm has a typo in their XML - they send "HasCalcuatedRates" (missing 'l')
        let hasCalculatedRates = response['lvis:HasCalculatedRates'] || response['lvis:HasCalcuatedRates'];
        // xml2js wraps values in arrays, so extract the string value
        if (Array.isArray(hasCalculatedRates)) {
            hasCalculatedRates = hasCalculatedRates[0];
        }
        const calcRateLevel2Data = response['lvis:CalcRateLevel2Data'];

        console.info(`🔍 L2 Detection Check: hasCalculatedRates="${hasCalculatedRates}", hasL2Data=${!!calcRateLevel2Data}`);

        if (hasCalculatedRates === 'false' && calcRateLevel2Data) {
            console.info('🔄 L2 questions detected - HasCalculatedRates=false');
            console.info('📝 Automatically handling L2 questions for Reissue rate...');

            try {
                // Parse CalcRateLevel2Data to handle both array and object formats
                const l2Data = Array.isArray(calcRateLevel2Data) ? calcRateLevel2Data[0] : calcRateLevel2Data;

                // Extract original MISMO from L1 request (stored in response)
                const originalMISMO = Array.isArray(response['lvis:MISMO_XML'])
                    ? response['lvis:MISMO_XML'][0]
                    : response['lvis:MISMO_XML'];

                // Generate default answers for refinance
                const defaultAnswers = generateDefaultL2Answers(Number(NoteAmount), stateCode, LoanPurposeType);
                console.info('Default answers:', defaultAnswers);

                // Map answers into L2 data structure
                console.info('🗺️ About to call mapAnswersToL2Format...');
                const updatedL2Data = mapAnswersToL2Format(l2Data, defaultAnswers);
                console.info('✅ mapAnswersToL2Format completed');

                if (!updatedL2Data) {
                    throw new Error('Failed to map default answers to L2 format');
                }

                // Build L2 request XML
                const l2RequestXML = buildL2RequestXML({
                    calcRateLevel2Data: updatedL2Data,
                    originalMISMO
                });

                console.info('📤 Sending L2 request with default answers...');
                console.info('🔍 L2 Request XML (first 2000 chars):', l2RequestXML.substring(0, 2000));

                // Send L2 request
                const l2Response = await axios.post(constants.RATE_CALC_URL, l2RequestXML, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/xml'
                    }
                });

                console.info('📥 L2 Response received');

                // Parse L2 response
                const parsedL2Response = await parser.parseStringPromise(l2Response.data);

                // Check for L2 errors
                const l2AckNack = parsedL2Response['lvis:LVIS_XML']?.['lvis:LVIS_ACK_NACK'];
                if (l2AckNack && l2AckNack.length > 0 && l2AckNack[0]['lvis:StatusCd']?.[0] !== '1000') {
                    const l2ErrorMsg = l2AckNack[0]['lvis:StatusDescription']?.[0] || 'Unknown L2 error';
                    console.error('❌ L2 API Error:', l2ErrorMsg);
                    throw new Error(`L2 API Error: ${l2ErrorMsg}`);
                }

                // Extract L2 response
                const l2CalcResponse = parsedL2Response['lvis:LVIS_XML']['lvis:LVIS_CALCULATOR_RESPONSE'];
                response = Array.isArray(l2CalcResponse) ? l2CalcResponse[0] : l2CalcResponse;

                if (!response || !response['lvis:MISMO_XML']) {
                    throw new Error('Invalid L2 response structure');
                }

                console.info('✅ L2 auto-handling successful - received final rates with Reissue discount');

            } catch (l2Error) {
                console.error('⚠️ L2 auto-handling failed:', l2Error.message);
                console.warn('Falling back to L1 response (Basic rate without Reissue discount)');
                // Continue with original L1 response (will use Basic rate)
            }
        } else if (hasCalculatedRates === 'true') {
            console.info('✅ No L2 questions required - rates calculated immediately');
        }

        const mismoXML = Array.isArray(response['lvis:MISMO_XML']) ? response['lvis:MISMO_XML'][0] : response['lvis:MISMO_XML'];
        const message = Array.isArray(mismoXML['MESSAGE']) ? mismoXML['MESSAGE'][0] : mismoXML['MESSAGE'];
        const dealSets = Array.isArray(message['DEAL_SETS']) ? message['DEAL_SETS'][0] : message['DEAL_SETS'];
        const dealSet = Array.isArray(dealSets['DEAL_SET']) ? dealSets['DEAL_SET'][0] : dealSets['DEAL_SET'];
        const deals = Array.isArray(dealSet['DEALS']) ? dealSet['DEALS'][0] : dealSet['DEALS'];
        const deal = Array.isArray(deals['DEAL']) ? deals['DEAL'][0] : deals['DEAL'];
        const loans = Array.isArray(deal['LOANS']) ? deal['LOANS'][0] : deal['LOANS'];
        const loan = Array.isArray(loans['LOAN']) ? loans['LOAN'][0] : loans['LOAN'];
        const feeInfo = Array.isArray(loan['FEE_INFORMATION']) ? loan['FEE_INFORMATION'][0] : loan['FEE_INFORMATION'];
        const feesContainer = Array.isArray(feeInfo['FEES']) ? feeInfo['FEES'][0] : feeInfo['FEES'];
        const fees = feesContainer['FEE'];

        const loanCommentsContainer = Array.isArray(loan['LOAN_COMMENTS']) ? loan['LOAN_COMMENTS'][0] : loan['LOAN_COMMENTS'];
        const loanComments = loanCommentsContainer ? loanCommentsContainer['LOAN_COMMENT'] : [];

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

        // Process fees with ENHANCED extraction (actual + disclosed)
        const enhancedFees = extractEnhancedFees({
            fees,
            loanComments,
            LoanPurposeType,
            PostalCode,
            SalesContractAmount,
            stateFeeData
        });

        // Apply centralized rates if eligible (refinance + centralized state)
        const centralizedResult = applyCentralizedRateIfEligible(
            enhancedFees,
            stateCode,
            LoanPurposeType,
            Number(NoteAmount),
            countyName,
            'enhanced'
        );

        // Use centralized fees if applied, otherwise use RateCalc fees
        const finalFees = centralizedResult.fees;

        if (centralizedResult.centralizedRateApplied) {
            console.info(`[Enhanced Quote] Using centralized rate: $${centralizedResult.centralizedRate} for ${stateCode} refinance`);
        } else {
            console.info(`[Enhanced Quote] Using RateCalc fees: ${centralizedResult.reason || 'Not applicable'}`);
        }

        // Calculate totals
        const totals = {
            buyerActual: finalFees.reduce((sum, fee) => sum + parseFloat(fee.Buyer.actualAmount || 0), 0),
            buyerDisclosed: finalFees.reduce((sum, fee) => sum + parseFloat(fee.Buyer.disclosedAmount || 0), 0),
            sellerActual: finalFees.reduce((sum, fee) => sum + parseFloat(fee.Seller.actualAmount || 0), 0),
            sellerDisclosed: finalFees.reduce((sum, fee) => sum + parseFloat(fee.Seller.disclosedAmount || 0), 0)
        };

        // Extract and clean loan comment text
        const loanComment = loanComments.find(comment => comment['$']['xlink:label'] === 'RESPONSE_NOTE_1');
        let loanCommentText = loanComment ? loanComment.LoanCommentText[0] : '';
        loanCommentText = loanCommentText.replace(/<[^>]+>/g, ''); // Remove HTML tags

        console.info('✅ Enhanced Quote Complete');
        console.info('Totals:', totals);

        // Build response object
        const responseBody = {
            message: 'Enhanced quote with actual and disclosed amounts',
            settlementFee: LoanPurposeType === 'Refinance'
                ? (stateFeeData?.SettlementFeeRefi || 0)
                : (stateFeeData?.SettlementFee || 0),
            settlementFeeType: LoanPurposeType === 'Refinance' ? 'Refinance' : 'Purchase',
            stateCode: stateCode,
            city: city,
            county: countyName,
            fees: finalFees,
            totals: {
                buyerActual: parseFloat(totals.buyerActual.toFixed(2)),
                buyerDisclosed: parseFloat(totals.buyerDisclosed.toFixed(2)),
                sellerActual: parseFloat(totals.sellerActual.toFixed(2)),
                sellerDisclosed: parseFloat(totals.sellerDisclosed.toFixed(2))
            },
            loanCommentText: loanCommentText
        };

        // Add endorsements (always included)
        responseBody.endorsements = availableEndorsements;

        return {
            statusCode: 200,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify(responseBody),
        };
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        return {
            statusCode: error.message === `Zip code ${PostalCode} not found` ? 404 : 500,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({
                error: error.message || 'Failed to process enhanced quote',
                details: error.response ? error.response.data : error.message
            }),
        };
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
 * Extract enhanced fees with ACTUAL and DISCLOSED amounts
 */
function extractEnhancedFees({ fees, loanComments, LoanPurposeType, PostalCode, SalesContractAmount, stateFeeData }) {

    /**
     * Extract enhanced fee data from FirstAm fee object
     * Returns both actual and disclosed amounts for buyer and seller
     */
    const extractEnhancedFeeData = (feeObj) => {
        if (!feeObj) return null;

        const feeDetail = Array.isArray(feeObj['FEE_DETAIL']) ? feeObj['FEE_DETAIL'][0] : feeObj['FEE_DETAIL'];
        const feePayments = feeObj['FEE_PAYMENTS'][0]['FEE_PAYMENT'];

        // Sequence 1: Buyer Actual
        const buyerActualPayment = feePayments.find(p => p['$']['SequenceNumber'] === '1');
        const buyerActual = buyerActualPayment ? parseFloat(buyerActualPayment['FeeActualPaymentAmount'][0]) || 0 : 0;

        // Sequence 2: Seller Actual
        const sellerActualPayment = feePayments.find(p => p['$']['SequenceNumber'] === '2');
        const sellerActual = sellerActualPayment ? parseFloat(sellerActualPayment['FeeActualPaymentAmount'][0]) || 0 : 0;

        // Sequence 3: Buyer Disclosed/Estimated
        const buyerDisclosedPayment = feePayments.find(p => p['$']['SequenceNumber'] === '3');
        const buyerDisclosed = buyerDisclosedPayment ? parseFloat(buyerDisclosedPayment['FeeEstimatedPaymentAmount'][0]) || 0 : 0;

        // Sequence 4: Seller Disclosed/Estimated
        const sellerDisclosedPayment = feePayments.find(p => p['$']['SequenceNumber'] === '4');
        const sellerDisclosed = sellerDisclosedPayment ? parseFloat(sellerDisclosedPayment['FeeEstimatedPaymentAmount'][0]) || 0 : 0;

        return {
            FeeDescription: feeDetail['FeeDescription'] ? feeDetail['FeeDescription'][0] : 'Unknown',
            DisclosureItemName: feeDetail['DisclosureItemName'] ? feeDetail['DisclosureItemName'][0] : '',
            HUDLine: feeDetail['DisclosureHUDLine'] ? feeDetail['DisclosureHUDLine'][0] : '',
            DisclosureSection: feeDetail['DisclosureSectionNumber'] ? feeDetail['DisclosureSectionNumber'][0] : '',
            DisclosureSectionName: feeDetail['DisclosureSectionName'] ? feeDetail['DisclosureSectionName'][0] : '',
            Buyer: {
                actualAmount: buyerActual.toFixed(2),
                disclosedAmount: buyerDisclosed.toFixed(2)
            },
            Seller: {
                actualAmount: sellerActual.toFixed(2),
                disclosedAmount: sellerDisclosed.toFixed(2)
            },
            TotalActual: feeDetail['FeeActualTotalAmount'] ? parseFloat(feeDetail['FeeActualTotalAmount'][0]).toFixed(2) : '0.00',
            TotalDisclosed: feeDetail['GFEDisclosedFeeAmount'] ? parseFloat(feeDetail['GFEDisclosedFeeAmount'][0]).toFixed(2) : '0.00'
        };
    };

    const findSpecificEnhancedFee = (feeArray, label) => {
        const feeObj = feeArray.find(fee => fee['$']['xlink:label'] === label);
        return extractEnhancedFeeData(feeObj);
    };

    const extractRecordingFeesEnhanced = (feeArray) => {
        const recordingFees = feeArray.filter(fee => {
            const feeDetail = Array.isArray(fee['FEE_DETAIL']) ? fee['FEE_DETAIL'][0] : fee['FEE_DETAIL'];
            return feeDetail['FeeDescription'][0] === 'RecordingFee';
        });
        return recordingFees.map(fee => extractEnhancedFeeData(fee)).filter(f => f !== null);
    };

    const extractTransferTaxFeesEnhanced = (feeArray) => {
        const transferTaxFees = feeArray.filter(fee => {
            const feeDetail = Array.isArray(fee['FEE_DETAIL']) ? fee['FEE_DETAIL'][0] : fee['FEE_DETAIL'];
            return feeDetail['FeeDescription'][0] === 'TransferTax';
        });
        return transferTaxFees.map(fee => extractEnhancedFeeData(fee)).filter(f => f !== null);
    };

    // Extract required fees
    let enhancedFees = [];

    // Owner's policy (not for refinance)
    if (LoanPurposeType !== 'Refinance') {
        const ownerPolicy = findSpecificEnhancedFee(fees, "FEE_POLICY_1");
        if (ownerPolicy) {
            ownerPolicy.FeeDescription = "Title - Owner's Title Insurance";
            enhancedFees.push(ownerPolicy);
        }
    }

    // Lender's policy
    const lenderPolicyLabel = LoanPurposeType === 'Refinance' ? "FEE_POLICY_1" : "FEE_POLICY_2";
    const lenderPolicy = findSpecificEnhancedFee(fees, lenderPolicyLabel);
    if (lenderPolicy) {
        lenderPolicy.FeeDescription = "Title - Lender's Title Insurance";
        enhancedFees.push(lenderPolicy);
    }

    // Settlement fees (from DynamoDB, not FirstAm)
    const settlementAmount = LoanPurposeType === 'Refinance'
        ? (stateFeeData?.SettlementFeeRefi || 0)
        : (stateFeeData?.SettlementFee || 0);

    enhancedFees.push({
        FeeDescription: 'Title - Settlement Fee',
        DisclosureItemName: 'Settlement Fee',
        HUDLine: '',
        DisclosureSection: '',
        DisclosureSectionName: 'Settlement Services',
        Buyer: {
            actualAmount: settlementAmount.toFixed(2),
            disclosedAmount: settlementAmount.toFixed(2)
        },
        Seller: {
            actualAmount: '0.00',
            disclosedAmount: '0.00'
        },
        TotalActual: settlementAmount.toFixed(2),
        TotalDisclosed: settlementAmount.toFixed(2)
    });

    // Sales tax on owner's policy (not for refinance)
    if (LoanPurposeType !== 'Refinance') {
        const ownerTax = findSpecificEnhancedFee(fees, "FEE_POLICY_1_SALES_TAX_1");
        if (ownerTax) {
            ownerTax.FeeDescription = "Title - Sales Tax - Owner's Title Insurance";
            enhancedFees.push(ownerTax);
        }
    }

    // Sales tax on lender's policy
    const lenderTax = findSpecificEnhancedFee(fees, "FEE_POLICY_2_SALES_TAX_1");
    if (lenderTax) {
        lenderTax.FeeDescription = "Title - Sales Tax - Lender's Title Insurance";
        enhancedFees.push(lenderTax);
    }

    // Recording fees
    let recordingFees = extractRecordingFeesEnhanced(fees);

    // Transfer taxes
    let transferTaxFees = extractTransferTaxFeesEnhanced(fees);

    // Exclude certain fees for Refinance
    if (LoanPurposeType === 'Refinance' || LoanPurposeType === '$Refinance') {
        recordingFees = recordingFees.filter(fee =>
            !fee.DisclosureItemName.includes("Conveyance Deed") &&
            !fee.DisclosureItemName.includes("Assignment")
        );
        transferTaxFees = transferTaxFees.filter(fee =>
            !fee.DisclosureItemName.includes("Conveyance Deed")
        );
    }

    enhancedFees = enhancedFees.concat(recordingFees, transferTaxFees);

    // Calculate and add Agricultural Tax if applicable
    if (
        (PostalCode === '02801' || PostalCode === '02837') &&
        ['purchase', 'cash purchase'].includes(LoanPurposeType.toLowerCase())
    ) {
        if (SalesContractAmount > 450000) {
            const agriculturalTax = (SalesContractAmount - 450000) * 0.04;
            enhancedFees.push({
                FeeDescription: 'Agricultural Tax',
                DisclosureItemName: 'Agricultural Tax',
                HUDLine: '',
                DisclosureSection: '',
                DisclosureSectionName: 'Government Recording and Transfer Charges',
                Buyer: {
                    actualAmount: agriculturalTax.toFixed(2),
                    disclosedAmount: agriculturalTax.toFixed(2)
                },
                Seller: {
                    actualAmount: '0.00',
                    disclosedAmount: '0.00'
                },
                TotalActual: agriculturalTax.toFixed(2),
                TotalDisclosed: agriculturalTax.toFixed(2)
            });
        }
    }

    // Add additional state-specific fees from FNTEFees table
    const stateFeeTitles = {
        ShortFormPolicy: 'Title - Short Form Policy',
        CountersignLender: 'Title - Countersign Lender',
        CountersignOwner: 'Title - Countersign Owner',
        NotaryFee: 'Title - Notary Fee',
        JudgementSearch: 'Title - Judgement Search',
        AttorneyFee: 'Title - Attorney Fee',
        AbstractorTitleSearch: 'Title - Abstractor Title Search',
        SearchFee: 'Title - Search Fee',
        ExamFee: 'Title - Exam Fee',
        AbstractCopyFee: 'Title - Abstract Copy Fee',
        AbstractStorageFee: 'Title - Abstract Storage Fee',
        TitleInsuranceBinderFee: 'Title - Title Insurance Binder Fee',
        TitleCertFee: 'Title - Title Cert Fee',
        ErecordingFee: 'Title - E-recording Fee',
        "Rec/SvcFee": "Title - Recording Service Fee",
        TaxReview: 'Title - Tax Review',
        TitleCertOpinion: 'Title - Title Cert Opinion',
        CPLBuyer: 'Title - CPL Buyer',
        CPLSeller: 'Title - CPL Seller'
    };

    if (stateFeeData) {
        Object.keys(stateFeeData).forEach(feeKey => {
            if (
                feeKey === 'StateCode' ||
                feeKey === 'State' ||
                feeKey === 'SettlementFee' ||
                feeKey === 'SettlementFeeRefi'
            ) return;

            if (stateFeeData[feeKey] == null || stateFeeData[feeKey] === 0) return;

            // Abstractor Title Search — handle refi version if applicable
            if (feeKey === 'AbstractorTitleSearchREFI' && LoanPurposeType === 'Refinance') {
                enhancedFees.push({
                    FeeDescription: 'Title - Abstractor Title Search',
                    DisclosureItemName: 'Abstractor Title Search',
                    HUDLine: '',
                    DisclosureSection: '',
                    DisclosureSectionName: 'Title Services',
                    Buyer: {
                        actualAmount: stateFeeData[feeKey].toFixed(2),
                        disclosedAmount: stateFeeData[feeKey].toFixed(2)
                    },
                    Seller: {
                        actualAmount: '0.00',
                        disclosedAmount: '0.00'
                    },
                    TotalActual: stateFeeData[feeKey].toFixed(2),
                    TotalDisclosed: stateFeeData[feeKey].toFixed(2)
                });
                return;
            }

            // Skip non-refi version of AbstractorTitleSearch on refinance
            if (feeKey === 'AbstractorTitleSearch' && LoanPurposeType === 'Refinance') return;

            enhancedFees.push({
                FeeDescription: stateFeeTitles[feeKey] || feeKey,
                DisclosureItemName: stateFeeTitles[feeKey] || feeKey,
                HUDLine: '',
                DisclosureSection: '',
                DisclosureSectionName: 'Title Services',
                Buyer: {
                    actualAmount: stateFeeData[feeKey].toFixed(2),
                    disclosedAmount: stateFeeData[feeKey].toFixed(2)
                },
                Seller: {
                    actualAmount: '0.00',
                    disclosedAmount: '0.00'
                },
                TotalActual: stateFeeData[feeKey].toFixed(2),
                TotalDisclosed: stateFeeData[feeKey].toFixed(2)
            });
        });
    }

    return enhancedFees;
}

/**
 * Maps user-provided answers into the L2 data structure format expected by FirstAm
 * @param {Object} calcRateLevel2Data - Original L2 data from L1 response
 * @param {Object} userAnswers - User-provided answers
 * @returns {Object} Updated CalcRateLevel2Data with user answers
 */
function mapAnswersToL2Format(calcRateLevel2Data, userAnswers) {
    if (!calcRateLevel2Data) return null;

    // Deep clone the original data
    const updatedData = JSON.parse(JSON.stringify(calcRateLevel2Data));

    // Update answers in RateCalcQandA elements
    // Note: The data doesn't have namespace prefixes when parsed from XML
    // xml2js wraps complex elements in arrays, so extract them if needed
    let rateCalcRequest = updatedData['RateCalcRequest'] || updatedData['lvis:RateCalcRequest'];
    if (Array.isArray(rateCalcRequest)) {
        rateCalcRequest = rateCalcRequest[0];
    }
    console.info(`🔍 rateCalcRequest keys:`, Object.keys(rateCalcRequest || {}));

    let qandas = rateCalcRequest?.['QandAs'] || rateCalcRequest?.['lvis:QandAs'];
    if (Array.isArray(qandas)) {
        qandas = qandas[0];
    }
    console.info(`🔍 qandas keys:`, Object.keys(qandas || {}));

    const qandaArray = qandas?.['RateCalcQandA'] || qandas?.['lvis:RateCalcQandA'];
    console.info(`🔍 qandaArray type:`, typeof qandaArray, 'isArray:', Array.isArray(qandaArray), 'isTruthy:', !!qandaArray);

    if (qandaArray) {
        const questions = Array.isArray(qandaArray) ? qandaArray : [qandaArray];

        console.info(`📊 Processing ${questions.length} L2 questions`);
        console.info(`🔑 Available answer keys: ${Object.keys(userAnswers).join(', ')}`);

        questions.forEach(qa => {
            // Check for IsPrompt flag - questions with IsPrompt=true need answers
            // xml2js wraps values in arrays, so extract the string value
            let isPrompt = qa['IsPrompt'] || qa['lvis:IsPrompt'];
            if (Array.isArray(isPrompt)) isPrompt = isPrompt[0];

            if (isPrompt === 'true') {
                // Get the param code to match with user answers
                let param = qa['Param'] || qa['lvis:Param'];
                if (Array.isArray(param)) param = param[0];

                let paramCode = param?.['ParamCode'] || param?.['lvis:ParamCode'];
                if (Array.isArray(paramCode)) paramCode = paramCode[0];

                console.info(`🔍 Question ParamCode: ${paramCode}, hasAnswer: ${userAnswers[paramCode] !== undefined}`);

                // User answers are keyed by paramCode (e.g., RFC_17_0, RFC_589_0, etc.)
                const userAnswer = userAnswers[paramCode];

                if (userAnswer !== undefined) {
                    // Update the answer - keep the same structure as original
                    const answersKey = qa['Answers'] ? 'Answers' : 'lvis:Answers';
                    const stringKey = qa['Answers']?.['string'] ? 'string' : 'lvis:string';

                    qa[answersKey] = {
                        [stringKey]: String(userAnswer)
                    };

                    console.info(`✏️ Mapped answer for ${paramCode}: ${userAnswer}`);
                }
            }
        });
    }

    return updatedData;
}

/**
 * Generates default answers for common L2 questions in refinance scenarios
 * @param {number} noteAmount - Loan amount
 * @param {string} stateCode - State code (e.g., 'FL', 'CT')
 * @param {string} loanPurposeType - Transaction type
 * @returns {Object} Map of paramCode -> answer value
 */
function generateDefaultL2Answers(noteAmount, stateCode, loanPurposeType) {
    const answers = {};

    // Calculate date 1 year ago for prior policy date
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const priorPolicyDate = oneYearAgo.toISOString().split('T')[0]; // YYYY-MM-DD format

    // Common L2 questions for Reissue rate (refinance scenarios)

    // Policy-related questions
    answers['P0_665'] = '2'; // Is this for sale of improved property? → No (it's refinance)
    answers['P0_537'] = String(noteAmount); // Prior Liability Amount → Current loan amount
    answers['P0_1140'] = '1'; // Is Refi by Insured Owner? → Yes
    answers['P0_1539'] = priorPolicyDate; // Date of Prior Policy → One year ago

    // Recording/tax questions (common across states)
    answers['RFC_157_0'] = '0'; // Names on document over 4? → 0 (no)
    answers['RFC_157_1'] = '0'; // Names on document over 4? (mortgage) → 0 (no)
    answers['RFC_10604_0'] = '0'; // HECM principal limit → 0
    answers['RFC_10294_0'] = 'N'; // Exempt from Intangible Tax? → No
    answers['RFC_10295_0'] = 'N'; // Exempt from Documentary Stamps? → No
    answers['RFC_10296_0'] = 'N'; // Exempt from both? → No
    answers['FACC_284_0'] = '2'; // Federal/Tax Exempt Credit Union? → No

    console.info(`📋 Generated ${Object.keys(answers).length} default L2 answers for ${stateCode} ${loanPurposeType}`);
    return answers;
}

/**
 * Builds the complete L2 request XML with RateCalcNoAutoCalc action
 * @param {Object} params - Parameters for building the request
 * @param {Object} params.calcRateLevel2Data - Updated L2 data with answers
 * @param {Object} params.originalMISMO - Original MISMO XML from L1 response
 * @returns {string} Complete L2 request XML
 */
function buildL2RequestXML({ calcRateLevel2Data, originalMISMO }) {
    const uuid = require('uuid');
    const builder = new xml2js.Builder({
        renderOpts: { pretty: false },
        xmldec: { version: '1.0', encoding: 'utf-8' }
    });

    // Build CalcRateLevel2Data XML
    const l2DataObj = { 'lvis:CalcRateLevel2Data': calcRateLevel2Data };
    const l2DataXML = builder.buildObject(l2DataObj)
        .replace('<?xml version="1.0" encoding="utf-8"?>', '')
        .trim();

    // Build MISMO XML if provided
    let mismoXML = '';
    if (originalMISMO) {
        const mismoObj = { 'lvis:MISMO_XML': originalMISMO };
        mismoXML = builder.buildObject(mismoObj)
            .replace('<?xml version="1.0" encoding="utf-8"?>', '')
            .trim();
    }

    // Build complete L2 request
    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>RateCalcNoAutoCalc</lvis:LVISActionType>
    <lvis:ClientCustomerId>FNTE</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>L2-${uuid.v4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_CALCULATOR_REQUEST>
    ${l2DataXML}
    ${mismoXML}
  </lvis:LVIS_CALCULATOR_REQUEST>
</lvis:LVIS_XML>`;
}

module.exports = {
    handleEnhancedQuote
};

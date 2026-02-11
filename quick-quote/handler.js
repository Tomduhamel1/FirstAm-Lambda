const axios = require('axios');
const xml2js = require('xml2js');
const { getOAuthToken } = require('../shared/auth');
const { getZipCodeData, getStateFees, logAwsIdentity } = require('../shared/database');
const {
    buildTitleServiceBlock,
    buildSettlementServiceBlock,
    buildRecordingServiceBlock,
    buildTransactionTypesRequestXML,
    parseTransactionTypesResponse,
    buildProductListRequestXML,
    buildRateCalcRequestXML,
    parseProductList
} = require('../shared/xml-builders');
const constants = require('../shared/constants');
const { applyCentralizedRateIfEligible } = require('../shared/centralized-integration');

async function handleQuickQuote(event) {
    console.info('Received event:', JSON.stringify(event, null, 2));

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

    const { PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType, includeEndorsements } = requestBody;

    // Feature flag for endorsements - defaults to false for backward compatibility
    const envEnabled = process.env.ENABLE_ENDORSEMENTS === 'true';
    const requestEnabled = includeEndorsements === true;
    const includeEndorsementsFlag = envEnabled && requestEnabled;

    console.info(`Endorsement feature flag: env=${envEnabled}, request=${requestEnabled}, enabled=${includeEndorsementsFlag}`);

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
        const salesContractAmount = SalesContractAmount;

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

        console.info('📄 ProductList Request XML:\n', productListRequestXML);

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

        console.info("📦 ProductList raw XML response:\n", productListResponse.data);

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

        const responseBody = parsedProductList?.['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_TYPE_DATA_RESPONSE']?.['lvis:CalcTypeData'];
        const productList = responseBody?.['lvis:ProductsList'];

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
        console.log('✅ Enabled Endorsements:', endorsementProducts.map(p => p['lvis:ProductName']));
        console.log('✅ Enabled Closing Products:', closingProducts.map(p => p['lvis:ProductName'] || p['lvis:DocName']));
        console.log('✅ Enabled Recording Products:', recordingProducts.map(p => p['lvis:ProductName'] || p['lvis:DocName']));
        console.log('✅ Enabled Other Products:', otherProducts.map(p => p['lvis:ProductName']));

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
                includeEndorsementsFlag,  // NEW - feature flag
                allEndorsements,          // NEW - full endorsements list
                []                        // Selected endorsement IDs (empty for quick-quote)
            )
        );

        // Skip settlement services for all states - causes errors with invalid closing product IDs
        console.info(`Skipping settlement services for ${stateCode} - prevents closing product errors`);
        currentSeq = 2; // Settlement would have been seq 2, so recording starts at 2

        // Recording blocks with default page numbers
        const defaultPageNumbers = {
            deedPages: 4,       // Standard deed document
            mortgagePages: 25   // Standard mortgage/deed of trust
        };
        const recordingResult = buildRecordingServiceBlock(recordingProducts, currentSeq, defaultPageNumbers, salesAmount, noteAmount);
        if (recordingResult.xml) {
            servicesParts.push(recordingResult.xml);
        }

        const servicesBlock = servicesParts.join('\n');
        console.log('✅ Built Services Block:', servicesBlock.length, 'chars');

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

        console.log('Generated XML:', requestXML);
        console.info('XML Request:', requestXML);

        // Call the RateCalcGuide API
        console.info('Calling RateCalcGuide API...');
        const rateCalcGuideResponse = await axios.post(constants.RATE_CALC_URL, requestXML, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/xml'
            }
        });

        // Log the XML response
        console.info('RateCalcGuide API Response:', rateCalcGuideResponse.data);

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

        // Extract initial response
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
                const defaultAnswers = generateDefaultL2Answers(noteAmount, stateCode, loanPurposeType);
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

        // Process fees
        const extractedFees = extractFees({
            fees,
            loanComments,
            LoanPurposeType,
            PostalCode,
            SalesContractAmount,
            stateFeeData
        });

        // Apply centralized rates if eligible (refinance + centralized state)
        const centralizedResult = applyCentralizedRateIfEligible(
            extractedFees,
            stateCode,
            LoanPurposeType,
            noteAmount,
            countyName,
            'simple'
        );

        // Use centralized fees if applied, otherwise use RateCalc fees
        const finalFees = centralizedResult.fees;

        if (centralizedResult.centralizedRateApplied) {
            console.info(`[Quick Quote] Using centralized rate: $${centralizedResult.centralizedRate} for ${stateCode} refinance`);
        } else {
            console.info(`[Quick Quote] Using RateCalc fees: ${centralizedResult.reason || 'Not applicable'}`);
        }

        // Calculate total buyer fee
        const totalBuyerFee = finalFees.reduce((sum, fee) => sum + parseFloat(fee.BuyerFee), 0);

        // Extract and clean loan comment text
        const loanComment = loanComments.find(comment => comment['$']['xlink:label'] === 'RESPONSE_NOTE_1');
        let loanCommentText = loanComment ? loanComment.LoanCommentText[0] : '';
        loanCommentText = loanCommentText.replace(/<[^>]+>/g, ''); // Remove HTML tags

        console.info('Extracted Fees:', finalFees);
        console.info('Total Buyer Fee:', totalBuyerFee);
        console.info('Loan Comment Text:', loanCommentText);

        console.info('Preparing final response...');
        return {
            statusCode: 200,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({
                message: 'FNTEFees API called successfully',
                settlementFee: LoanPurposeType === 'Refinance'
                    ? (stateFeeData?.SettlementFeeRefi || 0)
                    : (stateFeeData?.SettlementFee || 0),
                stateCode: stateCode,
                city: city,
                county: countyName,
                rateCalcGuideResponse: finalFees,
                totalBuyerFee: totalBuyerFee.toFixed(2),
                loanCommentText: loanCommentText
            }),
        };
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        return {
            statusCode: error.message === `Zip code ${PostalCode} not found` ? 404 : 500,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({ 
                error: error.message || 'Failed to process quick quote', 
                details: error.response ? error.response.data : error.message 
            }),
        };
    }
}

function extractFees({ fees, loanComments, LoanPurposeType, PostalCode, SalesContractAmount, stateFeeData }) {
    // Helper functions for fee extraction
    const extractFeesByDescription = (feeArray, description) => {
        const feeObj = feeArray.find(fee => fee['FEE_DETAIL'][0]['FeeDescription'][0] === description);
        if (!feeObj) return { BuyerFee: '0.0', SellerFee: '0.0' };

        console.info(`Extracting fees for: ${description}`);
        console.info('Fee Object:', JSON.stringify(feeObj, null, 2));

        const feePayments = feeObj['FEE_PAYMENTS'][0]['FEE_PAYMENT'];

        const getPaymentAmount = (payment, type, useEstimated) => {
            const amount = useEstimated 
                ? parseFloat(payment['FeeEstimatedPaymentAmount'][0]) || 0.0
                : parseFloat(payment['FeeActualPaymentAmount'][0]) || 0.0;
            console.info(`Payment Amount for ${type} (UseEstimated=${useEstimated}): ${amount}`);
            return amount;
        };

        const buyerFee = feePayments.find(payment => payment['$']['SequenceNumber'] === '3')
            ? getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '3'), 'Buyer', true)
            : getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '1'), 'Buyer', false);

        const sellerFee = feePayments.find(payment => payment['$']['SequenceNumber'] === '4')
            ? getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '4'), 'Seller', true)
            : getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '2'), 'Seller', false);

        return {
            BuyerFee: buyerFee || '0.0',
            SellerFee: sellerFee || '0.0'
        };
    };

    const findSpecificFee = (feeArray, label) => {
        const feeObj = feeArray.find(fee => fee['$']['xlink:label'] === label);
        if (!feeObj) return { BuyerFee: '0.0', SellerFee: '0.0' };

        console.info(`Extracting fees for label: ${label}`);
        console.info('Fee Object:', JSON.stringify(feeObj, null, 2));

        const feePayments = feeObj['FEE_PAYMENTS'][0]['FEE_PAYMENT'];

        const getPaymentAmount = (payment, type, useEstimated) => {
            const amount = useEstimated 
                ? parseFloat(payment['FeeEstimatedPaymentAmount'][0]) || 0.0
                : parseFloat(payment['FeeActualPaymentAmount'][0]) || 0.0;
            console.info(`Payment Amount for ${type} (UseEstimated=${useEstimated}): ${amount}`);
            return amount;
        };

        const buyerFee = feePayments.find(payment => payment['$']['SequenceNumber'] === '3')
            ? getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '3'), 'Buyer', true)
            : getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '1'), 'Buyer', false);

        const sellerFee = feePayments.find(payment => payment['$']['SequenceNumber'] === '4')
            ? getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '4'), 'Seller', true)
            : getPaymentAmount(feePayments.find(payment => payment['$']['SequenceNumber'] === '2'), 'Seller', false);

        return {
            BuyerFee: buyerFee || '0.0',
            SellerFee: sellerFee || '0.0'
        };
    };

    const extractRecordingFees = (feeArray) => {
        const recordingFees = feeArray.filter(fee => fee['FEE_DETAIL'][0]['FeeDescription'][0] === 'RecordingFee');
        return recordingFees.map(fee => {
            const feePayments = fee['FEE_PAYMENTS'][0]['FEE_PAYMENT'];
            const buyerFee = feePayments.find(payment => payment['FeePaymentPaidByType'][0] === 'Buyer');
            const sellerFee = feePayments.find(payment => payment['FeePaymentPaidByType'][0] === 'Seller');

            return {
                FeeDescription: fee['FEE_DETAIL'][0]['FeeDescription'][0],
                DisclosureItemName: fee['FEE_DETAIL'][0]['DisclosureItemName'][0],
                BuyerFee: buyerFee ? buyerFee['FeeActualPaymentAmount'][0] : '0.0',
                SellerFee: sellerFee ? sellerFee['FeeActualPaymentAmount'][0] : '0.0'
            };
        });
    };

    const extractTransferTaxFees = (feeArray) => {
        const transferTaxFees = feeArray.filter(fee => fee['FEE_DETAIL'][0]['FeeDescription'][0] === 'TransferTax');
        return transferTaxFees.map(fee => {
            const feePayments = fee['FEE_PAYMENTS'][0]['FEE_PAYMENT'];
            const buyerFee = feePayments.find(payment => payment['FeePaymentPaidByType'][0] === 'Buyer');
            const sellerFee = feePayments.find(payment => payment['FeePaymentPaidByType'][0] === 'Seller');

            return {
                FeeDescription: fee['FEE_DETAIL'][0]['FeeDescription'][0],
                DisclosureItemName: fee['FEE_DETAIL'][0]['DisclosureItemName'][0],
                BuyerFee: buyerFee ? buyerFee['FeeActualPaymentAmount'][0] : '0.0',
                SellerFee: sellerFee ? sellerFee['FeeActualPaymentAmount'][0] : '0.0'
            };
        });
    };

    // Extract required fees
    const eaglePolicyFees = LoanPurposeType === 'Refinance' ? 
        { BuyerFee: '0.0', SellerFee: '0.0' } : 
        findSpecificFee(fees, "FEE_POLICY_1");

    const altaLoanPolicyFees = LoanPurposeType === 'Refinance' ? 
        findSpecificFee(fees, "FEE_POLICY_1") : 
        findSpecificFee(fees, "FEE_POLICY_2");

    const settlementFees = LoanPurposeType === 'Refinance'
        ? {
            BuyerFee: (stateFeeData?.SettlementFeeRefi || 0).toString(),
            SellerFee: '0.0'
          }
        : {
            BuyerFee: (stateFeeData?.SettlementFee || 0).toString(),
            SellerFee: '0.0'
          };

    const eaglePolicyTaxFees = LoanPurposeType === 'Refinance' ? 
        { BuyerFee: '0.0', SellerFee: '0.0' } : 
        findSpecificFee(fees, "FEE_POLICY_1_SALES_TAX_1");
    
    const altaLoanPolicyTaxFees = findSpecificFee(fees, "FEE_POLICY_2_SALES_TAX_1");
    
    let recordingFees = extractRecordingFees(fees);
    let transferTaxFees = extractTransferTaxFees(fees);

    // Exclude certain fees for Refinance
    if (LoanPurposeType === 'Refinance' || LoanPurposeType === '$Refinance') {
        recordingFees = recordingFees.filter(fee => fee.DisclosureItemName !== 'Conveyance Deed - State Transfer NY Tax');
        transferTaxFees = transferTaxFees.filter(fee => fee.DisclosureItemName !== 'Conveyance Deed - State Transfer NY Tax');
    }

    // Prepare the extracted fees array
    let extractedFees = [
        {
            FeeDescription: "Title - Owner's Title Insurance",
            ...eaglePolicyFees
        },
        {
            FeeDescription: "Title - Lender's Title Insurance",
            ...altaLoanPolicyFees
        },
        {
            FeeDescription: 'Title - Settlement Fee',
            ...settlementFees
        },
        {
            FeeDescription: "Title - Sales Tax - Owner's Title Insurance",
            ...eaglePolicyTaxFees
        },
        {
            FeeDescription: "Title - Sales Tax - Lender's Title Insurance",
            ...altaLoanPolicyTaxFees
        },
        ...recordingFees,
        ...transferTaxFees
    ];

    // Calculate and add Agricultural Tax if applicable
    if (
        (PostalCode === '02801' || PostalCode === '02837') &&
        ['purchase', 'cash purchase'].includes(LoanPurposeType.toLowerCase())
    ) {
        if (SalesContractAmount > 450000) {
            const agriculturalTax = (SalesContractAmount - 450000) * 0.04;
            console.info('Calculated Agricultural Tax:', agriculturalTax.toFixed(2));
            extractedFees.push({
                FeeDescription: 'Agricultural Tax',
                BuyerFee: agriculturalTax.toFixed(2),
                SellerFee: '0.0'
            });
        }
    }

    // Add additional state-specific fees from FNTEFees table
    const stateFeeTitles = {
        SettlementFee: 'Title - Settlement Fee',
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
                extractedFees.push({
                    FeeDescription: 'Title - Abstractor Title Search',
                    BuyerFee: stateFeeData[feeKey].toString(),
                    SellerFee: '0.0'
                });
                return;
            }

            // Skip non-refi version of AbstractorTitleSearch on refinance
            if (feeKey === 'AbstractorTitleSearch' && LoanPurposeType === 'Refinance') return;

            extractedFees.push({
                FeeDescription: stateFeeTitles[feeKey] || feeKey,
                BuyerFee: stateFeeData[feeKey].toString(),
                SellerFee: '0.0'
            });
        });
    }

    // Exclude specific fees for Refinance
    if (LoanPurposeType === 'Refinance' || LoanPurposeType === '$Refinance') {
        extractedFees = extractedFees.filter(fee => 
            fee.FeeDescription !== "Title - Owner's Title Insurance" && 
            fee.FeeDescription !== "Title - Sales Tax - Owner's Title Insurance" &&
            !fee.DisclosureItemName?.includes("Assignment") &&
            !fee.DisclosureItemName?.includes("Conveyance Deed")
        );
    }

    return extractedFees;
}

/**
 * Map user answers to FirstAm format for L2 request
 * Copied from official-quote-v2/question-parser.js
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
 * Generate default L2 answers for refinance transactions
 * Creates reasonable defaults to automatically answer L2 questions without user interaction
 * @param {number} noteAmount - Loan amount
 * @param {string} stateCode - State code (e.g., FL, CT, RI)
 * @param {string} loanPurposeType - Loan purpose (Refinance expected)
 * @returns {Object} Default answers keyed by paramCode
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

    // State-specific defaults
    if (stateCode === 'FL') {
        // Florida-specific L2 questions (if any beyond above)
        // Most FL questions are already covered above
    } else if (stateCode === 'CT') {
        // Connecticut-specific defaults
        answers['RFC_17_0'] = 'N'; // Various CT-specific tax questions
        answers['RFC_589_0'] = 'N';
        answers['RFC_746_0'] = 'N';
        answers['RFC_746_1'] = 'N';
    } else if (stateCode === 'RI') {
        // Rhode Island-specific defaults
        answers['RFC_236_0'] = 'Y'; // RI-specific questions
    }

    console.info(`📋 Generated ${Object.keys(answers).length} default L2 answers for ${stateCode} ${loanPurposeType}`);
    console.info('Default answers:', answers);

    return answers;
}

/**
 * Build L2 request XML with answers and original data
 * Copied from official-quote-v2/l2-handler.js
 * @param {Object} params - L2 request parameters
 * @param {Object} params.calcRateLevel2Data - Updated L2 data with answers
 * @param {Object} params.originalMISMO - Original MISMO XML from L1 request
 * @returns {string} Complete L2 request XML
 */
function buildL2RequestXML({ calcRateLevel2Data, originalMISMO }) {
    const uuid = require('uuid');

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

    // Build the MISMO XML if provided - should be included in L2 submit
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
    handleQuickQuote
};
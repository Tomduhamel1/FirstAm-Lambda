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
    parseProductList
} = require('../shared/xml-builders');
const constants = require('../shared/constants');

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

    const { PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType } = requestBody;
    
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
        const transactionType = LoanPurposeType === 'Refinance' ? 
            constants.TRANSACTION_TYPES.REFINANCE : 
            constants.TRANSACTION_TYPES.PURCHASE;

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

        // Build and send ProductList request
        const productListRequestXML = buildProductListRequestXML({
            stateCode,
            countyName,
            city,
            transactionType,
            salesContractAmount,
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

        const responseBody = parsedProductList?.['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_TYPE_DATA_RESPONSE']?.['lvis:CalcTypeData'];
        const productList = responseBody?.['lvis:ProductsList'];

        if (!productList) {
            console.error("❌ No valid ProductsList found in ProductList response. Keys:", Object.keys(responseBody || {}));
            throw new Error('❌ No valid ProductsList found in ProductList response');
        }

        // Parse products from the response
        const {
            titlePolicies,
            lenderPolicies,
            endorsementProducts,
            closingProducts,
            recordingProducts,
            otherProducts
        } = parseProductList(productList);

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
                stateCode
            )
        );

        // Settlement/Closing block
        const settlementResult = buildSettlementServiceBlock(closingProducts, 2, stateCode);
        if (settlementResult.xml) {
            servicesParts.push(settlementResult.xml);
            currentSeq = settlementResult.nextSeq;
        }

        // Recording blocks
        const recordingResult = buildRecordingServiceBlock(recordingProducts, currentSeq);
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
        
        // Extract fees from response - handle both array and non-array formats
        const calculatorResponse = parsedResponse['lvis:LVIS_XML']['lvis:LVIS_CALCULATOR_RESPONSE'];
        const response = Array.isArray(calculatorResponse) ? calculatorResponse[0] : calculatorResponse;
        
        if (!response || !response['lvis:MISMO_XML']) {
            throw new Error('Invalid response structure from FirstAm API');
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

        // Calculate total buyer fee
        const totalBuyerFee = extractedFees.reduce((sum, fee) => sum + parseFloat(fee.BuyerFee), 0);

        // Extract and clean loan comment text
        const loanComment = loanComments.find(comment => comment['$']['xlink:label'] === 'RESPONSE_NOTE_1');
        let loanCommentText = loanComment ? loanComment.LoanCommentText[0] : '';
        loanCommentText = loanCommentText.replace(/<[^>]+>/g, ''); // Remove HTML tags

        console.info('Extracted Fees:', extractedFees);
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
                rateCalcGuideResponse: extractedFees,
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

module.exports = {
    handleQuickQuote
};
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
    buildRecordingServiceBlock
} = require('../shared/xml-builders');

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
        forceL2Questions = false // Use RateCalcNoAutoCalc to force L2 questions
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
        const transactionType = LoanPurposeType === 'Refinance' ? 'Refinance' : 'Sale w/ Mortgage';
        const salesAmount = LoanPurposeType === 'Refinance' ? NoteAmount : SalesContractAmount;
        const noteAmount = Number(NoteAmount) === 0 ? 1000 : Number(NoteAmount);
        
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
        
        const productListResponse = await axios.post(
            'https://calculator.lvis.firstam.com/ProductList',
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
            closingProducts,
            recordingProducts
        } = parseProductList(productList);
        
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
                stateCode
            )
        );
        
        const settlementResult = buildSettlementServiceBlock(closingProducts, 2);
        if (settlementResult.xml) {
            servicesParts.push(settlementResult.xml);
            currentSeq = settlementResult.nextSeq;
        }
        
        const recordingResult = buildRecordingServiceBlock(recordingProducts, currentSeq);
        if (recordingResult.xml) {
            servicesParts.push(recordingResult.xml);
        }
        
        const servicesBlock = servicesParts.join('\n');
        
        // Step 2: Send RateCalc L1 request
        const actionType = forceL2Questions ? 'RateCalcNoAutoCalc' : 'RateCalc';
        
        const requestXML = buildRateCalcRequestXMLForL1({
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
        
        const l1Response = await axios.post(
            'https://calculator.lvis.firstam.com/',
            requestXML,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/xml'
                }
            }
        );
        
        console.info('L1 Response received, parsing...');
        
        const parsedL1Response = await xml2js.parseStringPromise(l1Response.data, {
            explicitArray: false,
            ignoreAttrs: false,
        });
        
        // Check if rates are calculated or L2 questions are needed
        const calculatorResponse = parsedL1Response['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_RESPONSE'];
        const hasCalculatedRates = calculatorResponse?.['lvis:HasCalculatedRates'] === 'true';
        
        if (hasCalculatedRates) {
            console.info('Rates calculated in L1 response');
            
            // Parse and return rates (similar to quick quote)
            const fees = parseFees(parsedL1Response);
            const loanComments = parseLoanComments(parsedL1Response);
            
            return {
                type: 'rates',
                hasCalculatedRates: true,
                fees,
                loanComments,
                locationData: {
                    city,
                    county: countyName,
                    state: stateCode
                }
            };
        } else {
            console.info('L2 questions required');
            
            // Parse L2 questions
            const calcRateLevel2Data = calculatorResponse?.['lvis:CalcRateLevel2Data'];
            const questions = parseL2Questions(calcRateLevel2Data);
            
            // Store original MISMO_XML for L2 request
            const originalMISMO = calculatorResponse?.['lvis:MISMO_XML'];
            
            return {
                type: 'questions',
                hasCalculatedRates: false,
                questions,
                calcRateLevel2Data, // Store entire L2 data for echoing back
                originalMISMO, // Store for L2 request
                locationData: {
                    city,
                    county: countyName,
                    state: stateCode
                }
            };
        }
        
    } catch (error) {
        console.error('Error in L1 request:', error);
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
                        <CountyName>${countyName}</CountyName>
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

module.exports = {
    handleL1Request
};
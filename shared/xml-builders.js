const { v4: uuidv4 } = require('uuid');

function buildTitleServiceBlock(
    titlePolicies,
    secondPolicies,
    endorsementProducts,
    noteAmount,
    salesAmount,
    effectiveDate,
    LoanPurposeType,
    stateCode
) {
    let seq = 1;
    let xml = `<SERVICE SequenceNumber="${seq++}"><TITLE><TITLE_RESPONSE><TITLE_PRODUCTS><TITLE_PRODUCT><TITLE_POLICIES>`;

    // Owner's Policy – uses salesAmount
    if (titlePolicies.length) {
        xml += titlePolicies.map((p, i) => {
            const id = p['lvis:PolicyId'];
            const name = p['lvis:PolicyName'] || p['lvis:ProductName'];

            const defaultRateTypeId = p['lvis:DefaultRateTypeId'];
            const validRateTypes = p['lvis:ValidRateTypes']?.['lvis:KeyValue'];
            let rateType = 'Basic'; // fallback

            if (Array.isArray(validRateTypes)) {
                const match = validRateTypes.find(rt => rt['lvis:Key'] === defaultRateTypeId);
                if (match) rateType = match['lvis:Value'];
            } else if (validRateTypes?.['lvis:Key'] === defaultRateTypeId) {
                rateType = validRateTypes['lvis:Value'];
            }

            return `
        <TITLE_POLICY xlink:label="POLICY_${i + 1}" SequenceNumber="${i + 1}">
          <TITLE_POLICY_DETAIL>
            <TitleInsuranceAmount>${salesAmount}</TitleInsuranceAmount>
            <TitlePolicyEffectiveDate>${effectiveDate}</TitlePolicyEffectiveDate>
            <TitlePolicyIdentifier>${id}</TitlePolicyIdentifier>
            <EXTENSION><OTHER><lvis:TITLE_POLICY_DETAIL_EXTENSION>
              <lvis:ProductName>${name}</lvis:ProductName>
              <lvis:RateType>${rateType}</lvis:RateType>
            </lvis:TITLE_POLICY_DETAIL_EXTENSION></OTHER></EXTENSION>
          </TITLE_POLICY_DETAIL>
        </TITLE_POLICY>`;
        }).join('');
    }

    // Lender's Policy – uses noteAmount — SKIP if Cash Purchase
    if (secondPolicies.length && LoanPurposeType !== 'Cash Purchase') {
        xml += secondPolicies.map((p, i) => {
            const id = p['lvis:PolicyId'];
            const name = p['lvis:PolicyName'] || p['lvis:ProductName'];

            const defaultRateTypeId = p['lvis:DefaultRateTypeId'];
            const validRateTypes = p['lvis:ValidRateTypes']?.['lvis:KeyValue'];
            let rateType = 'Basic'; // fallback

            if (Array.isArray(validRateTypes)) {
                const match = validRateTypes.find(rt => rt['lvis:Key'] === defaultRateTypeId);
                if (match) rateType = match['lvis:Value'];
            } else if (validRateTypes?.['lvis:Key'] === defaultRateTypeId) {
                rateType = validRateTypes['lvis:Value'];
            }

            const matchingEndorsements = endorsementProducts.filter(e => e['lvis:ParentPolicyId'] === id);
            const endorsementsXML = matchingEndorsements.map((e, j) => `
        <TITLE_ENDORSEMENT xlink:label="POLICY_2_ENDR_${j + 1}" SequenceNumber="${j + 1}">
          <TitleEndorsementFormIdentifier>${e['lvis:ProductId']}</TitleEndorsementFormIdentifier>
          <TitleEndorsementFormName>${e['lvis:ProductName']}</TitleEndorsementFormName>
          <Concurrent_Endoresements />
        </TITLE_ENDORSEMENT>`).join('');

            return `
        <TITLE_POLICY xlink:label="POLICY_${i + 2}" SequenceNumber="${i + 2}">
          ${endorsementsXML ? `<TITLE_ENDORSEMENTS>${endorsementsXML}</TITLE_ENDORSEMENTS>` : ''}
          <TITLE_POLICY_DETAIL>
            <TitleInsuranceAmount>${noteAmount}</TitleInsuranceAmount>
            <TitlePolicyEffectiveDate>${effectiveDate}</TitlePolicyEffectiveDate>
            <TitlePolicyIdentifier>${id}</TitlePolicyIdentifier>
            <EXTENSION><OTHER><lvis:TITLE_POLICY_DETAIL_EXTENSION>
              <lvis:ProductName>${name}</lvis:ProductName>
              <lvis:RateType>${rateType}</lvis:RateType>
            </lvis:TITLE_POLICY_DETAIL_EXTENSION></OTHER></EXTENSION>
          </TITLE_POLICY_DETAIL>
        </TITLE_POLICY>`;
        }).join('');
    }

    xml += `</TITLE_POLICIES></TITLE_PRODUCT></TITLE_PRODUCTS></TITLE_RESPONSE></TITLE>`;
    xml += `<SERVICE_PRODUCT><SERVICE_PRODUCT_REQUEST><SERVICE_PRODUCT_DETAIL><ServiceProductDescription>TitlePolicy</ServiceProductDescription></SERVICE_PRODUCT_DETAIL></SERVICE_PRODUCT_REQUEST></SERVICE_PRODUCT>`;
    xml += `</SERVICE>`;

    return xml;
}

function buildSettlementServiceBlock(settlementProducts, currentSeq, stateCode) {
    let seq = currentSeq;
    
    // Skip settlement block entirely for Florida due to FirstAm API bug with ID 531
    if (stateCode === 'FL') {
        return { xml: '', nextSeq: seq };
    }
    
    if (!settlementProducts.length) {
        return { xml: '', nextSeq: seq };
    }

    const xml = `
<SERVICE SequenceNumber="${seq++}">
  <SERVICE_PRODUCT>
    <SERVICE_PRODUCT_REQUEST>
      <SERVICE_PRODUCT_DETAIL>
        <ServiceProductDescription>ClosingCost</ServiceProductDescription>
      </SERVICE_PRODUCT_DETAIL>
      <SERVICE_PRODUCT_NAMES>
        ${settlementProducts.map((product, i) => {
            const productId = product.lvis?.ProductId || product['lvis:ProductId'];
            const productName = product.lvis?.ProductName || product['lvis:ProductName'];
            const safeLabel = `CLOSING_${productId}`.replace(/[^A-Z0-9_]/g, '_');
            
            return `
        <SERVICE_PRODUCT_NAME xlink:label="${safeLabel}" SequenceNumber="${i + 1}">
          <SERVICE_PRODUCT_NAME_DETAIL>
            <ServiceProductNameDescription>${productName}</ServiceProductNameDescription>
            <ServiceProductNameIdentifier>${productId}</ServiceProductNameIdentifier>
          </SERVICE_PRODUCT_NAME_DETAIL>
        </SERVICE_PRODUCT_NAME>`;
        }).join('')}
      </SERVICE_PRODUCT_NAMES>
    </SERVICE_PRODUCT_REQUEST>
  </SERVICE_PRODUCT>
</SERVICE>`;

    return { xml, nextSeq: seq };
}

function buildRecordingServiceBlock(recordingProducts, currentSeq, pageNumbers = null, salesContractAmount = null, noteAmount = null) {
    let seq = currentSeq;
    
    // Log page numbers if provided
    if (pageNumbers) {
        console.info('Page numbers provided:', JSON.stringify(pageNumbers));
    }
    
    console.info(`Recording products from ProductList: ${recordingProducts ? recordingProducts.length : 0}`);
    
    // For CT and other states where ProductList doesn't return recording products,
    // use standard recording documents based on the simulator
    if (!recordingProducts || !recordingProducts.length) {
        // Default recording products for Purchase/Refinance transactions
        // Use provided page numbers or defaults
        const deedPages = pageNumbers?.deedPages || 3;
        const mortgagePages = pageNumbers?.mortgagePages || 15;
        
        console.info(`Using recording page counts: deed=${deedPages}, mortgage=${mortgagePages}`);
        
        recordingProducts = [
            { name: 'Conveyance Deed', identifier: 'DEED', pages: deedPages, consideration: null },
            { name: 'Mortgage (Deed of Trust)', identifier: 'MORTGAGE', pages: mortgagePages, consideration: null }
        ];
    }

    console.info(`Building recording services for ${recordingProducts.length} products`);
    const xml = recordingProducts.map((product, index) => {
        // Determine the identifier and name
        let identifier, name, pages, labelPrefix;
        
        if (product.identifier) {
            // Using our default structure
            identifier = product.identifier;
            name = product.name;
            // Override with user-provided page numbers if available
            if (pageNumbers) {
                if (identifier === 'DEED' && pageNumbers.deedPages) {
                    pages = pageNumbers.deedPages;
                } else if (identifier === 'MORTGAGE' && pageNumbers.mortgagePages) {
                    pages = pageNumbers.mortgagePages;
                } else {
                    pages = product.pages;
                }
            } else {
                pages = product.pages;
            }
            labelPrefix = `RECORDING_${index + 1}`;
        } else {
            // From ProductList (if it ever returns data)
            const id = product['lvis:DocId'] || product['lvis:Id'];
            name = product['lvis:DocName'] || product['lvis:Name'];
            const defaultPages = product['lvis:Pages'] || product['lvis:DefaultPages'] || 1;

            // Map the name to the correct identifier
            // Check mortgage first since "Mortgage (Deed of Trust)" contains both words
            if (name && (name.toLowerCase().includes('mortgage') || name.toLowerCase().includes('trust'))) {
                identifier = 'MORTGAGE';
                // Use user-provided page numbers if available
                pages = pageNumbers?.mortgagePages || defaultPages;
            } else if (name && name.toLowerCase().includes('deed')) {
                identifier = 'DEED';
                // Use user-provided page numbers if available
                pages = pageNumbers?.deedPages || defaultPages;
            } else {
                identifier = id || `DOC_${index}`;
                pages = defaultPages;
            }
            labelPrefix = `RECORDING_${index + 1}`;
        }
        
        // Determine consideration amount based on document type
        // Use actual amounts if provided, otherwise use defaults
        const considerationAmount = identifier === 'DEED' 
            ? (salesContractAmount || '500000')
            : (noteAmount || '400000');
        
        console.info(`Building recording service ${index + 1}: ${identifier} - ${name}, pages: ${pages}, consideration: ${considerationAmount}`);

        return `
<SERVICE SequenceNumber="${seq++}">
  <SERVICE_PRODUCT>
    <SERVICE_PRODUCT_REQUEST>
      <SERVICE_PRODUCT_DETAIL>
        <ServiceProductDescription>Recording</ServiceProductDescription>
      </SERVICE_PRODUCT_DETAIL>
      <SERVICE_PRODUCT_NAMES>
        <SERVICE_PRODUCT_NAME xlink:label="${labelPrefix}" SequenceNumber="1">
          <SERVICE_PRODUCT_NAME_DETAIL>
            <ServiceProductNameDescription>${name}</ServiceProductNameDescription>
            <ServiceProductNameIdentifier>${identifier}</ServiceProductNameIdentifier>
          </SERVICE_PRODUCT_NAME_DETAIL>
        </SERVICE_PRODUCT_NAME>
        <SERVICE_PRODUCT_NAME xlink:label="${labelPrefix}_CONSIDERATION" SequenceNumber="2">
          <SERVICE_PRODUCT_NAME_DETAIL>
            <ServiceProductNameDescription>ConsiderationAmount</ServiceProductNameDescription>
            <ServiceProductNameIdentifier>${considerationAmount}</ServiceProductNameIdentifier>
          </SERVICE_PRODUCT_NAME_DETAIL>
        </SERVICE_PRODUCT_NAME>
        <SERVICE_PRODUCT_NAME xlink:label="${labelPrefix}_PAGES" SequenceNumber="3">
          <SERVICE_PRODUCT_NAME_DETAIL>
            <ServiceProductNameDescription>PageCount</ServiceProductNameDescription>
            <ServiceProductNameIdentifier>${pages}</ServiceProductNameIdentifier>
          </SERVICE_PRODUCT_NAME_DETAIL>
        </SERVICE_PRODUCT_NAME>
      </SERVICE_PRODUCT_NAMES>
    </SERVICE_PRODUCT_REQUEST>
  </SERVICE_PRODUCT>
</SERVICE>`;
    }).join('');

    return { xml, nextSeq: seq };
}

function buildProductListRequestXML({
    stateCode,
    countyName,
    city,
    transactionType,
    salesContractAmount,
    noteAmount,
    effectiveDate,
}) {
    // Fix EffectiveDate format: remove commas if present
    const cleanEffectiveDate = effectiveDate.replace(',', '');

    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>ProductList</lvis:LVISActionType>
    <lvis:ClientCustomerId>FNTE</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>CALC-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_CALCULATOR_TYPE_DATA_REQUEST>
    <lvis:LVIS_REQUEST_PARAMS>
      <lvis:LVIS_NAME_VALUE><lvis:Name>PropertyStateCode</lvis:Name><lvis:Value>${stateCode}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>PropertyCountyName</lvis:Name><lvis:Value>${countyName}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>PropertyCityName</lvis:Name><lvis:Value>${city}</lvis:Value></lvis:LVIS_NAME_VALUE>
      
      <lvis:LVIS_NAME_VALUE><lvis:Name>ClosingStateCode</lvis:Name><lvis:Value /></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>ClosingCountyName</lvis:Name><lvis:Value /></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>ClosingCityName</lvis:Name><lvis:Value /></lvis:LVIS_NAME_VALUE>
      
      <lvis:LVIS_NAME_VALUE><lvis:Name>TransactionType</lvis:Name><lvis:Value>${transactionType}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>SalesAmount</lvis:Name><lvis:Value>${salesContractAmount}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>LoanAmount</lvis:Name><lvis:Value>${noteAmount}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>EffectiveDate</lvis:Name><lvis:Value>${cleanEffectiveDate}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>PropertyType</lvis:Name><lvis:Value>Residential</lvis:Value></lvis:LVIS_NAME_VALUE>
      
      <lvis:LVIS_NAME_VALUE><lvis:Name>IsTitle</lvis:Name><lvis:Value>True</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>IsClosing</lvis:Name><lvis:Value>True</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>IsRecording</lvis:Name><lvis:Value>True</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>IsEndorsements</lvis:Name><lvis:Value>True</lvis:Value></lvis:LVIS_NAME_VALUE>
    </lvis:LVIS_REQUEST_PARAMS>
  </lvis:LVIS_CALCULATOR_TYPE_DATA_REQUEST>
</lvis:LVIS_XML>`;
}

function buildRateCalcRequestXML({
    actionType = 'RateCalc',  // Default to RateCalc if not specified
    PostalCode,
    SalesContractAmount,
    NoteAmount,
    LoanPurposeType,
    city,
    countyName,
    stateCode,
    servicesBlock
}) {
    const salesAmount = LoanPurposeType === 'Refinance' ? NoteAmount : SalesContractAmount;
    const noteAmountToUse = Number(NoteAmount) === 0 ? 1000 : NoteAmount;

    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>${actionType}</lvis:LVISActionType>
    <lvis:ClientCustomerId>FNTE</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>CALC-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_CALCULATOR_REQUEST>
    <lvis:MISMO_XML>
      <MESSAGE MISMOReferenceModelIdentifier="3.4.0" xmlns="http://www.mismo.org/residential/2009/schemas">
        <DEAL_SETS>
          <DEAL_SET>
            <DEALS>
              <DEAL>
                <PARTIES>
                  <PARTY SequenceNumber="1">
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
                  <COLLATERAL SequenceNumber="1">
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
                  <LOAN SequenceNumber="1">
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

function parseProductList(productList) {
    const getEnabledProducts = (group) => {
        if (!group) return [];
        const products = Array.isArray(group) ? group : [group];
        return products.filter(p => p['lvis:IsDefault'] === 'true');
    };

    const parseSettlementProducts = (closingCostsRaw) => {
        if (!closingCostsRaw) return [];
        
        const closingCosts = Array.isArray(closingCostsRaw) ? closingCostsRaw : [closingCostsRaw];
        const defaultClosingCost = closingCosts.find(c => c['lvis:IsDefault'] === 'true');
        if (!defaultClosingCost) {
            console.warn('⚠️ No default ClosingCost found in ProductList.');
            return [];
        }
        
        const includedFees = defaultClosingCost['lvis:IncludedFees']?.['lvis:ClosingFee'];
        if (!includedFees) {
            console.warn('⚠️ No IncludedFees found in default ClosingCost.');
            return [];
        }
        
        const fees = Array.isArray(includedFees) ? includedFees : [includedFees];
        return fees
            .filter(fee => fee['lvis:Name'] && fee['lvis:Id'])
            .map(fee => ({
                lvis: {
                    ProductName: fee['lvis:Name'],
                    ProductId: fee['lvis:Id']
                }
            }));
    };

    const titlePolicies = getEnabledProducts(productList['lvis:PolicyProducts']?.['lvis:PolicyProduct']);
    const rawSecondPolicies = productList['lvis:SecondPolicyProducts']?.['lvis:PolicyProduct'];
    const secondPolicies = getEnabledProducts(rawSecondPolicies);
    const lenderPolicies = secondPolicies.length > 0 ? secondPolicies : titlePolicies;
    const endorsementProducts = getEnabledProducts(productList['lvis:Endorsements']?.['lvis:Endorsement']);
    
    const closingCostsRaw = productList['lvis:ClosingCosts']?.['lvis:ClosingCost'];
    const closingProducts = parseSettlementProducts(closingCostsRaw);
    
    const recordingProductsRaw = productList['lvis:RecordingDocTypes']?.['lvis:RecordingDocType'];
    const recordingProducts = (Array.isArray(recordingProductsRaw) ? recordingProductsRaw : [recordingProductsRaw])
        .filter(p => p?.['lvis:IsDefault'] === 'true');
    
    const otherProductsRaw = productList['lvis:OtherProducts']?.['lvis:Product'];
    const otherProducts = (Array.isArray(otherProductsRaw) ? otherProductsRaw : [otherProductsRaw])
        .filter(p => p?.['lvis:IsDefault'] === 'true');

    return {
        titlePolicies,
        lenderPolicies,
        endorsementProducts,
        closingProducts,
        recordingProducts,
        otherProducts
    };
}

module.exports = {
    buildTitleServiceBlock,
    buildSettlementServiceBlock,
    buildRecordingServiceBlock,
    buildProductListRequestXML,
    buildRateCalcRequestXML,
    parseProductList
};
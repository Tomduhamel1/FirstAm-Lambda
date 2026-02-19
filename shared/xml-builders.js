const { v4: uuidv4 } = require('uuid');

function buildTitleServiceBlock(
    titlePolicies,
    secondPolicies,
    endorsementProducts,
    noteAmount,
    salesAmount,
    effectiveDate,
    LoanPurposeType,
    stateCode,
    includeEndorsements = false,  // Feature flag for endorsements
    allEndorsementsList = [],
    selectedEndorsementIds = [],
    transactionType = null  // Transaction type from ProductList API
) {
    // TN requires simple SERVICE_PRODUCT_FULFILLMENT structure instead of complex TITLE block
    const useSimpleStructure = stateCode === 'TN';

    if (useSimpleStructure) {
        console.info(`🔧 Using simple SERVICE_PRODUCT_FULFILLMENT structure for transaction type: "${transactionType}"`);

        // Simple structure used by TN and similar states
        return `<SERVICE SequenceNumber="1">
  <SERVICE_PRODUCT>
    <SERVICE_PRODUCT_REQUEST>
      <SERVICE_PRODUCT_DETAIL>
        <ServiceProductDescription>Title Insurance</ServiceProductDescription>
      </SERVICE_PRODUCT_DETAIL>
      <SERVICE_PRODUCT_FULFILLMENT>
        <SERVICE_PRODUCT_FULFILLMENT_DETAIL>
          <ProductAmountDescription>${transactionType}</ProductAmountDescription>
        </SERVICE_PRODUCT_FULFILLMENT_DETAIL>
      </SERVICE_PRODUCT_FULFILLMENT>
    </SERVICE_PRODUCT_REQUEST>
  </SERVICE_PRODUCT>
</SERVICE>`;
    }

    // Complex TITLE block structure for other states
    console.info(`🔧 Using complex TITLE block structure`);
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

            // Get endorsements for this policy if flag is enabled
            // Includes both defaults and user-selected endorsements
            const policyEndorsements = includeEndorsements
                ? getEndorsementsForPolicy(p, allEndorsementsList, selectedEndorsementIds)
                : [];
            const endorsementsXML = buildEndorsementsXML(policyEndorsements, i + 1);

            return `
        <TITLE_POLICY xlink:label="POLICY_${i + 1}" SequenceNumber="${i + 1}">
          ${endorsementsXML}
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

            // Log rate type information for debugging
            console.info(`\n📊 Rate Type Analysis for Policy ${id}: "${name}"`);
            console.info(`   Default Rate Type ID: ${defaultRateTypeId}`);
            console.info(`   ValidRateTypes structure type: ${Array.isArray(validRateTypes) ? 'Array' : typeof validRateTypes}`);

            if (Array.isArray(validRateTypes)) {
                console.info(`   Available Rate Types (${validRateTypes.length}):`);
                validRateTypes.forEach(rt => {
                    console.info(`      - Key: ${rt['lvis:Key']}, Value: ${rt['lvis:Value']}`);
                });
            } else if (validRateTypes) {
                console.info(`   Single Rate Type: Key=${validRateTypes['lvis:Key']}, Value=${validRateTypes['lvis:Value']}`);
            } else {
                console.warn(`   ⚠️  No ValidRateTypes found for this policy!`);
            }

            // Check if this is a Short Form Residential Loan Policy
            const isShortFormPolicy = name &&
                name.toLowerCase().includes('short form') &&
                name.toLowerCase().includes('residential') &&
                name.toLowerCase().includes('loan');

            // For Short Form policies, use priority-based rate type selection for refinance
            // Priority order (best to worst):
            // 1. Reissue (Key=2) - standard reissue rate (30-40% discount)
            // 2. Bundled Loan - Refinance (Key=129) - refinance-specific bundled rate
            // 3. Non Bundled Loan - Refinance (Key=272) - refinance-specific non-bundled rate
            // 4. Basic (Key=1) - fallback (no discount)
            // NOTE: Reissue may require L2 questions, but Quick Quote endpoint
            // automatically handles these with reasonable defaults (prior liability = current loan, date = 1yr ago)
            // For interactive L2 flow, use /official-quote-v2 endpoint instead.
            if (isShortFormPolicy) {
                console.info(`🎯 Short Form policy detected: "${name}"`);
                console.info(`   Searching for best rate type using priority order...`);

                // Define priority order for rate type selection (Key => Name mapping)
                const ratePriority = [
                    { key: '2', name: 'Reissue', discount: '30-40%' },
                    { key: '3', name: 'Refinance', discount: '40%' },  // Added after testing RI - saves $500!
                    { key: '129', name: 'Bundled Loan - Refinance', discount: 'varies' },
                    { key: '272', name: 'Non Bundled Loan - Refinance', discount: 'varies' },
                    { key: '1', name: 'Basic', discount: 'none' }
                ];

                let selectedRateType = null;
                let selectionReason = '';

                // Search through priority list
                if (Array.isArray(validRateTypes)) {
                    for (const priority of ratePriority) {
                        const match = validRateTypes.find(rt => rt['lvis:Key'] === priority.key);
                        if (match) {
                            selectedRateType = match;
                            selectionReason = `Found ${priority.name} (Key=${priority.key}, discount: ${priority.discount})`;
                            console.info(`   ✅ ${selectionReason}`);
                            break;
                        } else {
                            console.info(`   ⏭️  Skipping ${priority.name} (Key=${priority.key}) - not available`);
                        }
                    }
                } else if (validRateTypes) {
                    // Single rate type - check if it matches any priority
                    const match = ratePriority.find(p => p.key === validRateTypes['lvis:Key']);
                    if (match) {
                        selectedRateType = validRateTypes;
                        selectionReason = `Single rate type: ${match.name} (Key=${match.key})`;
                        console.info(`   ✅ ${selectionReason}`);
                    } else {
                        // Use whatever single rate type is available
                        selectedRateType = validRateTypes;
                        selectionReason = `Using available rate type (Key=${validRateTypes['lvis:Key']})`;
                        console.warn(`   ⚠️  ${selectionReason}`);
                    }
                } else {
                    console.warn(`   ⚠️  No validRateTypes structure to search!`);
                }

                if (selectedRateType) {
                    rateType = selectedRateType['lvis:Value'];
                    console.info(`✅ Selected rate type: "${rateType}" - ${selectionReason}`);

                    // Notify about L2 question auto-handling for reissue rate
                    if (selectedRateType['lvis:Key'] === '2') {
                        console.info(`   ℹ️  This rate may trigger L2 questions (auto-handled with defaults in quick-quote)`);
                    }
                } else {
                    // Ultimate fallback (should never happen if Basic is in the list)
                    rateType = 'Basic';
                    console.warn(`⚠️  No matching rate type found - using fallback: ${rateType}`);
                }
            } else {
                // Standard logic for non-Short Form policies: use default rate type
                console.info(`   Using default rate type ID: ${defaultRateTypeId}`);
                if (Array.isArray(validRateTypes)) {
                    const match = validRateTypes.find(rt => rt['lvis:Key'] === defaultRateTypeId);
                    if (match) {
                        rateType = match['lvis:Value'];
                        console.info(`   ✅ Found matching rate type: ${rateType}`);
                    } else {
                        console.warn(`   ⚠️  Default rate type ID ${defaultRateTypeId} not found in available rate types, using fallback: ${rateType}`);
                    }
                } else if (validRateTypes?.['lvis:Key'] === defaultRateTypeId) {
                    rateType = validRateTypes['lvis:Value'];
                    console.info(`   ✅ Single rate type matches default: ${rateType}`);
                } else {
                    console.warn(`   ⚠️  Could not match default rate type, using fallback: ${rateType}`);
                }
            }

            // Get endorsements for this policy if flag is enabled
            // Includes both defaults and user-selected endorsements
            const policyEndorsements = includeEndorsements
                ? getEndorsementsForPolicy(p, allEndorsementsList, selectedEndorsementIds)
                : [];
            const endorsementsXML = buildEndorsementsXML(policyEndorsements, i + 2);

            return `
        <TITLE_POLICY xlink:label="POLICY_${i + 2}" SequenceNumber="${i + 2}">
          ${endorsementsXML}
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
        // Use provided page numbers or defaults (4 deed, 25 mortgage)
        const deedPages = pageNumbers?.deedPages || 4;
        const mortgagePages = pageNumbers?.mortgagePages || 25;
        
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
            const defaultPages = product['lvis:Pages'] || product['lvis:DefaultPages'] || product['lvis:NumberOfPages'] || 1;

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

        const serviceXML = `
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

        console.info(`📝 Generated recording service ${index + 1} XML:\n`, serviceXML);
        return serviceXML;
    }).join('');

    return { xml, nextSeq: seq };
}

/**
 * Build TransactionTypes pre-request XML (Phase I, Step 2)
 * Per RateTrans.pdf Section 6.3.5: Returns available transaction types for a given state and property type
 */
function buildTransactionTypesRequestXML({
    stateCode,
    propertyType = 'Residential',
    effectiveDate
}) {
    // Fix EffectiveDate format: remove commas if present
    const cleanEffectiveDate = effectiveDate ? effectiveDate.replace(',', '') : new Date().toISOString().split('T')[0];

    return `<?xml version="1.0" encoding="utf-8"?>
<lvis:LVIS_XML xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:lvis="http://services.firstam.com/lvis/v2.0">
  <lvis:LVIS_HEADER>
    <lvis:LVISActionType>TransactionTypes</lvis:LVISActionType>
    <lvis:ClientCustomerId>FNTE</lvis:ClientCustomerId>
    <lvis:ClientUniqueRequestId>CALC-${uuidv4()}</lvis:ClientUniqueRequestId>
  </lvis:LVIS_HEADER>
  <lvis:LVIS_CALCULATOR_TYPE_DATA_REQUEST>
    <lvis:LVIS_REQUEST_PARAMS>
      <lvis:LVIS_NAME_VALUE><lvis:Name>PropertyStateCode</lvis:Name><lvis:Value>${stateCode}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>PropertyType</lvis:Name><lvis:Value>${propertyType}</lvis:Value></lvis:LVIS_NAME_VALUE>
      <lvis:LVIS_NAME_VALUE><lvis:Name>EffectiveDate</lvis:Name><lvis:Value>${cleanEffectiveDate}</lvis:Value></lvis:LVIS_NAME_VALUE>
    </lvis:LVIS_REQUEST_PARAMS>
  </lvis:LVIS_CALCULATOR_TYPE_DATA_REQUEST>
</lvis:LVIS_XML>`;
}

/**
 * Parse TransactionTypes response XML
 * Returns array of available transaction type names
 */
function parseTransactionTypesResponse(parsedXML) {
    try {
        const calcTypeData = parsedXML?.['lvis:LVIS_XML']?.['lvis:LVIS_CALCULATOR_TYPE_DATA_RESPONSE']?.['lvis:CalcTypeData'];
        const transactionTypesList = calcTypeData?.['lvis:TransactionTypesList']?.['lvis:TransactionTypes'];

        if (!transactionTypesList) {
            console.warn('⚠️ No TransactionTypesList found in response');
            return [];
        }

        const keyValues = transactionTypesList['lvis:KeyValue'];
        if (!keyValues) {
            console.warn('⚠️ No KeyValue found in TransactionTypes');
            return [];
        }

        // Normalize to array
        const transactionTypes = Array.isArray(keyValues) ? keyValues : [keyValues];

        // Extract transaction type names
        const names = transactionTypes.map(kv => kv['lvis:Value']).filter(Boolean);

        console.info(`✅ Found ${names.length} transaction types:`, names);
        return names;
    } catch (error) {
        console.error('❌ Error parsing TransactionTypes response:', error);
        return [];
    }
}

function buildProductListRequestXML({
    stateCode,
    countyName,
    city,
    transactionType,
    salesAmount,
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
      <lvis:LVIS_NAME_VALUE><lvis:Name>SalesAmount</lvis:Name><lvis:Value>${salesAmount}</lvis:Value></lvis:LVIS_NAME_VALUE>
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

function parseProductList(productList, transactionType = 'Sale w/ Mortgage') {
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

    const isRefinance = transactionType === 'Refinance';

    const titlePolicies = getEnabledProducts(productList['lvis:PolicyProducts']?.['lvis:PolicyProduct']);
    const rawSecondPolicies = productList['lvis:SecondPolicyProducts']?.['lvis:PolicyProduct'];
    const secondPolicies = getEnabledProducts(rawSecondPolicies);

    // For Refinance: only use lender policies (no owner's policy)
    // For Purchase: use owner's policy (titlePolicies) and lender's policy (secondPolicies or fallback to titlePolicies)
    let ownerPolicies;
    let lenderPolicies;

    if (isRefinance) {
        // Refinance only has lender's policy, no owner's policy
        ownerPolicies = [];

        // Get ALL available lender policies (PolicyCategoryId === '2'), not just defaults
        const allPolicyProducts = productList['lvis:PolicyProducts']?.['lvis:PolicyProduct'];
        const allPolicies = allPolicyProducts ?
            (Array.isArray(allPolicyProducts) ? allPolicyProducts : [allPolicyProducts]) :
            [];

        // Filter for lender policies (PolicyCategoryId === '2')
        const allLenderPolicies = allPolicies.filter(p => p['lvis:PolicyCategoryId'] === '2');

        // Log all available lender policies for debugging
        if (allLenderPolicies.length > 0) {
            console.info(`📋 Found ${allLenderPolicies.length} lender policies for refinance:`);
            allLenderPolicies.forEach((policy, idx) => {
                const id = policy['lvis:PolicyId'];
                const name = policy['lvis:PolicyName'] || policy['lvis:ProductName'];
                const isDefault = policy['lvis:IsDefault'];
                console.info(`  ${idx + 1}. ID ${id}: "${name}" (IsDefault=${isDefault})`);
            });
        }

        // Try to find Short Form Residential Loan Policy (lower-cost option)
        const shortFormPolicy = allLenderPolicies.find(p => {
            const name = (p['lvis:PolicyName'] || p['lvis:ProductName'] || '').toLowerCase();
            return name.includes('short form') && name.includes('residential') && name.includes('loan');
        });

        if (shortFormPolicy) {
            const policyName = shortFormPolicy['lvis:PolicyName'] || shortFormPolicy['lvis:ProductName'];
            console.info(`✅ Using Short Form Residential Loan Policy for refinance: "${policyName}"`);
            lenderPolicies = [shortFormPolicy]; // Use ONLY the Short Form policy
        } else {
            // Fallback to existing logic - use defaults from SecondPolicyProducts or PolicyProducts
            console.info('⚠️ Short Form policy not found, falling back to default lender policy');
            lenderPolicies = secondPolicies.length > 0 ? secondPolicies : titlePolicies;
        }
    } else {
        // Purchase has both owner's and lender's policies
        ownerPolicies = titlePolicies;
        lenderPolicies = secondPolicies.length > 0 ? secondPolicies : titlePolicies;
    }

    const endorsementProducts = getEnabledProducts(productList['lvis:Endorsements']?.['lvis:Endorsement']);

    // Also get ALL endorsements (not filtered by IsDefault) for use with feature flag
    const allEndorsementsRaw = productList['lvis:Endorsements']?.['lvis:Endorsement'];
    const allEndorsements = Array.isArray(allEndorsementsRaw) ? allEndorsementsRaw : (allEndorsementsRaw ? [allEndorsementsRaw] : []);

    const closingCostsRaw = productList['lvis:ClosingCosts']?.['lvis:ClosingCost'];
    const closingProducts = parseSettlementProducts(closingCostsRaw);

    const recordingProductsRaw = productList['lvis:RecordingDocTypes']?.['lvis:RecordingDocType'];
    console.info('🔍 Raw recording products from ProductList:', JSON.stringify(recordingProductsRaw, null, 2));

    const recordingProducts = (Array.isArray(recordingProductsRaw) ? recordingProductsRaw : [recordingProductsRaw])
        .filter(p => p?.['lvis:IsDefault'] === 'true');

    console.info('📄 Filtered recording products (IsDefault=true):', JSON.stringify(recordingProducts, null, 2));
    if (recordingProducts && recordingProducts.length > 0) {
        console.info(`📄 Recording products details for debugging:`);
        recordingProducts.forEach((p, idx) => {
            console.info(`  Product ${idx + 1}:`, JSON.stringify(p, null, 2));
        });
    }

    const otherProductsRaw = productList['lvis:OtherProducts']?.['lvis:Product'];
    const otherProducts = (Array.isArray(otherProductsRaw) ? otherProductsRaw : [otherProductsRaw])
        .filter(p => p?.['lvis:IsDefault'] === 'true');

    return {
        titlePolicies: ownerPolicies,
        lenderPolicies,
        endorsementProducts,
        allEndorsements,  // NEW - full list for use with feature flag
        closingProducts,
        recordingProducts,
        otherProducts
    };
}

/**
 * Get default endorsements for a specific policy
 * @param {Object} policy - The policy object from ProductList
 * @param {Array} allEndorsements - All available endorsements from ProductList
 * @returns {Array} - Array of endorsement objects that match this policy
 */
function getDefaultEndorsementsForPolicy(policy, allEndorsements) {
    if (!policy || !allEndorsements || !Array.isArray(allEndorsements)) {
        return [];
    }

    // Get default endorsement IDs for this policy
    const defaultEndorsementIds = policy['lvis:DefaultEndorsementIds']?.['lvis:string'];

    // Debug: Log policy structure to understand what fields are available
    const policyName = policy['lvis:PolicyName'] || 'Unknown Policy';
    const policyCategoryId = policy['lvis:PolicyCategoryId'];
    console.info(`📋 Policy: "${policyName}" (Category ${policyCategoryId})`);
    console.info(`   Has DefaultEndorsementIds: ${defaultEndorsementIds ? 'YES' : 'NO'}`);

    if (!defaultEndorsementIds || defaultEndorsementIds.length === 0) {
        console.info(`   ⚠️ No default endorsements specified for this policy`);
        return [];
    }

    // Normalize to array
    const endorsementIds = Array.isArray(defaultEndorsementIds) ? defaultEndorsementIds : [defaultEndorsementIds];

    // Debug: Log the actual endorsement IDs we're looking for
    console.info(`   🔍 Looking for endorsement IDs: ${JSON.stringify(endorsementIds)}`);
    console.info(`   📚 Total endorsements available: ${allEndorsements.length}`);

    // Filter endorsements that:
    // 1. Have an ID in the default list
    // 2. Are valid for this policy category
    const matchedEndorsements = allEndorsements.filter(endorsement => {
        const endorsementId = endorsement['lvis:EndorsementId'];
        const endorsementName = endorsement['lvis:EndorsementName'] || 'Unknown';

        // Check if this endorsement is in the default list
        if (!endorsementIds.includes(endorsementId)) {
            // Debug: Show why this endorsement was skipped (too verbose, only log first few)
            return false;
        }

        console.info(`   ✓ Found matching endorsement ID: ${endorsementId} - "${endorsementName}"`);

        // Check if this endorsement is valid for this policy category
        const validCategoryIds = endorsement['lvis:ValidPolicyCategoryIds']?.['lvis:string'];
        if (!validCategoryIds) {
            console.info(`   ✗ Endorsement ${endorsementId} has no ValidPolicyCategoryIds`);
            return false;
        }

        const categoryIds = Array.isArray(validCategoryIds) ? validCategoryIds : [validCategoryIds];
        const isValid = categoryIds.includes(policyCategoryId) || categoryIds.includes('-1');

        if (!isValid) {
            console.info(`   ✗ Endorsement ${endorsementId} not valid for category ${policyCategoryId}. Valid categories: ${JSON.stringify(categoryIds)}`);
        } else {
            console.info(`   ✅ Endorsement ${endorsementId} matched and valid for category ${policyCategoryId}`);
        }

        return isValid;
    });

    console.info(`   📊 Matched ${matchedEndorsements.length} endorsements for this policy`);

    return matchedEndorsements;
}

/**
 * Get endorsements for a policy - merges defaults with user-selected endorsements
 * @param {Object} policy - The policy object from ProductList
 * @param {Array} allEndorsements - All available endorsements from ProductList
 * @param {Array} selectedEndorsementIds - User-selected endorsement IDs to add
 * @returns {Array} - Array of endorsement objects for this policy
 */
function getEndorsementsForPolicy(policy, allEndorsements, selectedEndorsementIds = []) {
    // Start with default endorsements
    const defaultEndorsements = getDefaultEndorsementsForPolicy(policy, allEndorsements);

    // If no selected endorsements, just return defaults
    if (!selectedEndorsementIds || selectedEndorsementIds.length === 0) {
        return defaultEndorsements;
    }

    const policyCategoryId = policy['lvis:PolicyCategoryId'];
    const policyName = policy['lvis:PolicyName'] || 'Unknown Policy';

    console.info(`🔧 Adding selected endorsements to "${policyName}"`);
    console.info(`   Selected IDs: ${JSON.stringify(selectedEndorsementIds)}`);

    // Get default IDs to avoid duplicates
    const defaultIds = new Set(defaultEndorsements.map(e => e['lvis:EndorsementId']));

    // Find selected endorsements that aren't already defaults
    const additionalEndorsements = allEndorsements.filter(endorsement => {
        const endorsementId = endorsement['lvis:EndorsementId'];

        // Skip if not in selected list
        if (!selectedEndorsementIds.includes(endorsementId)) {
            return false;
        }

        // Skip if already a default
        if (defaultIds.has(endorsementId)) {
            console.info(`   ⚠️ Endorsement ${endorsementId} is already a default, skipping`);
            return false;
        }

        // Check if valid for this policy category
        const validCategoryIds = endorsement['lvis:ValidPolicyCategoryIds']?.['lvis:string'];
        if (!validCategoryIds) {
            console.info(`   ✗ Selected endorsement ${endorsementId} has no ValidPolicyCategoryIds`);
            return false;
        }

        const categoryIds = Array.isArray(validCategoryIds) ? validCategoryIds : [validCategoryIds];
        const isValid = categoryIds.includes(policyCategoryId) || categoryIds.includes('-1');

        if (!isValid) {
            console.info(`   ✗ Selected endorsement ${endorsementId} not valid for category ${policyCategoryId}`);
            return false;
        }

        const endorsementName = endorsement['lvis:EndorsementName'] || 'Unknown';
        console.info(`   ✅ Added selected endorsement ${endorsementId} - "${endorsementName}"`);
        return true;
    });

    console.info(`   📊 Total: ${defaultEndorsements.length} defaults + ${additionalEndorsements.length} selected`);

    // Merge defaults with selected
    return [...defaultEndorsements, ...additionalEndorsements];
}

/**
 * Build TITLE_ENDORSEMENTS XML block for a policy
 * @param {Array} endorsements - Array of endorsement objects
 * @param {number} policySequence - The sequence number of the parent policy (for labeling)
 * @returns {string} - XML string for TITLE_ENDORSEMENTS block
 */
function buildEndorsementsXML(endorsements, policySequence) {
    if (!endorsements || endorsements.length === 0) {
        console.info(`   ⚠️ No endorsements to build for policy ${policySequence}`);
        return '';
    }

    console.info(`   📝 Building ${endorsements.length} endorsements for policy ${policySequence}:`);

    const endorsementsXML = endorsements.map((endorsement, index) => {
        const endorsementId = endorsement['lvis:EndorsementId'];
        const endorsementName = endorsement['lvis:EndorsementName'];
        const label = `POLICY_${policySequence}_ENDR_${index + 1}`;

        console.info(`      - ${label}: ID=${endorsementId}, Name="${endorsementName}"`);

        return `
        <TITLE_ENDORSEMENT xlink:label="${label}" SequenceNumber="${index + 1}">
          <TitleEndorsementFormIdentifier>${endorsementId}</TitleEndorsementFormIdentifier>
          <TitleEndorsementFormName>${endorsementName}</TitleEndorsementFormName>
        </TITLE_ENDORSEMENT>`;
    }).join('');

    return `<TITLE_ENDORSEMENTS>${endorsementsXML}</TITLE_ENDORSEMENTS>`;
}

module.exports = {
    buildTitleServiceBlock,
    buildSettlementServiceBlock,
    buildRecordingServiceBlock,
    buildTransactionTypesRequestXML,
    parseTransactionTypesResponse,
    buildProductListRequestXML,
    buildRateCalcRequestXML,
    parseProductList,
    getDefaultEndorsementsForPolicy,
    getEndorsementsForPolicy,
    buildEndorsementsXML
};
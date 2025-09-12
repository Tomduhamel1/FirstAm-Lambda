module.exports = {
    // API URLs
    FIRSTAM_BASE_URL: 'https://calculator.lvis.firstam.com',
    PRODUCT_LIST_URL: 'https://calculator.lvis.firstam.com/ProductList',
    RATE_CALC_URL: 'https://calculator.lvis.firstam.com/',
    
    // For official quotes - these endpoints would be added once we have the documentation
    OFFICIAL_QUOTE_START_URL: 'https://calculator.lvis.firstam.com/OfficialQuoteStart',
    OFFICIAL_QUOTE_SUBMIT_URL: 'https://calculator.lvis.firstam.com/OfficialQuoteSubmit',
    
    // Client Configuration
    CLIENT_CUSTOMER_ID: 'FNTE',
    
    // DynamoDB Tables
    TABLES: {
        ZIP_CODES: 'ZipCodes',
        FNTE_FEES: 'FNTEFees',
        QUOTE_SESSIONS: 'QuoteSessions'
    },
    
    // Session Configuration
    SESSION_TTL_HOURS: 24,
    
    // Transaction Types
    TRANSACTION_TYPES: {
        PURCHASE: 'Sale w/ Mortgage',
        CASH_PURCHASE: 'Sale w/ Mortgage',
        REFINANCE: 'Refinance'
    },
    
    // Property Types
    PROPERTY_TYPE: 'Residential',
    
    // Default Values
    DEFAULT_NOTE_AMOUNT: 1000,
    
    // Product Flags
    PRODUCT_FLAGS: {
        IS_TITLE: 'True',
        IS_CLOSING: 'True',
        IS_RECORDING: 'True',
        IS_ENDORSEMENTS: 'True'
    },
    
    // Response Headers
    CORS_HEADERS: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
    }
};
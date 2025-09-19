const { handleQuickQuote } = require('./quick-quote/handler');
const { handleOfficialQuote } = require('./official-quote/handler');
const { handleOfficialQuoteV2 } = require('./official-quote-v2/handler'); // New L2 implementation

/**
 * Main Lambda handler that routes requests to appropriate quote handlers
 * 
 * @param {Object} event - API Gateway Lambda Proxy Integration event
 * @returns {Object} API Gateway Lambda Proxy Integration response
 */
exports.handler = async (event) => {
    console.info('Main handler received event:', JSON.stringify(event, null, 2));
    
    // Parse the HTTP method and path
    const httpMethod = event.httpMethod || event.requestContext?.http?.method || 'POST';
    const path = event.path || event.rawPath || event.pathParameters?.proxy || '/';
    
    console.info(`Processing ${httpMethod} request to ${path}`);
    
    // Handle CORS preflight requests
    if (httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: ''
        };
    }
    
    try {
        // Route based on path or request type
        // Handle API Gateway paths
        if (path === '/fee-calculator/quick-quote' || path === '/' || path === '/quick-quote' || !path.includes('official')) {
            // Check if the request body indicates an official quote
            let requestBody = {};
            try {
                requestBody = JSON.parse(event.body || '{}');
            } catch (e) {
                // If parsing fails, let the handler deal with it
            }

            // If QuoteType is specified, route accordingly
            if (requestBody.QuoteType === 'Official') {
                return await handleOfficialQuote(event);
            }

            // Default to quick quote for backward compatibility
            return await handleQuickQuote(event);
        }

        // Handle official quote V2 paths (with L2 support) - API Gateway or direct
        if (path === '/fee-calculator/official-quote' || path.includes('official-quote-v2')) {
            return await handleOfficialQuoteV2(event);
        }

        // Handle original official quote paths
        if (path.includes('official-quote')) {
            return await handleOfficialQuote(event);
        }
        
        // Unknown path
        return {
            statusCode: 404,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({
                error: 'Not Found',
                message: `Path ${path} not found. Available endpoints: /, /quick-quote, /official-quote, /official-quote-v2`
            })
        };
        
    } catch (error) {
        console.error('Unhandled error in main handler:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({
                error: 'Internal server error',
                message: error.message
            })
        };
    }
};

/**
 * For local testing - uncomment to test directly
 */
// if (require.main === module) {
//     const testEvent = {
//         httpMethod: 'POST',
//         path: '/',
//         body: JSON.stringify({
//             PostalCode: '10001',
//             SalesContractAmount: 500000,
//             NoteAmount: 400000,
//             LoanPurposeType: 'Purchase'
//         })
//     };
//     
//     exports.handler(testEvent).then(response => {
//         console.log('Response:', JSON.stringify(response, null, 2));
//     }).catch(error => {
//         console.error('Error:', error);
//     });
// }
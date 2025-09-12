const { v4: uuidv4 } = require('uuid');
const { handleL1Request } = require('./l1-handler');
const { handleL2Request } = require('./l2-handler');
const { 
    formatQuestionsForWebApp, 
    validateAnswers,
    generateQuestionSummary 
} = require('./question-parser');
const {
    createL2Session,
    getL2Session,
    storeL1ResponseData,
    storeUserAnswers,
    storeFinalRates
} = require('./session-manager');

/**
 * Main handler for official quote V2 with L2 support
 * Completely separate from existing quick quote functionality
 * 
 * @param {Object} event - API Gateway Lambda Proxy Integration event
 * @returns {Object} API Gateway Lambda Proxy Integration response
 */
async function handleOfficialQuoteV2(event) {
    console.info('Official Quote V2 Handler received event');
    
    let requestBody;
    try {
        requestBody = JSON.parse(event.body);
        console.info('Parsed body:', { 
            action: requestBody.action,
            sessionId: requestBody.sessionId,
            PostalCode: requestBody.PostalCode 
        });
    } catch (e) {
        console.error('Error parsing JSON:', e);
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ error: 'Invalid JSON format' }),
        };
    }
    
    // Determine action
    const action = requestBody.action || 'start';
    
    try {
        switch (action) {
            case 'start':
                return await startOfficialQuoteV2(requestBody);
                
            case 'submit':
                return await submitAnswersV2(requestBody);
                
            case 'status':
                return await getQuoteStatusV2(requestBody);
                
            default:
                return {
                    statusCode: 400,
                    headers: getCORSHeaders(),
                    body: JSON.stringify({ 
                        error: 'Invalid action',
                        message: 'Valid actions are: start, submit, status'
                    })
                };
        }
    } catch (error) {
        console.error('Error in official quote V2 handler:', error);
        return {
            statusCode: 500,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'Failed to process official quote',
                details: error.message 
            })
        };
    }
}

/**
 * Start a new official quote V2 session
 */
async function startOfficialQuoteV2(requestBody) {
    const { 
        PostalCode, 
        SalesContractAmount, 
        NoteAmount, 
        LoanPurposeType,
        forceL2Questions = false 
    } = requestBody;
    
    // Validate required fields
    if (!PostalCode) {
        return {
            statusCode: 400,
            headers: getCORSHeaders(),
            body: JSON.stringify({ error: 'PostalCode is required' })
        };
    }
    
    try {
        // Create session
        const sessionData = {
            PostalCode,
            SalesContractAmount,
            NoteAmount,
            LoanPurposeType,
            forceL2Questions,
            requestedAt: new Date().toISOString()
        };
        
        const sessionId = await createL2Session(sessionData);
        
        // Handle L1 request
        const l1Result = await handleL1Request({
            PostalCode,
            SalesContractAmount,
            NoteAmount,
            LoanPurposeType,
            forceL2Questions
        });
        
        // Store L1 response in session
        await storeL1ResponseData(sessionId, l1Result);
        
        // Check if rates are immediately available or L2 questions needed
        if (l1Result.type === 'rates' && l1Result.hasCalculatedRates) {
            // Rates available immediately (no L2 needed)
            await storeFinalRates(sessionId, l1Result);
            
            return {
                statusCode: 200,
                headers: getCORSHeaders(),
                body: JSON.stringify({
                    sessionId,
                    status: 'completed',
                    message: 'Rates calculated successfully',
                    hasCalculatedRates: true,
                    fees: l1Result.fees,
                    loanComments: l1Result.loanComments,
                    locationInfo: l1Result.locationData
                })
            };
        } else {
            // L2 questions required
            const formattedQuestions = formatQuestionsForWebApp(l1Result.questions);
            
            return {
                statusCode: 200,
                headers: getCORSHeaders(),
                body: JSON.stringify({
                    sessionId,
                    status: 'pending_answers',
                    message: 'Additional information required',
                    hasCalculatedRates: false,
                    questions: formattedQuestions,
                    locationInfo: l1Result.locationData,
                    expiresIn: '24 hours'
                })
            };
        }
        
    } catch (error) {
        console.error('Error starting official quote V2:', error);
        return {
            statusCode: 500,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'Failed to start official quote',
                details: error.message 
            })
        };
    }
}

/**
 * Submit answers for L2 questions
 */
async function submitAnswersV2(requestBody) {
    const { sessionId, answers } = requestBody;
    
    // Validate required fields
    if (!sessionId || !answers) {
        return {
            statusCode: 400,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'sessionId and answers are required' 
            })
        };
    }
    
    try {
        // Retrieve session
        const session = await getL2Session(sessionId);
        
        if (!session) {
            return {
                statusCode: 404,
                headers: getCORSHeaders(),
                body: JSON.stringify({ 
                    error: 'Session not found or expired' 
                })
            };
        }
        
        if (session.status === 'completed') {
            return {
                statusCode: 400,
                headers: getCORSHeaders(),
                body: JSON.stringify({ 
                    error: 'This quote has already been completed',
                    fees: session.finalRates?.fees
                })
            };
        }
        
        // Get L1 response data from session
        const l1Response = session.l1Response;
        
        if (!l1Response || !l1Response.calcRateLevel2Data) {
            return {
                statusCode: 400,
                headers: getCORSHeaders(),
                body: JSON.stringify({ 
                    error: 'No L2 questions found for this session' 
                })
            };
        }
        
        // Validate answers
        const formattedQuestions = formatQuestionsForWebApp(l1Response.questions);
        const validationResult = validateAnswers(formattedQuestions, answers);
        
        if (!validationResult.valid) {
            return {
                statusCode: 400,
                headers: getCORSHeaders(),
                body: JSON.stringify({ 
                    error: 'Invalid answers provided',
                    validationErrors: validationResult.errors
                })
            };
        }
        
        // Store answers in session
        await storeUserAnswers(sessionId, answers);
        
        // Handle L2 request with answers
        const l2Result = await handleL2Request({
            calcRateLevel2Data: l1Response.calcRateLevel2Data,
            originalMISMO: l1Response.originalMISMO,
            userAnswers: answers
        });
        
        // Store final rates
        await storeFinalRates(sessionId, l2Result);
        
        // Generate question/answer summary
        const summary = generateQuestionSummary(formattedQuestions, answers);
        
        return {
            statusCode: 200,
            headers: getCORSHeaders(),
            body: JSON.stringify({
                sessionId,
                status: 'completed',
                message: 'Official quote generated successfully',
                fees: l2Result.fees,
                totalBuyerFee: l2Result.totalBuyerFee,
                totalSellerFee: l2Result.totalSellerFee,
                loanCommentText: l2Result.loanCommentText,
                questionSummary: summary,
                completedAt: new Date().toISOString()
            })
        };
        
    } catch (error) {
        console.error('Error submitting answers V2:', error);
        return {
            statusCode: 500,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'Failed to submit answers',
                details: error.message 
            })
        };
    }
}

/**
 * Get the status of an official quote V2 session
 */
async function getQuoteStatusV2(requestBody) {
    const { sessionId } = requestBody;
    
    if (!sessionId) {
        return {
            statusCode: 400,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'sessionId is required' 
            })
        };
    }
    
    try {
        const session = await getL2Session(sessionId);
        
        if (!session) {
            return {
                statusCode: 404,
                headers: getCORSHeaders(),
                body: JSON.stringify({ 
                    error: 'Session not found or expired' 
                })
            };
        }
        
        const response = {
            sessionId,
            status: session.status,
            createdAt: session.createdAt
        };
        
        if (session.status === 'pending_answers' && session.l1Response) {
            const formattedQuestions = formatQuestionsForWebApp(
                session.l1Response.questions || []
            );
            response.questions = formattedQuestions;
            response.expiresAt = new Date(session.ttl * 1000).toISOString();
        } else if (session.status === 'completed' && session.finalRates) {
            response.fees = session.finalRates.fees;
            response.totalBuyerFee = session.finalRates.totalBuyerFee;
            response.totalSellerFee = session.finalRates.totalSellerFee;
            response.completedAt = session.completedAt;
        }
        
        return {
            statusCode: 200,
            headers: getCORSHeaders(),
            body: JSON.stringify(response)
        };
        
    } catch (error) {
        console.error('Error getting quote status V2:', error);
        return {
            statusCode: 500,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'Failed to get quote status',
                details: error.message 
            })
        };
    }
}

/**
 * Get CORS headers
 */
function getCORSHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
    };
}

module.exports = {
    handleOfficialQuoteV2
};
const { v4: uuidv4 } = require('uuid');
const { getQuestions } = require('./questions');
const { submitOfficialQuote } = require('./submission');
const { saveQuoteSession, getQuoteSession, updateQuoteSession } = require('../shared/database');
const constants = require('../shared/constants');

/**
 * Main handler for official quote requests
 * Manages the multi-step process of official quotes:
 * 1. Start: Initialize quote and get location-specific questions
 * 2. Submit: Process answers and generate final quote
 * 
 * @param {Object} event - API Gateway Lambda Proxy Integration event
 * @returns {Object} API Gateway Lambda Proxy Integration response
 */
async function handleOfficialQuote(event) {
    console.info('Official Quote Handler received event:', JSON.stringify(event, null, 2));
    
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
    
    // Determine the action based on the request
    const action = requestBody.action || determineAction(event.path);
    
    try {
        switch (action) {
            case 'start':
                return await startOfficialQuote(requestBody);
            case 'submit':
                return await submitQuoteWithAnswers(requestBody);
            case 'status':
                return await getQuoteStatus(requestBody);
            default:
                return {
                    statusCode: 400,
                    headers: constants.CORS_HEADERS,
                    body: JSON.stringify({ 
                        error: 'Invalid action',
                        message: 'Valid actions are: start, submit, status'
                    })
                };
        }
    } catch (error) {
        console.error('Error in official quote handler:', error);
        return {
            statusCode: 500,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({ 
                error: 'Failed to process official quote',
                details: error.message 
            })
        };
    }
}

/**
 * Start an official quote session
 * Gets location-specific questions from FirstAm API
 */
async function startOfficialQuote(requestBody) {
    const { PostalCode, SalesContractAmount, NoteAmount, LoanPurposeType } = requestBody;
    
    // Validate required fields
    if (!PostalCode) {
        return {
            statusCode: 400,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({ error: 'PostalCode is required' })
        };
    }
    
    try {
        // Generate a unique session ID
        const sessionId = uuidv4();
        
        // Get location-specific questions from FirstAm
        const questionsResponse = await getQuestions({
            PostalCode,
            SalesContractAmount,
            NoteAmount,
            LoanPurposeType
        });
        
        // Save session data
        await saveQuoteSession(sessionId, {
            PostalCode,
            SalesContractAmount,
            NoteAmount,
            LoanPurposeType,
            questions: questionsResponse.questions,
            locationData: questionsResponse.locationData,
            status: 'pending_answers'
        });
        
        return {
            statusCode: 200,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({
                sessionId,
                message: 'Official quote started successfully',
                questions: questionsResponse.questions,
                locationInfo: {
                    city: questionsResponse.locationData.city,
                    county: questionsResponse.locationData.county,
                    state: questionsResponse.locationData.state
                },
                expiresIn: '24 hours'
            })
        };
    } catch (error) {
        console.error('Error starting official quote:', error);
        throw error;
    }
}

/**
 * Submit answers and generate final official quote
 */
async function submitQuoteWithAnswers(requestBody) {
    const { sessionId, answers } = requestBody;
    
    // Validate required fields
    if (!sessionId || !answers) {
        return {
            statusCode: 400,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({ 
                error: 'sessionId and answers are required' 
            })
        };
    }
    
    try {
        // Retrieve session data
        const session = await getQuoteSession(sessionId);
        
        if (!session) {
            return {
                statusCode: 404,
                headers: constants.CORS_HEADERS,
                body: JSON.stringify({ 
                    error: 'Session not found or expired' 
                })
            };
        }
        
        if (session.status === 'completed') {
            return {
                statusCode: 400,
                headers: constants.CORS_HEADERS,
                body: JSON.stringify({ 
                    error: 'This quote has already been completed',
                    quoteId: session.quoteId
                })
            };
        }
        
        // Validate answers against questions
        const validationResult = validateAnswers(session.questions, answers);
        if (!validationResult.valid) {
            return {
                statusCode: 400,
                headers: constants.CORS_HEADERS,
                body: JSON.stringify({ 
                    error: 'Invalid answers provided',
                    validationErrors: validationResult.errors
                })
            };
        }
        
        // Submit official quote with answers
        const quoteResult = await submitOfficialQuote({
            ...session,
            answers
        });
        
        // Update session with final quote data
        await updateQuoteSession(sessionId, {
            status: 'completed',
            quoteId: quoteResult.quoteId,
            finalQuote: quoteResult.fees,
            completedAt: new Date().toISOString()
        });
        
        return {
            statusCode: 200,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({
                message: 'Official quote generated successfully',
                sessionId,
                quoteId: quoteResult.quoteId,
                fees: quoteResult.fees,
                totalBuyerFee: quoteResult.totalBuyerFee,
                totalSellerFee: quoteResult.totalSellerFee,
                notes: quoteResult.notes
            })
        };
    } catch (error) {
        console.error('Error submitting official quote:', error);
        
        // Update session status to error
        try {
            await updateQuoteSession(sessionId, {
                status: 'error',
                errorMessage: error.message
            });
        } catch (updateError) {
            console.error('Failed to update session status:', updateError);
        }
        
        throw error;
    }
}

/**
 * Get the status of an official quote session
 */
async function getQuoteStatus(requestBody) {
    const { sessionId } = requestBody;
    
    if (!sessionId) {
        return {
            statusCode: 400,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify({ 
                error: 'sessionId is required' 
            })
        };
    }
    
    try {
        const session = await getQuoteSession(sessionId);
        
        if (!session) {
            return {
                statusCode: 404,
                headers: constants.CORS_HEADERS,
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
        
        if (session.status === 'pending_answers') {
            response.questions = session.questions;
            response.expiresAt = new Date(session.ttl * 1000).toISOString();
        } else if (session.status === 'completed') {
            response.quoteId = session.quoteId;
            response.completedAt = session.completedAt;
        } else if (session.status === 'error') {
            response.errorMessage = session.errorMessage;
        }
        
        return {
            statusCode: 200,
            headers: constants.CORS_HEADERS,
            body: JSON.stringify(response)
        };
    } catch (error) {
        console.error('Error getting quote status:', error);
        throw error;
    }
}

/**
 * Determine action from path
 */
function determineAction(path) {
    if (!path) return null;
    
    if (path.includes('start')) return 'start';
    if (path.includes('submit')) return 'submit';
    if (path.includes('status')) return 'status';
    
    return null;
}

/**
 * Validate answers against questions
 */
function validateAnswers(questions, answers) {
    const errors = [];
    
    for (const question of questions) {
        const answer = answers[question.id];
        
        // Check if required question has an answer
        if (question.required && !answer) {
            errors.push({
                questionId: question.id,
                error: 'This question is required'
            });
            continue;
        }
        
        // Validate answer type
        if (answer) {
            switch (question.type) {
                case 'select':
                    if (!question.options.includes(answer)) {
                        errors.push({
                            questionId: question.id,
                            error: `Invalid option. Must be one of: ${question.options.join(', ')}`
                        });
                    }
                    break;
                    
                case 'number':
                    if (isNaN(Number(answer))) {
                        errors.push({
                            questionId: question.id,
                            error: 'Must be a valid number'
                        });
                    } else if (question.min !== undefined && Number(answer) < question.min) {
                        errors.push({
                            questionId: question.id,
                            error: `Must be at least ${question.min}`
                        });
                    } else if (question.max !== undefined && Number(answer) > question.max) {
                        errors.push({
                            questionId: question.id,
                            error: `Must be at most ${question.max}`
                        });
                    }
                    break;
                    
                case 'boolean':
                    if (typeof answer !== 'boolean' && answer !== 'true' && answer !== 'false') {
                        errors.push({
                            questionId: question.id,
                            error: 'Must be true or false'
                        });
                    }
                    break;
                    
                case 'date':
                    if (isNaN(Date.parse(answer))) {
                        errors.push({
                            questionId: question.id,
                            error: 'Must be a valid date'
                        });
                    }
                    break;
            }
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    handleOfficialQuote
};
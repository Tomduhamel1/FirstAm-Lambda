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
    storeFinalRates,
    storePageNumbers
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
                
            case 'updatePages':
                return await updatePagesV2(requestBody);
                
            case 'status':
                return await getQuoteStatusV2(requestBody);
                
            default:
                return {
                    statusCode: 400,
                    headers: getCORSHeaders(),
                    body: JSON.stringify({ 
                        error: 'Invalid action',
                        message: 'Valid actions are: start, updatePages, submit, status'
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
            // L2 questions required - but first need page numbers
            const formattedQuestions = formatQuestionsForWebApp(l1Result.questions);
            
            // Add page number and consideration amount questions as a separate step
            const pageQuestions = [
                {
                    id: 'deedPages',
                    question: 'Number of pages in the deed document',
                    description: 'Enter the total number of pages in the conveyance deed',
                    paramCode: 'deedPages',
                    paramName: 'Deed Page Count',
                    required: true,
                    defaultAnswer: '3',
                    type: 'number',
                    min: 1,
                    max: 100,
                    step: 1,
                    helpText: 'Standard deeds are typically 3-5 pages'
                },
                {
                    id: 'mortgagePages',
                    question: 'Number of pages in the mortgage document',
                    description: 'Enter the total number of pages in the mortgage/deed of trust',
                    paramCode: 'mortgagePages',
                    paramName: 'Mortgage Page Count',
                    required: true,
                    defaultAnswer: '15',
                    type: 'number',
                    min: 1,
                    max: 200,
                    step: 1,
                    helpText: 'Standard mortgages are typically 15-30 pages'
                },
                {
                    id: 'deedConsideration',
                    question: 'Consideration amount for deed',
                    description: 'Enter the consideration amount for the conveyance deed',
                    paramCode: 'deedConsideration',
                    paramName: 'Deed Consideration Amount',
                    required: true,
                    defaultAnswer: String(SalesContractAmount || 500000),
                    type: 'number',
                    min: 0,
                    step: 1,
                    helpText: 'Typically the sales/purchase price'
                },
                {
                    id: 'mortgageConsideration',
                    question: 'Consideration amount for mortgage',
                    description: 'Enter the consideration amount for the mortgage/deed of trust',
                    paramCode: 'mortgageConsideration',
                    paramName: 'Mortgage Consideration Amount',
                    required: true,
                    defaultAnswer: String(NoteAmount || 400000),
                    type: 'number',
                    min: 0,
                    step: 1,
                    helpText: 'Typically the loan amount'
                }
            ];
            
            return {
                statusCode: 200,
                headers: getCORSHeaders(),
                body: JSON.stringify({
                    sessionId,
                    status: 'pending_page_numbers',
                    message: 'Page numbers required before proceeding',
                    requiresPageNumbers: true,
                    pageQuestions,
                    locationInfo: l1Result.locationData,
                    expiresIn: '24 hours',
                    nextStep: 'Use updatePages action with page numbers to continue'
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
 * Update page numbers for recording documents
 */
async function updatePagesV2(requestBody) {
    const { sessionId, pageNumbers } = requestBody;
    
    // Validate required fields
    if (!sessionId || !pageNumbers) {
        return {
            statusCode: 400,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'sessionId and pageNumbers are required' 
            })
        };
    }
    
    // Validate page numbers and consideration amounts
    if (!pageNumbers.deedPages || !pageNumbers.mortgagePages) {
        return {
            statusCode: 400,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'Both deedPages and mortgagePages are required',
                details: 'Provide numeric values for both deed and mortgage page counts'
            })
        };
    }
    
    const deedPages = parseInt(pageNumbers.deedPages);
    const mortgagePages = parseInt(pageNumbers.mortgagePages);
    const deedConsideration = pageNumbers.deedConsideration ? parseInt(pageNumbers.deedConsideration) : null;
    const mortgageConsideration = pageNumbers.mortgageConsideration ? parseInt(pageNumbers.mortgageConsideration) : null;
    
    if (isNaN(deedPages) || deedPages < 1 || isNaN(mortgagePages) || mortgagePages < 1) {
        return {
            statusCode: 400,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'Invalid page numbers',
                details: 'Page numbers must be positive integers'
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
                    error: 'This quote has already been completed'
                })
            };
        }
        
        // Store page numbers and consideration amounts in session
        const { storePageNumbers } = require('./session-manager');
        await storePageNumbers(sessionId, { 
            deedPages, 
            mortgagePages,
            deedConsideration,
            mortgageConsideration
        });
        
        // Re-run L1 with updated page numbers and consideration amounts
        const l1Result = await handleL1Request({
            PostalCode: session.PostalCode,
            SalesContractAmount: deedConsideration || session.SalesContractAmount,
            NoteAmount: mortgageConsideration || session.NoteAmount,
            LoanPurposeType: session.LoanPurposeType,
            forceL2Questions: session.forceL2Questions || true,
            pageNumbers: { deedPages, mortgagePages }
        });
        
        // Store updated L1 response
        await storeL1ResponseData(sessionId, l1Result);
        
        // Return updated L2 questions
        const formattedQuestions = formatQuestionsForWebApp(l1Result.questions);
        
        return {
            statusCode: 200,
            headers: getCORSHeaders(),
            body: JSON.stringify({
                sessionId,
                status: 'pending_answers',
                message: 'Page numbers updated, please answer the following questions',
                questions: formattedQuestions,
                pageNumbers: { 
                    deedPages, 
                    mortgagePages,
                    deedConsideration,
                    mortgageConsideration
                },
                locationInfo: l1Result.locationData
            })
        };
        
    } catch (error) {
        console.error('Error updating page numbers:', error);
        return {
            statusCode: 500,
            headers: getCORSHeaders(),
            body: JSON.stringify({ 
                error: 'Failed to update page numbers',
                details: error.message 
            })
        };
    }
}

/**
 * Submit answers for L2 questions
 */
async function submitAnswersV2(requestBody) {
    const { sessionId, answers: originalAnswers } = requestBody;
    let answers = originalAnswers;
    
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
        let l1Response = session.l1Response;
        
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
        
        // Extract page numbers from answers if they exist
        let pageNumbers = session.pageNumbers; // Use stored page numbers as default
        let needsL1Refresh = false;

        // Check if answers contain page-related fields and extract them
        if (answers.deedPages || answers.mortgagePages) {
            pageNumbers = {
                deedPages: answers.deedPages ? parseInt(answers.deedPages) : 3,
                mortgagePages: answers.mortgagePages ? parseInt(answers.mortgagePages) : 15,
                deedConsideration: answers.deedConsideration ? parseInt(answers.deedConsideration) : null,
                mortgageConsideration: answers.mortgageConsideration ? parseInt(answers.mortgageConsideration) : null
            };

            console.info('Extracted page numbers from answers:', pageNumbers);

            // Store page numbers in session for future reference
            await storePageNumbers(sessionId, pageNumbers);

            // Remove page-related fields from answers to avoid confusion with L2 questions
            const l2Answers = { ...answers };
            delete l2Answers.deedPages;
            delete l2Answers.mortgagePages;
            delete l2Answers.deedConsideration;
            delete l2Answers.mortgageConsideration;

            // Store L2 answers
            await storeUserAnswers(sessionId, l2Answers);

            // Use cleaned answers for L2
            answers = l2Answers;

            // We need to re-run L1 with the page numbers to get correct recording fees
            needsL1Refresh = true;
        } else {
            // Store answers in session as-is
            await storeUserAnswers(sessionId, answers);
        }

        // If we have new page numbers, re-run L1 to get updated MISMO with correct recording fees
        if (needsL1Refresh && pageNumbers) {
            console.info('Re-running L1 request with page numbers to update recording fees');

            // Re-run L1 with page numbers
            const updatedL1Result = await handleL1Request({
                PostalCode: session.PostalCode,
                SalesContractAmount: session.SalesContractAmount,
                NoteAmount: session.NoteAmount,
                LoanPurposeType: session.LoanPurposeType,
                forceL2Questions: session.forceL2Questions || true,
                pageNumbers: pageNumbers  // Pass the page numbers to L1
            });

            // Update the L1 response data in session
            await storeL1ResponseData(sessionId, updatedL1Result);

            // Use the updated L1 response
            l1Response = updatedL1Result;
        }

        // Handle L2 request with answers
        const l2Result = await handleL2Request({
            calcRateLevel2Data: l1Response.calcRateLevel2Data,
            originalMISMO: l1Response.originalMISMO,
            userAnswers: answers,
            pageNumbers: pageNumbers // Pass the page numbers (though L2 doesn't use them directly)
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
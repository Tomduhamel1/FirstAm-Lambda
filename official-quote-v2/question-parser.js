/**
 * Parse and format L2 questions for web app consumption
 * Converts FirstAm's XML question format to a more user-friendly JSON format
 */

/**
 * Format L2 questions for web app display
 * @param {Array} rawQuestions - Parsed questions from L1 response
 * @returns {Array} Formatted questions for web app
 */
function formatQuestionsForWebApp(rawQuestions) {
    if (!rawQuestions || !Array.isArray(rawQuestions)) {
        return [];
    }
    
    return rawQuestions.map(q => {
        const formattedQuestion = {
            id: q.linkKey,
            question: q.questionText,
            description: q.description || '',
            paramCode: q.paramCode,
            paramName: q.paramName,
            required: true, // L2 questions are typically required
            defaultAnswer: q.defaultAnswer
        };
        
        // Determine question type based on available data
        if (q.options && q.options.length > 0) {
            // Multiple choice question
            formattedQuestion.type = 'select';
            formattedQuestion.options = q.options;
        } else if (q.valueType) {
            // Map FirstAm value types to web form types
            switch (q.valueType.toUpperCase()) {
                case 'CURRENCY':
                    formattedQuestion.type = 'currency';
                    formattedQuestion.min = 0;
                    break;
                case 'INTEGER':
                    formattedQuestion.type = 'number';
                    formattedQuestion.step = 1;
                    break;
                case 'STRING':
                    formattedQuestion.type = 'text';
                    break;
                default:
                    formattedQuestion.type = 'text';
            }
        } else {
            // Default to text input
            formattedQuestion.type = 'text';
        }
        
        // Add helper text for specific question patterns
        formattedQuestion.helpText = generateHelpText(q);
        
        return formattedQuestion;
    });
}

/**
 * Generate help text based on question content
 */
function generateHelpText(question) {
    const questionLower = (question.questionText || '').toLowerCase();
    const paramNameLower = (question.paramName || '').toLowerCase();
    
    // Property-related questions
    if (questionLower.includes('vacant land')) {
        return 'Indicate if the property is currently vacant land without structures';
    }
    
    if (questionLower.includes('home improvement')) {
        return 'Improvements may affect title insurance requirements';
    }
    
    if (questionLower.includes('construction')) {
        return 'New construction may have different fee structures';
    }
    
    // Fee-related questions
    if (paramNameLower.includes('escrow fee')) {
        return 'Additional escrow services may be required';
    }
    
    if (paramNameLower.includes('lien waiver')) {
        return 'Required if recent improvements were made to the property';
    }
    
    // Default help text
    if (question.description) {
        return question.description;
    }
    
    return 'Please provide the requested information for accurate quote calculation';
}

/**
 * Validate user answers against question requirements
 * @param {Array} questions - Formatted questions
 * @param {Object} answers - User-provided answers (key-value pairs)
 * @returns {Object} Validation result with any errors
 */
function validateAnswers(questions, answers) {
    const errors = [];
    
    questions.forEach(question => {
        const answer = answers[question.id];
        
        // Check if required question has an answer
        if (question.required && !answer && answer !== 0) {
            errors.push({
                questionId: question.id,
                error: 'This question is required'
            });
            return;
        }
        
        // Validate based on question type
        if (answer !== undefined && answer !== null) {
            switch (question.type) {
                case 'select':
                    // Check if answer is one of the valid options
                    const validValues = question.options.map(opt => opt.value);
                    if (!validValues.includes(String(answer))) {
                        errors.push({
                            questionId: question.id,
                            error: `Invalid option. Must be one of: ${validValues.join(', ')}`
                        });
                    }
                    break;
                    
                case 'number':
                case 'currency':
                    if (isNaN(Number(answer))) {
                        errors.push({
                            questionId: question.id,
                            error: 'Must be a valid number'
                        });
                    } else {
                        const numValue = Number(answer);
                        if (question.min !== undefined && numValue < question.min) {
                            errors.push({
                                questionId: question.id,
                                error: `Must be at least ${question.min}`
                            });
                        }
                        if (question.max !== undefined && numValue > question.max) {
                            errors.push({
                                questionId: question.id,
                                error: `Must be at most ${question.max}`
                            });
                        }
                    }
                    break;
                    
                case 'text':
                    // Text validation if needed
                    if (question.maxLength && answer.length > question.maxLength) {
                        errors.push({
                            questionId: question.id,
                            error: `Must be ${question.maxLength} characters or less`
                        });
                    }
                    break;
            }
        }
    });
    
    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Map user answers to FirstAm format for L2 request
 * @param {Object} calcRateLevel2Data - Original L2 data from L1 response
 * @param {Object} userAnswers - User-provided answers
 * @returns {Object} Updated CalcRateLevel2Data with user answers
 */
function mapAnswersToL2Format(calcRateLevel2Data, userAnswers) {
    if (!calcRateLevel2Data) return null;
    
    // Deep clone the original data
    const updatedData = JSON.parse(JSON.stringify(calcRateLevel2Data));
    
    // Update answers in RateCalcQandA elements
    const qandaArray = updatedData['lvis:RateCalcRequest']?.['lvis:QandAs']?.['lvis:RateCalcQandA'];
    
    if (qandaArray) {
        const questions = Array.isArray(qandaArray) ? qandaArray : [qandaArray];
        
        questions.forEach(qa => {
            const linkKey = qa['lvis:LinkKey'];
            const userAnswer = userAnswers[linkKey];
            
            // Only update if user provided an answer and IsPrompt is true
            if (userAnswer !== undefined && qa['lvis:IsPrompt'] === 'true') {
                // Update the answer
                qa['lvis:Answers'] = {
                    'lvis:string': String(userAnswer)
                };
                
                // Also update the Param value if it exists
                if (qa['lvis:Param']) {
                    qa['lvis:Param']['lvis:Value'] = String(userAnswer);
                }
            }
        });
    }
    
    return updatedData;
}

/**
 * Extract question categories for grouping in UI
 * @param {Array} questions - Formatted questions
 * @returns {Object} Questions grouped by category
 */
function groupQuestionsByCategory(questions) {
    const groups = {
        property: [],
        construction: [],
        fees: [],
        other: []
    };
    
    questions.forEach(q => {
        const linkKey = q.id.toLowerCase();
        const questionText = q.question.toLowerCase();
        const paramName = (q.paramName || '').toLowerCase();
        
        if (linkKey.startsWith('p') || questionText.includes('property') || questionText.includes('vacant')) {
            groups.property.push(q);
        } else if (questionText.includes('construction') || questionText.includes('improvement')) {
            groups.construction.push(q);
        } else if (paramName.includes('fee') || paramName.includes('escrow')) {
            groups.fees.push(q);
        } else {
            groups.other.push(q);
        }
    });
    
    return groups;
}

/**
 * Generate a summary of questions and answers for display
 * @param {Array} questions - Formatted questions
 * @param {Object} answers - User answers
 * @returns {Array} Summary items
 */
function generateQuestionSummary(questions, answers) {
    return questions.map(q => {
        const answer = answers[q.id];
        let displayAnswer = answer;
        
        // Format answer for display
        if (q.type === 'select' && q.options) {
            const option = q.options.find(opt => opt.value === String(answer));
            displayAnswer = option ? option.label : answer;
        } else if (q.type === 'currency' && answer) {
            displayAnswer = `$${Number(answer).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
        
        return {
            question: q.question,
            answer: displayAnswer || q.defaultAnswer || 'Not answered',
            wasDefaultUsed: !answer && q.defaultAnswer
        };
    });
}

module.exports = {
    formatQuestionsForWebApp,
    validateAnswers,
    mapAnswersToL2Format,
    groupQuestionsByCategory,
    generateQuestionSummary
};
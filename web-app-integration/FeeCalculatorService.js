/**
 * FirstAm Fee Calculator Service
 * Integration module for web applications
 *
 * Usage:
 * import FeeCalculatorService from './FeeCalculatorService';
 * const calculator = new FeeCalculatorService('https://dsk3ez6i5c.execute-api.us-east-1.amazonaws.com/prod');
 */

class FeeCalculatorService {
    constructor(apiBaseUrl) {
        this.apiBaseUrl = apiBaseUrl;
        this.currentSession = null;
    }

    /**
     * Get a quick quote without L2 questions
     * @param {Object} data - Transaction data
     * @returns {Promise<Object>} Fee breakdown
     */
    async getQuickQuote(data) {
        const response = await fetch(`${this.apiBaseUrl}/fee-calculator/quick-quote`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                PostalCode: data.zipCode,
                SalesContractAmount: data.purchasePrice,
                NoteAmount: data.loanAmount,
                LoanPurposeType: data.transactionType || 'Purchase'
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        return this.parseFees(result);
    }

    /**
     * Start an official quote with L2 questions
     * @param {Object} data - Transaction data
     * @param {Boolean} forceL2 - Force L2 questions even for states that don't require them
     * @returns {Promise<Object>} Initial response with session and questions
     */
    async startOfficialQuote(data, forceL2 = false) {
        const response = await fetch(`${this.apiBaseUrl}/fee-calculator/official-quote`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: 'start',
                PostalCode: data.zipCode,
                SalesContractAmount: data.purchasePrice,
                NoteAmount: data.loanAmount,
                LoanPurposeType: data.transactionType || 'Purchase',
                forceL2Questions: forceL2
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        this.currentSession = result.sessionId;

        return {
            sessionId: result.sessionId,
            needsManualInput: result.needsManualInput || false,
            pageQuestions: result.pageQuestions || [],
            l2Questions: result.l2Questions || [],
            fees: result.fees ? this.parseFees(result) : null
        };
    }

    /**
     * Submit answers for page numbers or L2 questions
     * @param {String} sessionId - Session ID from start response
     * @param {Object} answers - Answers object
     * @returns {Promise<Object>} Response with fees or additional questions
     */
    async submitAnswers(sessionId, answers) {
        const response = await fetch(`${this.apiBaseUrl}/fee-calculator/official-quote`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: 'submit',
                sessionId: sessionId,
                answers: answers
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();

        return {
            sessionId: sessionId,
            l2Questions: result.l2Questions || [],
            fees: result.fees ? this.parseFees(result) : null,
            complete: !result.l2Questions || result.l2Questions.length === 0
        };
    }

    /**
     * Complete flow for getting fees with all questions answered
     * @param {Object} data - Transaction data
     * @param {Function} onPageQuestions - Callback to handle page questions
     * @param {Function} onL2Questions - Callback to handle L2 questions
     * @returns {Promise<Object>} Final fees
     */
    async getFeesWithQuestions(data, onPageQuestions, onL2Questions) {
        // Start the quote
        const initialResponse = await this.startOfficialQuote(data, true);

        let currentResponse = initialResponse;

        // Handle page number questions if needed
        if (currentResponse.needsManualInput && currentResponse.pageQuestions.length > 0) {
            const pageAnswers = await onPageQuestions(currentResponse.pageQuestions);
            currentResponse = await this.submitAnswers(
                currentResponse.sessionId,
                pageAnswers
            );
        }

        // Handle L2 questions if present
        if (currentResponse.l2Questions && currentResponse.l2Questions.length > 0) {
            const l2Answers = await onL2Questions(currentResponse.l2Questions);
            currentResponse = await this.submitAnswers(
                currentResponse.sessionId,
                l2Answers
            );
        }

        // Return final fees
        return currentResponse.fees;
    }

    /**
     * Parse fee response into structured format
     * @param {Object} response - API response
     * @returns {Object} Structured fees
     */
    parseFees(response) {
        if (response.fees) {
            return response.fees;
        }

        // Parse from raw response if needed
        const fees = {
            title: {
                ownersPolicy: 0,
                lendersPolicy: 0,
                endorsements: 0,
                total: 0
            },
            settlement: {
                settlementFee: 0,
                abstractFee: 0,
                total: 0
            },
            recording: {
                deed: 0,
                mortgage: 0,
                total: 0
            },
            taxes: {
                transferTax: 0,
                recordingTax: 0,
                total: 0
            },
            grandTotal: 0
        };

        // Extract fees from response
        if (response.OwnersPolicyAmount) fees.title.ownersPolicy = parseFloat(response.OwnersPolicyAmount);
        if (response.LendersPolicyAmount) fees.title.lendersPolicy = parseFloat(response.LendersPolicyAmount);
        if (response.SettlementFee) fees.settlement.settlementFee = parseFloat(response.SettlementFee);
        if (response.RecordingFees) fees.recording.total = parseFloat(response.RecordingFees);
        if (response.TotalFees) fees.grandTotal = parseFloat(response.TotalFees);

        // Calculate totals
        fees.title.total = fees.title.ownersPolicy + fees.title.lendersPolicy + fees.title.endorsements;
        fees.settlement.total = fees.settlement.settlementFee + fees.settlement.abstractFee;

        return fees;
    }

    /**
     * Populate file with calculated fees
     * @param {Object} fileData - Your file data object
     * @param {Object} transactionData - Transaction details
     * @returns {Promise<Object>} Updated file data with fees
     */
    async populateFileWithFees(fileData, transactionData) {
        try {
            // Try quick quote first for simple cases
            if (!transactionData.requiresL2) {
                const fees = await this.getQuickQuote(transactionData);
                return this.mergeFeesIntoFile(fileData, fees);
            }

            // Use full flow with questions for complex cases
            const fees = await this.getFeesWithQuestions(
                transactionData,
                // Page questions handler
                async (questions) => {
                    console.log('Page questions:', questions);
                    // In a real app, show UI dialog here
                    // Return mock answers for now
                    const answers = {};
                    questions.forEach(q => {
                        answers[q.id] = prompt(q.question, q.defaultAnswer);
                    });
                    return answers;
                },
                // L2 questions handler
                async (questions) => {
                    console.log('L2 questions:', questions);
                    // In a real app, show UI dialog here
                    // Return mock answers for now
                    const answers = {};
                    questions.forEach(q => {
                        answers[q.paramCode] = prompt(q.question, q.defaultAnswer);
                    });
                    return answers;
                }
            );

            return this.mergeFeesIntoFile(fileData, fees);

        } catch (error) {
            console.error('Error calculating fees:', error);
            throw error;
        }
    }

    /**
     * Merge calculated fees into file data structure
     * @param {Object} fileData - Original file data
     * @param {Object} fees - Calculated fees
     * @returns {Object} Updated file data
     */
    mergeFeesIntoFile(fileData, fees) {
        // Map fees to your file structure
        // Adjust these mappings based on your actual file format
        return {
            ...fileData,
            fees: {
                ...fileData.fees,
                title: fees.title,
                settlement: fees.settlement,
                recording: fees.recording,
                taxes: fees.taxes,
                total: fees.grandTotal,
                calculatedAt: new Date().toISOString(),
                source: 'FirstAm'
            }
        };
    }
}

export default FeeCalculatorService;
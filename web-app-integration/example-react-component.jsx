/**
 * Example React Component for Fee Calculator Integration
 * Shows how to integrate the fee calculator into a React app
 */

import React, { useState, useCallback } from 'react';
import FeeCalculatorService from './FeeCalculatorService';

// Initialize the service with your API URL
const calculator = new FeeCalculatorService('https://dsk3ez6i5c.execute-api.us-east-1.amazonaws.com/prod');

const FeeCalculatorComponent = ({ fileData, onFeesCalculated }) => {
    const [loading, setLoading] = useState(false);
    const [fees, setFees] = useState(null);
    const [pageQuestions, setPageQuestions] = useState(null);
    const [l2Questions, setL2Questions] = useState(null);
    const [sessionId, setSessionId] = useState(null);
    const [error, setError] = useState(null);

    // Start the fee calculation process
    const calculateFees = async () => {
        setLoading(true);
        setError(null);

        try {
            const transactionData = {
                zipCode: fileData.propertyZipCode,
                purchasePrice: fileData.purchasePrice,
                loanAmount: fileData.loanAmount,
                transactionType: fileData.transactionType || 'Purchase'
            };

            // Start the official quote process
            const response = await calculator.startOfficialQuote(transactionData, true);

            if (response.fees && !response.needsManualInput) {
                // No questions needed, we have the fees
                setFees(response.fees);
                onFeesCalculated(response.fees);
            } else if (response.pageQuestions && response.pageQuestions.length > 0) {
                // Need to collect page numbers
                setSessionId(response.sessionId);
                setPageQuestions(response.pageQuestions);
            } else if (response.l2Questions && response.l2Questions.length > 0) {
                // Need to answer L2 questions
                setSessionId(response.sessionId);
                setL2Questions(response.l2Questions);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    // Handle page number submission
    const submitPageAnswers = async (answers) => {
        setLoading(true);
        setError(null);

        try {
            const response = await calculator.submitAnswers(sessionId, answers);

            setPageQuestions(null);

            if (response.l2Questions && response.l2Questions.length > 0) {
                // Now need to answer L2 questions
                setL2Questions(response.l2Questions);
            } else if (response.fees) {
                // Got the fees
                setFees(response.fees);
                onFeesCalculated(response.fees);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    // Handle L2 questions submission
    const submitL2Answers = async (answers) => {
        setLoading(true);
        setError(null);

        try {
            const response = await calculator.submitAnswers(sessionId, answers);

            setL2Questions(null);

            if (response.fees) {
                setFees(response.fees);
                onFeesCalculated(response.fees);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fee-calculator">
            <h2>Title & Settlement Fee Calculator</h2>

            {!fees && !pageQuestions && !l2Questions && (
                <div className="calculator-start">
                    <div className="transaction-summary">
                        <h3>Transaction Details</h3>
                        <p>Property ZIP: {fileData.propertyZipCode}</p>
                        <p>Purchase Price: ${fileData.purchasePrice?.toLocaleString()}</p>
                        <p>Loan Amount: ${fileData.loanAmount?.toLocaleString()}</p>
                        <p>Transaction Type: {fileData.transactionType || 'Purchase'}</p>
                    </div>

                    <button
                        onClick={calculateFees}
                        disabled={loading}
                        className="calculate-btn"
                    >
                        {loading ? 'Calculating...' : 'Calculate Fees'}
                    </button>
                </div>
            )}

            {pageQuestions && (
                <PageQuestionsDialog
                    questions={pageQuestions}
                    onSubmit={submitPageAnswers}
                    loading={loading}
                />
            )}

            {l2Questions && (
                <L2QuestionsDialog
                    questions={l2Questions}
                    onSubmit={submitL2Answers}
                    loading={loading}
                />
            )}

            {fees && (
                <FeeDisplay fees={fees} />
            )}

            {error && (
                <div className="error-message">
                    Error: {error}
                </div>
            )}
        </div>
    );
};

// Component for page number questions
const PageQuestionsDialog = ({ questions, onSubmit, loading }) => {
    const [answers, setAnswers] = useState(() => {
        const initial = {};
        questions.forEach(q => {
            initial[q.id] = q.defaultAnswer || '';
        });
        return initial;
    });

    const handleSubmit = (e) => {
        e.preventDefault();
        onSubmit(answers);
    };

    const updateAnswer = (id, value) => {
        setAnswers(prev => ({ ...prev, [id]: value }));
    };

    return (
        <div className="questions-dialog">
            <h3>Document Information Required</h3>
            <form onSubmit={handleSubmit}>
                {questions.map(question => (
                    <div key={question.id} className="question-field">
                        <label htmlFor={question.id}>
                            {question.question}
                        </label>
                        <input
                            type="text"
                            id={question.id}
                            value={answers[question.id]}
                            onChange={(e) => updateAnswer(question.id, e.target.value)}
                            required
                        />
                    </div>
                ))}
                <button type="submit" disabled={loading}>
                    {loading ? 'Submitting...' : 'Continue'}
                </button>
            </form>
        </div>
    );
};

// Component for L2 questions
const L2QuestionsDialog = ({ questions, onSubmit, loading }) => {
    const [answers, setAnswers] = useState(() => {
        const initial = {};
        questions.forEach(q => {
            initial[q.paramCode] = q.defaultAnswer || 'N';
        });
        return initial;
    });

    const handleSubmit = (e) => {
        e.preventDefault();
        onSubmit(answers);
    };

    const updateAnswer = (paramCode, value) => {
        setAnswers(prev => ({ ...prev, [paramCode]: value }));
    };

    return (
        <div className="questions-dialog">
            <h3>Additional Information Required</h3>
            <form onSubmit={handleSubmit}>
                {questions.map(question => (
                    <div key={question.paramCode} className="question-field">
                        <label>
                            {question.question}
                        </label>
                        {question.possibleAnswers ? (
                            <select
                                value={answers[question.paramCode]}
                                onChange={(e) => updateAnswer(question.paramCode, e.target.value)}
                            >
                                {question.possibleAnswers.map(answer => (
                                    <option key={answer} value={answer}>
                                        {answer === 'Y' ? 'Yes' : answer === 'N' ? 'No' : answer}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <input
                                type="text"
                                value={answers[question.paramCode]}
                                onChange={(e) => updateAnswer(question.paramCode, e.target.value)}
                            />
                        )}
                    </div>
                ))}
                <button type="submit" disabled={loading}>
                    {loading ? 'Calculating...' : 'Calculate Final Fees'}
                </button>
            </form>
        </div>
    );
};

// Component to display calculated fees
const FeeDisplay = ({ fees }) => {
    return (
        <div className="fees-display">
            <h3>Calculated Fees</h3>

            <div className="fee-section">
                <h4>Title Insurance</h4>
                <div className="fee-line">
                    <span>Owner's Policy:</span>
                    <span>${fees.title.ownersPolicy.toFixed(2)}</span>
                </div>
                <div className="fee-line">
                    <span>Lender's Policy:</span>
                    <span>${fees.title.lendersPolicy.toFixed(2)}</span>
                </div>
                <div className="fee-line total">
                    <span>Title Total:</span>
                    <span>${fees.title.total.toFixed(2)}</span>
                </div>
            </div>

            <div className="fee-section">
                <h4>Settlement Fees</h4>
                <div className="fee-line">
                    <span>Settlement Fee:</span>
                    <span>${fees.settlement.settlementFee.toFixed(2)}</span>
                </div>
                <div className="fee-line total">
                    <span>Settlement Total:</span>
                    <span>${fees.settlement.total.toFixed(2)}</span>
                </div>
            </div>

            <div className="fee-section">
                <h4>Recording Fees</h4>
                <div className="fee-line">
                    <span>Recording Total:</span>
                    <span>${fees.recording.total.toFixed(2)}</span>
                </div>
            </div>

            <div className="grand-total">
                <span>Grand Total:</span>
                <span>${fees.grandTotal.toFixed(2)}</span>
            </div>
        </div>
    );
};

export default FeeCalculatorComponent;
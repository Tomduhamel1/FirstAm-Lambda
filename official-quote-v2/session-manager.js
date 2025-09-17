const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');
const dynamoDB = new AWS.DynamoDB.DocumentClient();

/**
 * Session manager for L2 quote flow
 * Uses a separate DynamoDB table to avoid any impact on existing functionality
 */

const TABLE_NAME = 'QuoteSessionsV2'; // Separate table for L2 sessions
const SESSION_TTL_HOURS = 24;

/**
 * Create a new L2 session
 * @param {Object} sessionData - Initial session data
 * @returns {String} Session ID
 */
async function createL2Session(sessionData) {
    const sessionId = uuidv4();
    
    const item = {
        sessionId,
        ...sessionData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'pending_answers',
        ttl: Math.floor(Date.now() / 1000) + (SESSION_TTL_HOURS * 60 * 60)
    };
    
    const params = {
        TableName: TABLE_NAME,
        Item: item
    };
    
    try {
        await dynamoDB.put(params).promise();
        console.info('L2 session created:', sessionId);
        return sessionId;
    } catch (error) {
        console.error('Failed to create L2 session:', error);
        
        // If table doesn't exist, use in-memory storage as fallback
        if (error.code === 'ResourceNotFoundException') {
            console.warn('Using in-memory session storage (table not found)');
            return storeInMemory(sessionId, item);
        }
        
        throw error;
    }
}

/**
 * Retrieve an L2 session
 * @param {String} sessionId - Session ID
 * @returns {Object} Session data
 */
async function getL2Session(sessionId) {
    const params = {
        TableName: TABLE_NAME,
        Key: { sessionId }
    };
    
    try {
        const result = await dynamoDB.get(params).promise();
        
        if (!result.Item) {
            // Check in-memory storage as fallback
            const memorySession = getFromMemory(sessionId);
            if (memorySession) {
                return memorySession;
            }
            
            throw new Error('Session not found');
        }
        
        // Check if session has expired
        if (result.Item.ttl && result.Item.ttl < Math.floor(Date.now() / 1000)) {
            throw new Error('Session has expired');
        }
        
        return result.Item;
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            // Try in-memory storage
            const memorySession = getFromMemory(sessionId);
            if (memorySession) {
                return memorySession;
            }
        }
        
        console.error('Failed to retrieve L2 session:', error);
        throw error;
    }
}

/**
 * Update an L2 session
 * @param {String} sessionId - Session ID
 * @param {Object} updates - Updates to apply
 */
async function updateL2Session(sessionId, updates) {
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    // Always update the updatedAt timestamp
    updates.updatedAt = new Date().toISOString();
    
    Object.keys(updates).forEach((key, index) => {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = updates[key];
    });
    
    const params = {
        TableName: TABLE_NAME,
        Key: { sessionId },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
    };
    
    try {
        await dynamoDB.update(params).promise();
        console.info('L2 session updated:', sessionId);
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            // Update in-memory storage
            console.warn('Updating in-memory session');
            updateInMemory(sessionId, updates);
            return;
        }
        
        console.error('Failed to update L2 session:', error);
        throw error;
    }
}

/**
 * Delete an L2 session
 * @param {String} sessionId - Session ID
 */
async function deleteL2Session(sessionId) {
    const params = {
        TableName: TABLE_NAME,
        Key: { sessionId }
    };
    
    try {
        await dynamoDB.delete(params).promise();
        console.info('L2 session deleted:', sessionId);
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            // Delete from memory
            deleteFromMemory(sessionId);
            return;
        }
        
        console.error('Failed to delete L2 session:', error);
        throw error;
    }
}

/**
 * Store L1 response data in session
 * @param {String} sessionId - Session ID
 * @param {Object} l1ResponseData - Data from L1 response
 */
async function storeL1ResponseData(sessionId, l1ResponseData) {
    const updates = {
        l1Response: l1ResponseData,
        status: l1ResponseData.hasCalculatedRates ? 'rates_available' : 'pending_answers'
    };
    
    await updateL2Session(sessionId, updates);
}

/**
 * Store user answers in session
 * @param {String} sessionId - Session ID
 * @param {Object} answers - User answers
 */
async function storeUserAnswers(sessionId, answers) {
    const updates = {
        userAnswers: answers,
        status: 'answers_submitted'
    };
    
    await updateL2Session(sessionId, updates);
}

/**
 * Store page numbers in session
 * @param {String} sessionId - Session ID
 * @param {Object} pageNumbers - Page numbers for documents
 */
async function storePageNumbers(sessionId, pageNumbers) {
    const updates = {
        pageNumbers,
        updatedAt: new Date().toISOString()
    };
    
    await updateL2Session(sessionId, updates);
}

/**
 * Store final rates in session
 * @param {String} sessionId - Session ID
 * @param {Object} finalRates - Final rate data
 */
async function storeFinalRates(sessionId, finalRates) {
    const updates = {
        finalRates,
        status: 'completed',
        completedAt: new Date().toISOString()
    };
    
    await updateL2Session(sessionId, updates);
}

// In-memory storage fallback (for development/testing)
const memoryStorage = new Map();

function storeInMemory(sessionId, data) {
    memoryStorage.set(sessionId, data);
    
    // Auto-cleanup after TTL
    setTimeout(() => {
        memoryStorage.delete(sessionId);
    }, SESSION_TTL_HOURS * 60 * 60 * 1000);
    
    return sessionId;
}

function getFromMemory(sessionId) {
    return memoryStorage.get(sessionId);
}

function updateInMemory(sessionId, updates) {
    const existing = memoryStorage.get(sessionId);
    if (existing) {
        memoryStorage.set(sessionId, { ...existing, ...updates });
    }
}

function deleteFromMemory(sessionId) {
    memoryStorage.delete(sessionId);
}

/**
 * Clean up expired sessions (can be run periodically)
 */
async function cleanupExpiredSessions() {
    const currentTime = Math.floor(Date.now() / 1000);
    
    const params = {
        TableName: TABLE_NAME,
        FilterExpression: 'ttl < :now',
        ExpressionAttributeValues: {
            ':now': currentTime
        }
    };
    
    try {
        const result = await dynamoDB.scan(params).promise();
        
        if (result.Items && result.Items.length > 0) {
            console.info(`Cleaning up ${result.Items.length} expired sessions`);
            
            for (const item of result.Items) {
                await deleteL2Session(item.sessionId);
            }
        }
    } catch (error) {
        if (error.code !== 'ResourceNotFoundException') {
            console.error('Failed to cleanup expired sessions:', error);
        }
    }
}

/**
 * Get session statistics (for monitoring)
 */
async function getSessionStats() {
    try {
        const params = {
            TableName: TABLE_NAME,
            Select: 'COUNT'
        };
        
        const result = await dynamoDB.scan(params).promise();
        
        return {
            totalSessions: result.Count || 0,
            inMemorySessions: memoryStorage.size
        };
    } catch (error) {
        return {
            totalSessions: 0,
            inMemorySessions: memoryStorage.size
        };
    }
}

module.exports = {
    createL2Session,
    getL2Session,
    updateL2Session,
    deleteL2Session,
    storeL1ResponseData,
    storeUserAnswers,
    storePageNumbers,
    storeFinalRates,
    cleanupExpiredSessions,
    getSessionStats
};
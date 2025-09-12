const AWS = require('aws-sdk');
const dynamoDB = new AWS.DynamoDB.DocumentClient();

async function getZipCodeData(zipCode) {
    console.info('Querying DynamoDB for Zip Code data...');
    
    const params = {
        TableName: 'ZipCodes',
        Key: { zip: zipCode }
    };
    
    try {
        const result = await dynamoDB.get(params).promise();
        console.info('Zip Code Data:', result);
        
        if (!result.Item) {
            throw new Error(`Zip code ${zipCode} not found`);
        }
        
        return result.Item;
    } catch (error) {
        console.error('Failed to fetch zip code data:', error.message);
        throw error;
    }
}

async function getStateFees(stateCode) {
    console.info('Fetching state fees from DynamoDB...');
    
    const params = {
        TableName: 'FNTEFees',
        Key: { State: stateCode }
    };
    
    try {
        const result = await dynamoDB.get(params).promise();
        console.info('State Fee Data:', result);
        return result.Item || null;
    } catch (error) {
        console.error('Failed to fetch state fees:', error.message);
        return null;
    }
}

async function saveQuoteSession(sessionId, sessionData) {
    const params = {
        TableName: 'QuoteSessions',
        Item: {
            sessionId,
            ...sessionData,
            createdAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // Expire after 24 hours
        }
    };
    
    try {
        await dynamoDB.put(params).promise();
        console.info('Quote session saved:', sessionId);
        return sessionId;
    } catch (error) {
        console.error('Failed to save quote session:', error.message);
        throw error;
    }
}

async function getQuoteSession(sessionId) {
    const params = {
        TableName: 'QuoteSessions',
        Key: { sessionId }
    };
    
    try {
        const result = await dynamoDB.get(params).promise();
        return result.Item || null;
    } catch (error) {
        console.error('Failed to fetch quote session:', error.message);
        throw error;
    }
}

async function updateQuoteSession(sessionId, updates) {
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    Object.keys(updates).forEach((key, index) => {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = updates[key];
    });
    
    const params = {
        TableName: 'QuoteSessions',
        Key: { sessionId },
        UpdateExpression: `SET ${updateExpressions.join(', ')}, updatedAt = :updatedAt`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: {
            ...expressionAttributeValues,
            ':updatedAt': new Date().toISOString()
        }
    };
    
    try {
        await dynamoDB.update(params).promise();
        console.info('Quote session updated:', sessionId);
    } catch (error) {
        console.error('Failed to update quote session:', error.message);
        throw error;
    }
}

async function logAwsIdentity() {
    const sts = new AWS.STS();
    const identity = await sts.getCallerIdentity().promise();
    
    console.info('🔐 AWS Account ID:', identity.Account);
    console.info('👤 Caller ARN:', identity.Arn);
    console.info('📍 AWS Region:', AWS.config.region);
}

module.exports = {
    getZipCodeData,
    getStateFees,
    saveQuoteSession,
    getQuoteSession,
    updateQuoteSession,
    logAwsIdentity
};
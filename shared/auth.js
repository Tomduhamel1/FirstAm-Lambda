const axios = require('axios');

const clientId = 'ff4f2fdb-fe7d-430b-bb6c-8b95aae52f02';
const clientSecret = 'oQA8Q~3.eKRJHwzvm_B1inCFJnjx8MZZSz9~QcEH';
const tenantId = '4cc65fd6-9c76-4871-a542-eb12a5a7800c';
const oauthUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const scope = '58730ff7-91da-4e84-8155-59967e632e7d/.default';

let cachedToken = null;
let tokenExpiry = null;

async function getOAuthToken() {
    // Check if we have a valid cached token
    if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
        console.info('Using cached OAuth token');
        return cachedToken;
    }

    console.info('Fetching new OAuth token...');
    
    try {
        const tokenResponse = await axios.post(oauthUrl, new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: scope
        }));

        cachedToken = tokenResponse.data.access_token;
        // Set token expiry to 50 minutes from now (tokens usually last 60 minutes)
        tokenExpiry = new Date(Date.now() + 50 * 60 * 1000);
        
        console.info('OAuth token obtained successfully');
        return cachedToken;
    } catch (error) {
        console.error('Failed to fetch OAuth token:', error.message);
        throw new Error('Failed to authenticate with FirstAm API');
    }
}

module.exports = {
    getOAuthToken
};
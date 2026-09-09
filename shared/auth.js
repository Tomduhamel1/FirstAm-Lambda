const { firstAmRequestWithRetry } = require('./firstam-retry');

const clientId = process.env.FIRSTAM_CLIENT_ID || 'ff4f2fdb-fe7d-430b-bb6c-8b95aae52f02';
// Secret comes from the Lambda environment only (rotated 2026-09-09); no hard-coded fallback.
const clientSecret = process.env.FIRSTAM_CLIENT_SECRET;
if (!clientSecret) {
    console.error('FIRSTAM_CLIENT_SECRET is not set; FirstAm authentication will fail');
}
const tenantId = process.env.FIRSTAM_TENANT_ID || '4cc65fd6-9c76-4871-a542-eb12a5a7800c';
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
        const tokenResponse = await firstAmRequestWithRetry({
            method: 'post',
            url: oauthUrl,
            data: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
                scope: scope
            })
        }, { label: 'FirstAm OAuth', retries: 1 });

        cachedToken = tokenResponse.data.access_token;
        // Set token expiry to 50 minutes from now (tokens usually last 60 minutes)
        tokenExpiry = new Date(Date.now() + 50 * 60 * 1000);
        
        console.info('OAuth token obtained successfully');
        return cachedToken;
    } catch (error) {
        console.error('Failed to fetch OAuth token:', error.message);
        if (error.code === 'UPSTREAM_TIMEOUT') throw error; // keep the typed timeout so handlers can return a 503
        throw new Error('Failed to authenticate with FirstAm API');
    }
}

module.exports = {
    getOAuthToken
};
// /netlify/functions/utils.js

const { Pool } = require('pg');
const { google } = require('googleapis');

/**
 * PostgreSQL connection pool using environment variable DATABASE_URL.
 */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

/**
 * Authenticates and returns a Google Sheets API client.
 */
const getGoogleSheetsClient = async () => {
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const authClient = await auth.getClient();
        return google.sheets({ version: 'v4', auth: authClient });
    } catch (error) {
        console.error("Google Sheets Auth Error:", error);
        throw new Error("Invalid GOOGLE_CREDENTIALS");
    }
};

/**
 * Retries a function with exponential backoff.
 */
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries - 1) {
                console.error(`Final retry failed after ${retries} attempts`, err);
                throw err;
            }
            const waitTime = delay * 2 ** attempt;
            console.warn(`Retry ${attempt + 1}: Retrying in ${waitTime}ms...`);
            await new Promise(res => setTimeout(res, waitTime));
        }
    }
};

module.exports = {
    pool,
    getGoogleSheetsClient,
    retryWithBackoff
};

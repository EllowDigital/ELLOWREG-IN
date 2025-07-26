const { Pool } = require('pg');
const { google } = require('googleapis');

// --- Neon (PostgreSQL) Client ---
// The `pg` library automatically reads the DATABASE_URL environment variable.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// --- Google Sheets Client ---
// This function initializes an authenticated Google Sheets client.
const getGoogleSheetsClient = async () => {
    // Ensure credentials are in the correct format.
    // They should be a stringified JSON object in your environment variables.
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
};

/**
 * Retries an asynchronous function with exponential backoff. This is useful
 * for making external API calls or database queries more resilient to transient network errors.
 */
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            console.log(`Attempt ${i + 1} failed. Retrying in ${delay * 2 ** i}ms...`);
            await new Promise(res => setTimeout(res, delay * 2 ** i));
        }
    }
};

module.exports = {
    pool,
    getGoogleSheetsClient,
    retryWithBackoff
};

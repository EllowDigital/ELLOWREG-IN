// /netlify/functions/lib/utils.js

// --- Dependencies ---
const { google } = require("googleapis");

// --- Service Initializations ---

/**
 * A shared, authenticated Google Sheets API client.
 * By initializing this once, you avoid redundant setup in each function.
 * The scope can be adjusted based on the required permissions. For a utility
 * file used by functions that both read and write, 'spreadsheets' is appropriate.
 */
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });


// --- Utility Functions ---

/**
 * Retries an asynchronous function with exponential backoff. This is useful
 * for making external API calls more resilient to transient network errors.
 *
 * @param {Function} fn The asynchronous function to execute.
 * @param {number} [retries=3] The maximum number of retries.
 * @param {number} [delay=500] The initial delay in milliseconds.
 * @returns {Promise<any>} The result of the successful function execution.
 * @throws Will throw the error from the last attempt if all retries fail.
 */
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
    for (let i = 0; i < retries; i++) {
        try {
            // Attempt to execute the function and return its result if successful.
            return await fn();
        } catch (err) {
            // If this was the last retry attempt, re-throw the error.
            if (i === retries - 1) {
                throw err;
            }
            // Log the retry attempt for debugging purposes.
            console.log(`Attempt ${i + 1} failed. Retrying in ${delay * 2 ** i}ms...`);
            // Wait for an exponentially increasing amount of time before the next attempt.
            await new Promise((res) => setTimeout(res, delay * 2 ** i));
        }
    }
};

// --- Exports ---
// Export the initialized clients and helper functions so they can be
// required by other Netlify functions.
module.exports = {
    sheets,
    retryWithBackoff,
};

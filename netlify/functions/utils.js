const { Pool } = require('pg');

// Create a new pool instance.
// The `pg` library automatically reads the DATABASE_URL environment variable.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/**
 * Retries an asynchronous function with exponential backoff.
 * This is useful for making external API calls or database queries
 * more resilient to transient network errors.
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
            console.log(`Attempt ${i + 1} failed. Retrying in ${delay * (2 ** i)}ms...`);
            // Wait for an exponentially increasing amount of time before the next attempt.
            await new Promise(res => setTimeout(res, delay * 2 ** i));
        }
    }
};

module.exports = {
    pool,
    retryWithBackoff
};
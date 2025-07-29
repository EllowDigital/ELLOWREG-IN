// /netlify/functions/get-stats.js

const { pool } = require("./utils");

/**
 * Netlify serverless function to fetch dashboard statistics, such as total
 * registrations and the timestamp of the last registration.
 * This function is protected and intended for admin use only.
 */
exports.handler = async (event) => {
    // 1. Security Check: Ensure the request includes the correct secret key.
    const providedKey = event.headers['x-admin-key'];
    const secretKey = process.env.EXPORT_SECRET_KEY;

    if (!providedKey || providedKey !== secretKey) {
        return {
            statusCode: 401, // Unauthorized
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Unauthorized: Missing or invalid secret key." }),
        };
    }

    // 2. Method Check: This function should only respond to GET requests.
    if (event.httpMethod !== "GET") {
        return {
            statusCode: 405, // Method Not Allowed
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Method Not Allowed" })
        };
    }

    let dbClient;
    try {
        // 3. Database Query: Use a single, efficient query to get both stats.
        dbClient = await pool.connect();
        const statsQuery = `
            SELECT
                (SELECT COUNT(*) FROM registrations) AS total_registrations,
                (SELECT MAX(timestamp) FROM registrations) AS last_registration_time;
        `;
        const { rows } = await dbClient.query(statsQuery);
        const stats = rows[0];

        // 4. Return Response
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                totalRegistrations: parseInt(stats.total_registrations, 10),
                lastRegistrationTime: stats.last_registration_time // This will be an ISO-formatted string or null
            }),
        };

    } catch (error) {
        // 5. Generic Error Handling
        console.error("Error in get-stats function:", error);
        return {
            statusCode: 500, // Internal Server Error
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "An internal server error occurred." }),
        };
    } finally {
        // 6. Cleanup: Always release the database client.
        if (dbClient) {
            dbClient.release();
        }
    }
};

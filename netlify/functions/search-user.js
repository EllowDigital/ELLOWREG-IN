// /netlify/functions/search-user.js

// Import the shared database connection pool from the utils file.
const { pool } = require("./utils");

/**
 * Netlify serverless function to search for a registration by phone number.
 * This function is protected and intended for admin use only.
 */
exports.handler = async (event, context) => {
    // 1. Security Check: Ensure the request includes the correct secret key.
    // This prevents unauthorized access to user data.
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

    // 3. Input Validation: Check for the 'phone' query parameter.
    const { phone } = event.queryStringParameters;
    if (!phone || !/^[6-9]\d{9}$/.test(phone.trim())) {
        return {
            statusCode: 400, // Bad Request
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "A valid 10-digit Indian mobile number is required." }),
        };
    }

    const trimmedPhone = phone.trim();
    let dbClient;

    try {
        // 4. Database Query: Securely query the database for the user.
        dbClient = await pool.connect();

        const query = 'SELECT * FROM registrations WHERE phone = $1';
        const { rows } = await dbClient.query(query, [trimmedPhone]);

        // 5. Handle Response: Check if a user was found.
        if (rows.length === 0) {
            return {
                statusCode: 404, // Not Found
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: "No registration found for this phone number." }),
            };
        }

        // Return the found registration data as a JSON object.
        return {
            statusCode: 200, // OK
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rows[0]),
        };

    } catch (error) {
        // 6. Generic Error Handling: Catch any other unexpected errors.
        console.error("Error in search-user function:", error);
        return {
            statusCode: 500, // Internal Server Error
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "An internal server error occurred." }),
        };
    } finally {
        // 7. Cleanup: Always release the database client back to the pool.
        if (dbClient) {
            dbClient.release();
        }
    }
};

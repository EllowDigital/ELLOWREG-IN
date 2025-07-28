// /netlify/functions/search-user.js

const { pool } = require("./utils");

/**
 * Netlify serverless function to search for registrations by phone number and/or registration ID.
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

    // 3. Input Validation and Dynamic Query Building
    const { phone, registrationId } = event.queryStringParameters;
    const trimmedPhone = phone ? phone.trim() : null;
    const trimmedRegId = registrationId ? registrationId.trim().toUpperCase() : null;

    if (!trimmedPhone && !trimmedRegId) {
        return {
            statusCode: 400, // Bad Request
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Please provide a phone number or a registration ID to search." }),
        };
    }

    let queryText = 'SELECT * FROM registrations WHERE';
    const queryParams = [];
    let conditions = [];
    let paramIndex = 1;

    // Build query conditions based on provided parameters to prevent SQL injection
    if (trimmedPhone) {
        conditions.push(`phone = $${paramIndex++}`);
        queryParams.push(trimmedPhone);
    }

    if (trimmedRegId) {
        conditions.push(`registration_id = $${paramIndex++}`);
        queryParams.push(trimmedRegId);
    }

    // Join conditions with OR for flexible searching
    queryText += ` ${conditions.join(' OR ')} ORDER BY timestamp DESC;`;

    let dbClient;
    try {
        // 4. Database Query: Securely query the database.
        dbClient = await pool.connect();
        const { rows } = await dbClient.query(queryText, queryParams);

        // 5. Handle Response: Check if any users were found.
        if (rows.length === 0) {
            return {
                statusCode: 404, // Not Found
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: "No registration found for the provided details." }),
            };
        }

        // Return all found registration data as a JSON array.
        return {
            statusCode: 200, // OK
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rows),
        };

    } catch (error) {
        // 6. Generic Error Handling
        console.error("Error in search-user function:", error);
        return {
            statusCode: 500, // Internal Server Error
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "An internal server error occurred." }),
        };
    } finally {
        // 7. Cleanup: Always release the database client.
        if (dbClient) {
            dbClient.release();
        }
    }
};

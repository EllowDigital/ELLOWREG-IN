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
            statusCode: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Unauthorized: Missing or invalid secret key." }),
        };
    }

    // 2. Method Check
    if (event.httpMethod !== "GET") {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Method Not Allowed" })
        };
    }

    // 3. Input Validation
    const { phone, registrationId } = event.queryStringParameters;
    const trimmedPhone = phone ? phone.trim() : null;
    const trimmedRegId = registrationId ? registrationId.trim().toUpperCase() : null;

    if (!trimmedPhone && !trimmedRegId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Please provide a phone number or a registration ID." }),
        };
    }

    // --- FINAL, CORRECTED QUERY ---
    // Explicitly select all columns, including the new 'checked_in_at' field.
    // This is more robust than SELECT * and ensures the frontend always gets the data it needs.
    let queryText = `
        SELECT 
            id, timestamp, registration_id, name, company, phone, 
            address, city, state, day, payment_id, image_url, 
            needs_sync, checked_in_at 
        FROM registrations 
        WHERE
    `;
    const queryParams = [];
    let conditions = [];
    let paramIndex = 1;

    if (trimmedPhone) {
        conditions.push(`phone = $${paramIndex++}`);
        queryParams.push(trimmedPhone);
    }

    if (trimmedRegId) {
        conditions.push(`registration_id = $${paramIndex++}`);
        queryParams.push(trimmedRegId);
    }

    queryText += ` ${conditions.join(' OR ')} ORDER BY timestamp DESC;`;

    let dbClient;
    try {
        dbClient = await pool.connect();
        const { rows } = await dbClient.query(queryText, queryParams);

        if (rows.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ message: "No registration found for the provided details." }),
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify(rows),
        };

    } catch (error) {
        console.error("Error in search-user function:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "An internal server error occurred." }),
        };
    } finally {
        if (dbClient) {
            dbClient.release();
        }
    }
};

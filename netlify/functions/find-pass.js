// /netlify/functions/find-pass.js

const { pool } = require("./utils");

/**
 * A public-facing serverless function to find a registered user by their phone number
 * and return their data so they can re-download their visitor pass.
 */
exports.handler = async (event) => {
    // This function should only respond to GET requests.
    if (event.httpMethod !== "GET") {
        return {
            statusCode: 405, // Method Not Allowed
            body: JSON.stringify({ error: "Method Not Allowed" })
        };
    }

    const { phone } = event.queryStringParameters;
    const trimmedPhone = phone ? phone.trim() : null;

    // Validate that a phone number was provided.
    if (!trimmedPhone || !/^[6-9]\d{9}$/.test(trimmedPhone)) {
        return {
            statusCode: 400, // Bad Request
            body: JSON.stringify({ error: "Please provide a valid 10-digit phone number." }),
        };
    }

    let dbClient;
    try {
        dbClient = await pool.connect();
        const { rows } = await db.query('SELECT * FROM registrations WHERE phone = $1', [trimmedPhone]);

        // If no user is found, return a 404 error.
        if (rows.length === 0) {
            return {
                statusCode: 404, // Not Found
                body: JSON.stringify({ error: "No registration was found for this phone number." }),
            };
        }

        // IMPORTANT: Only return the data needed for the pass, not sensitive info.
        const userData = rows[0];
        const registrationData = {
            registrationId: userData.registration_id,
            name: userData.name,
            phone: userData.phone,
            firmName: userData.company,
            attendance: userData.day,
            profileImageUrl: userData.image_url,
        };

        // Return the found user's data.
        return {
            statusCode: 200, // OK
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(registrationData),
        };

    } catch (error) {
        console.error("Error in find-pass function:", error);
        return {
            statusCode: 500, // Internal Server Error
            body: JSON.stringify({ error: "An internal server error occurred." }),
        };
    } finally {
        if (dbClient) {
            dbClient.release();
        }
    }
};

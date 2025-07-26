// /netlify/functions/search-user.js
const { pool } = require("./utils");

exports.handler = async (event) => {
    // 1. Authenticate the request using a secret key from environment variables
    const providedKey = event.headers['x-admin-key'];
    const secretKey = process.env.EXPORT_SECRET_KEY;

    if (!providedKey || providedKey !== secretKey) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: "Unauthorized" }),
        };
    }

    // 2. Ensure the request method is GET
    if (event.httpMethod !== "GET") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    // 3. Validate the phone number from query parameters
    const { phone } = event.queryStringParameters;
    if (!phone || !/^[6-9]\d{9}$/.test(phone.trim())) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "A valid 10-digit phone number is required." }),
        };
    }

    const trimmedPhone = phone.trim();
    let dbClient;

    try {
        // 4. Connect to the database and search for the user
        dbClient = await pool.connect();
        const query = 'SELECT * FROM registrations WHERE phone = $1';
        // Corrected: Use the connected client to query
        const { rows } = await dbClient.query(query, [trimmedPhone]);

        // 5. Handle the result
        if (rows.length === 0) {
            return {
                statusCode: 404,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: "No registration found for this phone number." }),
            };
        }

        // Return the found registration data
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rows[0]),
        };

    } catch (error) {
        console.error("Search error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Database query failed." }),
        };
    } finally {
        // Ensure the database client is always released back to the pool
        if (dbClient) {
            dbClient.release();
        }
    }
};

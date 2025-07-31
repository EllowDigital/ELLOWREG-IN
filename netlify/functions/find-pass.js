// /netlify/functions/find-pass.js

const { pool } = require("./utils");

// --- Caching ---
// A simple in-memory cache for frequently requested phone numbers.
// This uses a Map to store multiple cached entries.
const userCache = new Map();
const CACHE_DURATION_MS = 2 * 60 * 1000; // 2 minutes

exports.handler = async (event) => {
    if (event.httpMethod !== "GET") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    const { phone } = event.queryStringParameters;
    const trimmedPhone = phone ? phone.trim() : null;

    if (!trimmedPhone || !/^[6-9]\d{9}$/.test(trimmedPhone)) {
        return { statusCode: 400, body: JSON.stringify({ error: "Please provide a valid 10-digit phone number." }) };
    }

    // --- IMPROVEMENT: Check the cache first ---
    const cachedEntry = userCache.get(trimmedPhone);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < CACHE_DURATION_MS)) {
        console.log(`[CACHE HIT] Serving pass for phone ${trimmedPhone} from cache.`);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cachedEntry.data),
        };
    }
    console.log(`[CACHE MISS] Fetching pass for phone ${trimmedPhone} from the database.`);
    // --- End Cache Check ---

    let dbClient;
    try {
        dbClient = await pool.connect();

        // --- IMPROVEMENT: Select only the required columns instead of SELECT * ---
        const queryText = `
            SELECT registration_id, name, phone, company, day, image_url
            FROM registrations WHERE phone = $1
        `;
        const { rows } = await dbClient.query(queryText, [trimmedPhone]);

        if (rows.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: "No registration was found for this phone number." }) };
        }

        const userData = rows[0];
        const registrationData = {
            registrationId: userData.registration_id,
            name: userData.name,
            phone: userData.phone,
            firmName: userData.company,
            attendance: userData.day,
            profileImageUrl: userData.image_url,
        };

        // --- IMPROVEMENT: Update the cache ---
        userCache.set(trimmedPhone, {
            data: registrationData,
            timestamp: Date.now()
        });
        // --- End Cache Update ---

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(registrationData),
        };

    } catch (error) {
        console.error("Error in find-pass function:", error);
        return { statusCode: 500, body: JSON.stringify({ error: "An internal server error occurred." }) };
    } finally {
        if (dbClient) {
            dbClient.release();
        }
    }
};

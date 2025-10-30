// /netlify/functions/find-pass.js

const { pool } = require("./utils");

// --- Caching Configuration ---
// A simple in-memory cache for frequently requested phone numbers.
// This uses a Map to store multiple cached entries for a short duration.
const userCache = new Map();
const CACHE_DURATION_MS = 2 * 60 * 1000; // Cache each result for 2 minutes

// --- Rate Limiting Configuration ---
// This prevents abuse by limiting requests from a single IP address.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 10; // Max 10 requests per IP per minute

/**
 * A professional, public-facing serverless function that allows users to find
 * their e-pass using their phone number. It is optimized for performance
 * with caching and secured against abuse with rate limiting.
 */
exports.handler = async (event) => {
  // --- 1. Rate Limiting Logic ---
  // This block protects the function from being called too many times by a single user.
  try {
    const clientIp = event.headers["x-nf-client-connection-ip"] || "unknown";
    const now = Date.now();

    // Get the request timestamps for this IP, filtering out any that are outside the current window.
    const requests = (rateLimitStore.get(clientIp) || []).filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );

    if (requests.length >= RATE_LIMIT_MAX_REQUESTS) {
      console.warn(`[RATE LIMIT] IP ${clientIp} has been rate-limited.`);
      return {
        statusCode: 429, // "Too Many Requests"
        body: JSON.stringify({
          error:
            "You have made too many requests. Please try again in a minute.",
        }),
      };
    }

    // Add the current request's timestamp to the store for this IP.
    requests.push(now);
    rateLimitStore.set(clientIp, requests);
  } catch (error) {
    // If rate limiting fails for any reason, log it but allow the request to proceed.
    console.error("Error during rate limiting:", error);
  }
  // --- End Rate Limiting Logic ---

  // 2. Basic Request Validation
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const { phone } = event.queryStringParameters;
  const trimmedPhone = phone ? phone.trim() : null;

  if (!trimmedPhone || !/^[6-9]\d{9}$/.test(trimmedPhone)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "Please provide a valid 10-digit phone number.",
      }),
    };
  }

  // --- 3. Caching Logic ---
  // Before querying the database, check if a recent result for this phone number is already in memory.
  const cachedEntry = userCache.get(trimmedPhone);
  if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_DURATION_MS) {
    console.log(
      `[CACHE HIT] Serving pass for phone ${trimmedPhone} from cache.`,
    );
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cachedEntry.data),
    };
  }
  console.log(
    `[CACHE MISS] Fetching pass for phone ${trimmedPhone} from the database.`,
  );

  // --- 4. Database Query ---
  let dbClient;
  try {
    dbClient = await pool.connect();

    // Optimized Query: Select only the columns needed for the e-pass.
    const queryText = `
            SELECT registration_id, name, phone, email, city, state, image_url
            FROM registrations WHERE phone = $1
        `;
    const { rows } = await dbClient.query(queryText, [trimmedPhone]);

    if (rows.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "No registration was found for this phone number.",
        }),
      };
    }

    const userData = rows[0];
    const registrationData = {
      registrationId: userData.registration_id,
      name: userData.name,
      phone: userData.phone,
      email: userData.email,
      city: userData.city,
      state: userData.state,
      profileImageUrl: userData.image_url,
    };

    // Store the fresh result in the cache for future requests.
    userCache.set(trimmedPhone, {
      data: registrationData,
      timestamp: Date.now(),
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationData),
    };
  } catch (error) {
    console.error("Error in find-pass function:", error);
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

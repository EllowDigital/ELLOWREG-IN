// /netlify/functions/get-stats.js

const { pool } = require("./utils");

// --- Caching ---
// This simple in-memory cache will store the stats for a short period.
// The cache is reset every time the serverless function instance restarts.
let cachedStats = null;
let cacheTimestamp = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

exports.handler = async (event) => {
  // 1. Security Check
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;
  if (!providedKey || providedKey !== secretKey) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  // --- IMPROVEMENT: Check the cache first ---
  if (cachedStats && Date.now() - cacheTimestamp < CACHE_DURATION_MS) {
    console.log("[CACHE HIT] Serving stats from cache.");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cachedStats),
    };
  }
  console.log("[CACHE MISS] Fetching fresh stats from the database.");
  // --- End Cache Check ---

  let dbClient;
  try {
    dbClient = await pool.connect();
  const statsQuery = `
      SELECT
        (SELECT COUNT(*) FROM registrations) AS total_registrations,
        (SELECT MAX(timestamp) FROM registrations) AS last_registration_time,
        (SELECT COUNT(*) FROM registrations WHERE timestamp >= NOW() - INTERVAL '24 hours') AS registrations_last_24_hours,
        (SELECT COUNT(*) FROM registrations WHERE checked_in_at IS NOT NULL) AS total_checked_in;
    `;
    const { rows } = await dbClient.query(statsQuery);
    const stats = {
      totalRegistrations: parseInt(rows[0].total_registrations, 10),
      lastRegistrationTime: rows[0].last_registration_time,
      registrationsLast24Hours: parseInt(rows[0].registrations_last_24_hours, 10),
      totalCheckedIn: parseInt(rows[0].total_checked_in, 10),
    };

    // --- IMPROVEMENT: Update the cache ---
    cachedStats = stats;
    cacheTimestamp = Date.now();
    // --- End Cache Update ---

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stats),
    };
  } catch (error) {
    console.error("Error in get-stats function:", error);
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

// /netlify/functions/get-stats.js

const { pool } = require("./utils");

exports.handler = async (event) => {
  // 1. Security Check
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;
  if (!providedKey || providedKey !== secretKey) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

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
      registrationsLast24Hours: parseInt(
        rows[0].registrations_last_24_hours,
        10,
      ),
      totalCheckedIn: parseInt(rows[0].total_checked_in, 10),
    };

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

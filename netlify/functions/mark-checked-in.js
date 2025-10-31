// /netlify/functions/mark-checked-in.js

const { pool } = require("./utils");

/**
 * A secure, admin-only serverless function to mark a registered user as "checked in"
 * by setting a timestamp in the database.
 */
exports.handler = async (event) => {
  // 1. Security: This function must be called with the POST method.
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // 2. Security: Check for the admin secret key in the headers.
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;
  if (!providedKey || providedKey !== secretKey) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let dbClient;
  try {
    const { registrationId } = JSON.parse(event.body);

    // 3. Validation: Ensure a registration ID was provided in the request body.
    if (!registrationId || !registrationId.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Registration ID is required." }),
      };
    }

    const normalizedRegistrationId = registrationId.trim().toUpperCase();

    dbClient = await pool.connect();

    // 4. Database Update: Set the check-in time and flag the record for sync.
    // We use COALESCE to prevent accidentally overwriting an existing check-in time.
    // This query updates the record and returns the new data in a single operation.
    const updateQuery = `
      UPDATE registrations
      SET
        checked_in_at = NOW(),
        updated_at = NOW(),
        needs_sync = true
      WHERE registration_id = $1
      RETURNING registration_id, name, checked_in_at;
    `;
    const { rows } = await dbClient.query(updateQuery, [
      normalizedRegistrationId,
    ]);

    if (rows.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "User not found." }),
      };
    }

    // 5. Success Response: Return a confirmation message and the updated data.
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Successfully checked in ${rows[0].name}.`,
        data: rows[0],
      }),
    };
  } catch (error) {
    console.error("Error in mark-checked-in function:", error);
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

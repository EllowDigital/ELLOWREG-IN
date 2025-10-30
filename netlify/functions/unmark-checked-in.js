// /netlify/functions/unmark-checked-in.js

const { pool } = require("./utils");

/**
 * A secure, admin-only serverless function to undo a check-in by setting
 * the 'checked_in_at' timestamp to NULL. This action requires the admin
 * password for verification.
 */
exports.handler = async (event) => {
  // 1. Security: Must be a POST request.
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // 2. Security: Check for the admin secret key.
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;
  if (!providedKey || providedKey !== secretKey) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let dbClient;
  try {
    const { registrationId, password } = JSON.parse(event.body);

    // 3. Password Verification: The provided password must match the secret key.
    if (password !== secretKey) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: "Incorrect password. Cannot undo check-in.",
        }),
      };
    }

    // 4. Validation: Ensure a registration ID was provided.
    if (!registrationId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Registration ID is required." }),
      };
    }

    dbClient = await pool.connect();

    // 5. Database Update: Set 'checked_in_at' to NULL and flag for sync.
    const updateQuery = `
            UPDATE registrations
            SET
                checked_in_at = NULL,
                needs_sync = true
            WHERE registration_id = $1
            RETURNING *;
        `;
    const { rows } = await dbClient.query(updateQuery, [registrationId]);

    if (rows.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "User not found." }),
      };
    }

    // 6. Success Response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Successfully unmarked ${rows[0].name} as checked-in.`,
        data: rows[0],
      }),
    };
  } catch (error) {
    console.error("Error in unmark-checked-in function:", error);
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

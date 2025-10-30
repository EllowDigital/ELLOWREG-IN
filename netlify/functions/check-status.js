// /netlify/functions/check-status.js

const { pool, getGoogleSheetsClient } = require("./utils");
const cloudinary = require("cloudinary").v2;

// --- Cloudinary Configuration ---
// This is required for the ping check.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Checks the operational status of all critical external services:
 * - Neon Database (via pg.Pool)
 * - Cloudinary API
 * - Google Sheets API
 * This function is protected and intended for admin use only.
 */
exports.handler = async (event) => {
  // 1. Security Check
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;

  if (!providedKey || providedKey !== secretKey) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  // 2. Database Status Check
  const checkDatabase = async () => {
    let dbClient;
    try {
      dbClient = await pool.connect();
      await dbClient.query("SELECT NOW()"); // Simple query to check connectivity
      return { status: "ok", message: "Connected" };
    } catch (error) {
      console.error("Database check failed:", error.message);
      return { status: "error", message: "Connection Failed" };
    } finally {
      if (dbClient) dbClient.release();
    }
  };

  // 3. Cloudinary Status Check
  const checkCloudinary = () => {
    return new Promise((resolve) => {
      cloudinary.api.ping((error, result) => {
        if (error) {
          console.error("Cloudinary check failed:", error.message);
          resolve({ status: "error", message: "Ping Failed" });
        } else if (result.status === "ok") {
          resolve({ status: "ok", message: "Operational" });
        } else {
          resolve({ status: "error", message: "API Not Ok" });
        }
      });
    });
  };

  // 4. Google Sheets Status Check
  const checkGoogleSheets = async () => {
    try {
      const sheets = await getGoogleSheetsClient();
      // A simple metadata read is a lightweight way to check auth and connectivity.
      await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        fields: "spreadsheetId", // Request minimal data
      });
      return { status: "ok", message: "Connected" };
    } catch (error) {
      console.error("Google Sheets check failed:", error.message);
      return { status: "error", message: "Connection Failed" };
    }
  };

  // 5. Run all checks in parallel and return results
  try {
    const [database, cloudinary, googleSheets] = await Promise.all([
      checkDatabase(),
      checkCloudinary(),
      checkGoogleSheets(),
    ]);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ database, cloudinary, googleSheets }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "An unexpected error occurred during status checks.",
      }),
    };
  }
};

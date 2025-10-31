// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";

const formatTimestamp = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      })
    : "N/A";

exports.handler = async (event = {}) => {
  const method = event.httpMethod;
  if (method && !["GET", "POST"].includes(method)) {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const headers = event.headers || {};
  const providedKey =
    headers["x-admin-key"] || headers["X-Admin-Key"] || headers["x-Admin-Key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;
  const isScheduledRun = Boolean(event.cron);

  if (!isScheduledRun) {
    if (!providedKey || providedKey !== secretKey) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
  }

  console.log(
    `[SYNC START] Full sheet refresh triggered via ${method || "schedule"} @ ${new Date().toISOString()}`,
  );

  if (!SPREADSHEET_ID) {
    console.error("[SYNC FAIL] Missing GOOGLE_SHEET_ID environment variable.");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server configuration error." }),
    };
  }

  let dbClient;
  try {
    dbClient = await pool.connect();
    const { rows: registrations } = await dbClient.query(
      `SELECT registration_id, name, phone, email, city, state, payment_id, timestamp, image_url, checked_in_at
         FROM registrations
        ORDER BY timestamp ASC`,
    );
    console.log(`[DB] Loaded ${registrations.length} registrations to sync.`);

    const sheets = await getGoogleSheetsClient();

    await retryWithBackoff(
      () =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            ranges: [`${SHEET_NAME}!A2:J`],
          },
        }),
      "Google Sheets Clear Data",
    );
    console.log("[GSheet] Cleared data rows (headers preserved).");

    if (registrations.length > 0) {
      const sheetRows = registrations.map((record) => [
        record.registration_id,
        record.name,
        record.phone,
        record.email,
        record.city,
        record.state,
        record.payment_id || "N/A",
        formatTimestamp(record.timestamp),
        record.image_url,
        formatTimestamp(record.checked_in_at),
      ]);

      const CHUNK_SIZE = 400;
      for (let i = 0; i < sheetRows.length; i += CHUNK_SIZE) {
        const chunk = sheetRows.slice(i, i + CHUNK_SIZE);
        const startRow = 2 + i;
        const endRow = startRow + chunk.length - 1;
        const range = `${SHEET_NAME}!A${startRow}:J${endRow}`;

        await retryWithBackoff(
          () =>
            sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range,
              valueInputOption: "USER_ENTERED",
              resource: { values: chunk },
            }),
          `Google Sheets Update Rows ${startRow}-${endRow}`,
        );
        console.log(`[GSheet] Wrote rows ${startRow}-${endRow}.`);
      }
      console.log(`[GSheet] Wrote ${sheetRows.length} rows to the sheet.`);
    } else {
      console.log("[GSheet] No registrations to publish; sheet left blank below headers.");
    }

    await dbClient.query(
      "UPDATE registrations SET needs_sync = false, updated_at = NOW() WHERE needs_sync = true",
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Sync successful.",
        rowsSynced: registrations.length,
      }),
    };
  } catch (error) {
    console.error("[SYNC FAIL] Synchronization failed:", {
      errorMessage: error.message,
      stack: error.stack,
      googleApiError: error.response?.data?.error,
    });
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to synchronize data.",
        details: error.message,
      }),
    };
  } finally {
    if (dbClient) {
      dbClient.release();
      console.log("[SYNC END] Database client released. Sync process finished.");
    }
  }
};
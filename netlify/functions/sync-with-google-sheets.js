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

    const safeSheetName = SHEET_NAME.includes(" ")
      ? `'${SHEET_NAME.replace(/'/g, "''")}'`
      : SHEET_NAME;
    const dataRangeBase = `${safeSheetName}!A2:J`;

    await retryWithBackoff(
      () =>
        sheets.spreadsheets.values.clear({
          spreadsheetId: SPREADSHEET_ID,
          range: dataRangeBase,
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
      const BATCH_LIMIT = 100;
      const dataRequests = [];

      for (let i = 0; i < sheetRows.length; i += CHUNK_SIZE) {
        const chunk = sheetRows.slice(i, i + CHUNK_SIZE);
        const startRow = 2 + i;
        const endRow = startRow + chunk.length - 1;
        dataRequests.push({
          range: `${safeSheetName}!A${startRow}:J${endRow}`,
          values: chunk,
        });
      }

      for (let i = 0; i < dataRequests.length; i += BATCH_LIMIT) {
        const batch = dataRequests.slice(i, i + BATCH_LIMIT);
        await retryWithBackoff(
          () =>
            sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: SPREADSHEET_ID,
              requestBody: {
                valueInputOption: "USER_ENTERED",
                data: batch,
              },
            }),
          `Google Sheets Batch Update ${i / BATCH_LIMIT + 1}`,
        );
        const batchStart = batch[0].range;
        const batchEnd = batch[batch.length - 1].range;
        console.log(`[GSheet] Wrote ranges ${batchStart} ... ${batchEnd}.`);
      }

      console.log(`[GSheet] Wrote ${sheetRows.length} rows to the sheet.`);
    } else {
      console.log(
        "[GSheet] No registrations to publish; sheet left blank below headers.",
      );
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
        googleApiError: error.response?.data?.error,
      }),
    };
  } finally {
    if (dbClient) {
      dbClient.release();
      console.log(
        "[SYNC END] Database client released. Sync process finished.",
      );
    }
  }
};

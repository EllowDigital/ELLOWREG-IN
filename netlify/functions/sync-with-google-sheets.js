// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";

/**
 * A professional, robust serverless function to synchronize data from a Postgres
 * database to a Google Sheet using an "Update or Append" (Upsert) strategy.
 */
exports.handler = async () => {
    console.log(`[SYNC START] Starting Upsert Sync Process @ ${new Date().toISOString()}`);
    if (!SPREADSHEET_ID) {
        console.error("[SYNC FAIL] Missing GOOGLE_SHEET_ID environment variable.");
        return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error." }) };
    }

    let dbClient;
    try {
        dbClient = await pool.connect();

        // 1. Fetch all records from the database that are flagged for syncing.
        const { rows: dbRecordsToSync } = await dbClient.query(
            "SELECT * FROM registrations WHERE needs_sync = true ORDER BY timestamp ASC"
        );

        if (dbRecordsToSync.length === 0) {
            console.log("[SYNC INFO] No records to sync. Job finished.");
            return { statusCode: 200, body: JSON.stringify({ message: "No records to sync." }) };
        }
        console.log(`[DB] Found ${dbRecordsToSync.length} records marked for sync.`);

        // 2. Fetch all existing data from the Google Sheet to build a map.
        const sheets = await getGoogleSheetsClient();
        const sheetResponse = await retryWithBackoff(() => sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:L`, // Fetch all columns to get row data
        }), 'Google Sheets Get All Data');

        const sheetValues = sheetResponse.data.values || [];
        // Create a map of registration_id -> { rowNumber, data }
        const sheetMap = new Map();
        sheetValues.forEach((row, index) => {
            const regId = row[0]; // Assuming registration_id is in the first column (A)
            if (regId) {
                // Sheet rows are 1-based, array index is 0-based.
                sheetMap.set(regId, { rowNumber: index + 1, data: row });
            }
        });
        console.log(`[GSheet] Mapped ${sheetMap.size} existing rows from the sheet.`);

        const recordsToAppend = [];
        const updateRequests = [];

        // 3. Determine which records to update and which to append.
        for (const dbRecord of dbRecordsToSync) {
            const newRowData = [
                dbRecord.registration_id, dbRecord.name, dbRecord.company, dbRecord.phone,
                dbRecord.address, dbRecord.city, dbRecord.state, dbRecord.day,
                dbRecord.payment_id || 'N/A',
                new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                dbRecord.image_url,
                dbRecord.checked_in_at ? new Date(dbRecord.checked_in_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : 'N/A'
            ];

            if (sheetMap.has(dbRecord.registration_id)) {
                // User exists in the sheet, prepare an UPDATE request.
                const existingRow = sheetMap.get(dbRecord.registration_id);
                updateRequests.push({
                    range: `${SHEET_NAME}!A${existingRow.rowNumber}`,
                    values: [newRowData],
                });
            } else {
                // User is new, add to the APPEND list.
                recordsToAppend.push(newRowData);
            }
        }

        console.log(`[SYNC PLAN] Records to update: ${updateRequests.length}. Records to append: ${recordsToAppend.length}.`);

        // 4. Execute all update and append operations.
        if (updateRequests.length > 0) {
            await retryWithBackoff(() => sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    valueInputOption: 'USER_ENTERED',
                    data: updateRequests,
                },
            }), 'Google Sheets Batch Update');
            console.log(`[GSheet] Successfully updated ${updateRequests.length} rows.`);
        }

        if (recordsToAppend.length > 0) {
            await retryWithBackoff(() => sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME,
                valueInputOption: "USER_ENTERED",
                resource: { values: recordsToAppend },
            }), 'Google Sheets Append');
            console.log(`[GSheet] Successfully appended ${recordsToAppend.length} new rows.`);
        }

        // 5. Mark all processed records as synced in the database.
        const allProcessedIds = dbRecordsToSync.map(record => record.registration_id);
        await dbClient.query(
            'UPDATE registrations SET needs_sync = false WHERE registration_id = ANY($1::text[])',
            [allProcessedIds]
        );
        console.log(`[DB] Successfully marked ${allProcessedIds.length} records as synced.`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Sync successful.",
                updated: updateRequests.length,
                appended: recordsToAppend.length
            }),
        };

    } catch (error) {
        console.error("[SYNC FAIL] The synchronization process failed critically.", {
            errorMessage: error.message,
            googleApiError: error.response?.data?.error,
        });
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to synchronize data.", details: error.message }),
        };
    } finally {
        if (dbClient) {
            dbClient.release();
            console.log("[SYNC END] Database client released. Sync process finished.");
        }
    }
};

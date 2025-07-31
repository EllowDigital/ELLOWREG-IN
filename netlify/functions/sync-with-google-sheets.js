// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations"; // The name of the sheet tab where data will be synced
const BATCH_SIZE = 500; // The number of records to process in each batch to avoid Google API limits

/**
 * A professional, idempotent, and robust serverless function to synchronize data
 * from a Postgres database to a Google Sheet. It is designed to handle large
 * datasets by processing records in batches and ensuring no duplicates are created.
 */
exports.handler = async () => {
    console.log(`[SYNC START] Starting robust sync process @ ${new Date().toISOString()}`);

    // Safeguard: Ensure the required environment variable is set.
    if (!SPREADSHEET_ID) {
        console.error("[SYNC FAIL] Missing required environment variable: GOOGLE_SHEET_ID.");
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
            console.log("[SYNC INFO] No new records to sync. Job finished.");
            return { statusCode: 200, body: JSON.stringify({ message: "No new records to sync." }) };
        }

        console.log(`[DB] Found ${dbRecordsToSync.length} records marked for sync.`);

        // 2. Fetch all existing registration IDs from the Google Sheet.
        // This is the key step to make the function idempotent and prevent duplicate entries.
        const sheets = await getGoogleSheetsClient();
        const getSheetValues = await retryWithBackoff(() => sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:A`, // Assumes IDs are in column A, starting from row 2.
        }), 'Google Sheets Get IDs');

        const existingIdsInSheet = new Set(getSheetValues.data.values ? getSheetValues.data.values.flat() : []);
        console.log(`[GSheet] Found ${existingIdsInSheet.size} existing IDs in the sheet.`);

        // 3. Filter out records from the database that are already present in the sheet.
        const recordsToAppend = dbRecordsToSync.filter(
            record => !existingIdsInSheet.has(record.registration_id)
        );

        const skippedCount = dbRecordsToSync.length - recordsToAppend.length;
        if (skippedCount > 0) {
            console.log(`[Filter] Skipping ${skippedCount} records that are already present in the sheet to avoid duplication.`);
        }

        // 4. If there are new records, append them to the sheet in managed batches.
        // This is crucial for handling large volumes of data without overwhelming the Google Sheets API.
        if (recordsToAppend.length > 0) {
            console.log(`[Append] Preparing to append ${recordsToAppend.length} new records in batches of ${BATCH_SIZE}.`);

            for (let i = 0; i < recordsToAppend.length; i += BATCH_SIZE) {
                const batch = recordsToAppend.slice(i, i + BATCH_SIZE);
                const currentBatchNumber = Math.floor(i / BATCH_SIZE) + 1;
                console.log(`[Append] Processing batch ${currentBatchNumber}...`);

                const rowsToAppend = batch.map(dbRecord => [
                    dbRecord.registration_id, dbRecord.name, dbRecord.company, dbRecord.phone,
                    dbRecord.address, dbRecord.city, dbRecord.state, dbRecord.day,
                    dbRecord.payment_id || 'N/A',
                    new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                    dbRecord.image_url,
                ]);

                await retryWithBackoff(() => sheets.spreadsheets.values.append({
                    spreadsheetId: SPREADSHEET_ID,
                    range: SHEET_NAME, // Appending to the sheet automatically finds the next empty row.
                    valueInputOption: "USER_ENTERED",
                    resource: { values: rowsToAppend },
                }), `Google Sheets Append Batch ${currentBatchNumber}`);
            }
            console.log("[Append] All batches successfully appended to the Google Sheet.");
        } else {
            console.log("[Append] No new records to append.");
        }

        // 5. Mark ALL initially fetched records as synced in the database.
        // This clears the entire sync queue, including any records that were skipped,
        // ensuring they are not processed again in the next run. This is the safest approach.
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
                processedFromDB: dbRecordsToSync.length,
                appendedToSheet: recordsToAppend.length,
                skippedAsDuplicates: skippedCount
            }),
        };

    } catch (error) {
        // Enhanced error logging to provide more context on failure.
        console.error("[SYNC FAIL] The synchronization process failed critically.", {
            errorMessage: error.message,
            googleApiError: error.response?.data?.error, // Catches specific errors from the Google API
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

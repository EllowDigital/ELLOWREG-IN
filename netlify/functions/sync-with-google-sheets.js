// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const API_CHUNK_SIZE = 500; // Process 500 records per API call to stay within limits.

/**
 * A highly scalable serverless function to synchronize up to 10,000+ records
 * from a Postgres database to a Google Sheet using an "Upsert" strategy.
 *
 * Key features for scalability:
 * - Efficiently fetches only registration IDs from the sheet to build a lookup map.
 * - Chunks API requests (updates and appends) to avoid hitting Google's payload size limits.
 * - Uses a reliable, serverless-friendly database connection pool.
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

        // 1. Fetch records from the database that need syncing.
        const { rows: dbRecordsToSync } = await dbClient.query(
            "SELECT * FROM registrations WHERE needs_sync = true ORDER BY timestamp ASC"
        );

        if (dbRecordsToSync.length === 0) {
            console.log("[SYNC INFO] No records to sync. Job finished.");
            return { statusCode: 200, body: JSON.stringify({ message: "No records to sync." }) };
        }
        console.log(`[DB] Found ${dbRecordsToSync.length} records marked for sync.`);

        // 2. Efficiently fetch ONLY the ID column from the Google Sheet to build a lookup map.
        const sheets = await getGoogleSheetsClient();
        const sheetResponse = await retryWithBackoff(() => sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:A`, // OPTIMIZED: Fetch only column A
        }), 'Google Sheets Get IDs');

        const sheetValues = sheetResponse.data.values || [];
        const sheetMap = new Map(); // Map of registration_id -> { rowNumber }
        sheetValues.forEach((row, index) => {
            const regId = row[0];
            if (regId) {
                sheetMap.set(regId, { rowNumber: index + 1 });
            }
        });
        console.log(`[GSheet] Mapped ${sheetMap.size} existing rows from the sheet.`);

        // 3. Categorize records for append or update operations.
        const recordsToAppend = [];
        const updateRequests = [];
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
                const { rowNumber } = sheetMap.get(dbRecord.registration_id);
                updateRequests.push({ range: `${SHEET_NAME}!A${rowNumber}`, values: [newRowData] });
            } else {
                recordsToAppend.push(newRowData);
            }
        }
        console.log(`[SYNC PLAN] Records to update: ${updateRequests.length}. Records to append: ${recordsToAppend.length}.`);

        // 4. Execute API calls in safe, manageable chunks.
        if (updateRequests.length > 0) {
            console.log(`[GSheet] Processing ${updateRequests.length} updates in chunks of ${API_CHUNK_SIZE}...`);
            for (let i = 0; i < updateRequests.length; i += API_CHUNK_SIZE) {
                const chunk = updateRequests.slice(i, i + API_CHUNK_SIZE);
                await retryWithBackoff(() => sheets.spreadsheets.values.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID,
                    resource: { valueInputOption: 'USER_ENTERED', data: chunk },
                }), `Google Sheets Batch Update Chunk ${i / API_CHUNK_SIZE + 1}`);
                console.log(` -> Updated chunk starting at index ${i}.`);
            }
            console.log("[GSheet] All update chunks processed successfully.");
        }

        if (recordsToAppend.length > 0) {
            console.log(`[GSheet] Processing ${recordsToAppend.length} appends in chunks of ${API_CHUNK_SIZE}...`);
            for (let i = 0; i < recordsToAppend.length; i += API_CHUNK_SIZE) {
                const chunk = recordsToAppend.slice(i, i + API_CHUNK_SIZE);
                await retryWithBackoff(() => sheets.spreadsheets.values.append({
                    spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME, valueInputOption: "USER_ENTERED",
                    resource: { values: chunk },
                }), `Google Sheets Append Chunk ${i / API_CHUNK_SIZE + 1}`);
                console.log(` -> Appended chunk starting at index ${i}.`);
            }
            console.log("[GSheet] All append chunks processed successfully.");
        }

        // 5. Mark all processed records as synced in a single, efficient database transaction.
        const allProcessedIds = dbRecordsToSync.map(record => record.registration_id);
        await dbClient.query(
            'UPDATE registrations SET needs_sync = false WHERE registration_id = ANY($1::text[])',
            [allProcessedIds]
        );
        console.log(`[DB] Successfully marked ${allProcessedIds.length} records as synced.`);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Sync successful.", updated: updateRequests.length, appended: recordsToAppend.length }),
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
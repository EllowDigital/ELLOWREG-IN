// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";

exports.handler = async () => {
    console.log("Starting Idempotent Delta Sync: Neon -> Google Sheets...");

    let dbClient;
    try {
        dbClient = await pool.connect();

        // 1. Fetch all records that need a sync
        const { rows: recordsToSync } = await dbClient.query(
            "SELECT * FROM registrations WHERE needs_sync = true ORDER BY timestamp ASC"
        );

        if (recordsToSync.length === 0) {
            console.log("No new records to sync. Job finished.");
            return { statusCode: 200, body: JSON.stringify({ message: "No new records to sync." }) };
        }

        console.log(`Found ${recordsToSync.length} records marked for sync.`);

        // 2. Fetch existing registration IDs from the Google Sheet to prevent duplicates
        const sheets = await getGoogleSheetsClient();
        const getSheetValues = await retryWithBackoff(() => sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:A`, // Assumes IDs are in column A, starting from row 2
        }), 'Google Sheets Get IDs');

        const existingIds = new Set(getSheetValues.data.values ? getSheetValues.data.values.flat() : []);

        // 3. Filter out records that are already in the sheet
        const recordsToAppend = recordsToSync.filter(
            record => !existingIds.has(record.registration_id)
        );

        // 4. Append only the truly new records
        if (recordsToAppend.length > 0) {
            console.log(`Appending ${recordsToAppend.length} truly new records to the sheet.`);
            const rowsToAppend = recordsToAppend.map(dbRecord => [
                dbRecord.registration_id, dbRecord.name, dbRecord.company, dbRecord.phone,
                dbRecord.address, dbRecord.city, dbRecord.state, dbRecord.day,
                dbRecord.payment_id || 'N/A',
                new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                dbRecord.image_url,
            ]);

            await retryWithBackoff(() => sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME,
                valueInputOption: "USER_ENTERED",
                resource: { values: rowsToAppend },
            }), 'Google Sheets Append');
        } else {
            console.log("No new records to append; any flagged records were already in the sheet.");
        }

        // 5. Mark ALL initially fetched records as synced to clear the queue
        const syncedIds = recordsToSync.map(record => record.registration_id);
        await dbClient.query(
            'UPDATE registrations SET needs_sync = false WHERE registration_id = ANY($1::text[])',
            [syncedIds]
        );
        console.log(`Successfully marked ${syncedIds.length} records as synced in the database.`);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Sync successful.", appended: recordsToAppend.length }),
        };

    } catch (error) {
        console.error("CRITICAL: The idempotent sync process failed.", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to synchronize data.", details: error.message }),
        };
    } finally {
        if (dbClient) {
            dbClient.release();
        }
    }
};
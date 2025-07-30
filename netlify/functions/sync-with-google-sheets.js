// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";

/**
 * An advanced, automated serverless function to efficiently synchronize new data
 * from a Neon PG database to a Google Sheet using a "Delta Sync" approach.
 * It only processes records that have been newly created or updated.
 */
exports.handler = async () => {
    console.log("Starting Delta Sync: Neon -> Google Sheets...");

    let dbClient;
    try {
        dbClient = await pool.connect();

        // 1. Fetch only the records that need to be synced from the database.
        const { rows: recordsToSync } = await dbClient.query(
            "SELECT * FROM registrations WHERE needs_sync = true ORDER BY timestamp ASC"
        );

        if (recordsToSync.length === 0) {
            console.log("No new records to sync. Job finished.");
            return {
                statusCode: 200,
                body: JSON.stringify({ message: "No new records to sync." }),
            };
        }

        console.log(`Found ${recordsToSync.length} new or updated records to sync.`);

        // 2. Format the new records for Google Sheets.
        const rowsToAppend = recordsToSync.map(dbRecord => [
            dbRecord.registration_id, dbRecord.name, dbRecord.company, dbRecord.phone,
            dbRecord.address, dbRecord.city, dbRecord.state, dbRecord.day,
            dbRecord.payment_id || 'N/A',
            new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            dbRecord.image_url,
        ]);

        // 3. Append the new records to the sheet.
        const sheets = await getGoogleSheetsClient();
        await retryWithBackoff(() => sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_NAME,
            valueInputOption: "USER_ENTERED",
            resource: { values: rowsToAppend },
        }), 'Google Sheets Append');

        console.log(`Successfully appended ${rowsToAppend.length} rows to the sheet.`);

        // 4. Mark these records as synced in the database with enhanced error handling.
        const syncedIds = recordsToSync.map(record => record.registration_id);

        try {
            console.log(`Attempting to mark ${syncedIds.length} records as synced in the database...`);
            await dbClient.query(
                'UPDATE registrations SET needs_sync = false WHERE registration_id = ANY($1::text[])',
                [syncedIds]
            );
            console.log(`Successfully marked ${syncedIds.length} records as synced.`);
        } catch (updateError) {
            // This is a critical error. If this fails, we will have duplicate entries.
            // Log it with high visibility.
            console.error("CRITICAL DATABASE ERROR: Failed to mark records as synced after updating Google Sheets.", updateError);
            // We should not return a success code here.
            // Re-throwing the error will cause the function to fail, which is the correct outcome.
            throw updateError;
        }

        console.log("Delta Sync complete.");

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Sync successful.", appended: rowsToAppend.length }),
        };

    } catch (error) {
        console.error("CRITICAL: The overall Delta Sync process failed.", error);
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

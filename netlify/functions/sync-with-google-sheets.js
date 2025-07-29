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
        // This is highly efficient as it ignores records already in the sheet.
        const { rows: recordsToSync } = await dbClient.query(
            "SELECT * FROM registrations WHERE needs_sync = true ORDER BY timestamp ASC"
        );

        // If there's nothing new, the job is done.
        if (recordsToSync.length === 0) {
            console.log("No new records to sync.");
            return {
                statusCode: 200,
                body: JSON.stringify({ message: "No new records to sync." }),
            };
        }

        console.log(`Found ${recordsToSync.length} new or updated records to sync.`);

        // 2. Format the new records into the correct structure for Google Sheets.
        const rowsToAppend = recordsToSync.map(dbRecord => [
            dbRecord.registration_id,
            dbRecord.name,
            dbRecord.company,
            dbRecord.phone,
            dbRecord.address,
            dbRecord.city,
            dbRecord.state,
            dbRecord.day,
            dbRecord.payment_id || 'N/A',
            new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            dbRecord.image_url,
        ]);

        // 3. Append all the new records to the sheet in a single, efficient API call.
        const sheets = await getGoogleSheetsClient();
        await retryWithBackoff(() => sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_NAME, // Appends to the first empty row of the sheet
            valueInputOption: "USER_ENTERED",
            resource: { values: rowsToAppend },
        }), 'Google Sheets Append');
        
        console.log(`Successfully appended ${rowsToAppend.length} rows to the sheet.`);

        // 4. Mark these records as synced in the database so they are not processed again.
        const syncedIds = recordsToSync.map(record => record.registration_id);
        await dbClient.query(
            'UPDATE registrations SET needs_sync = false WHERE registration_id = ANY($1::text[])',
            [syncedIds]
        );

        console.log(`Marked ${syncedIds.length} records as synced in the database.`);
        console.log("Delta Sync complete.");

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Sync successful.", appended: rowsToAppend.length }),
        };

    } catch (error) {
        console.error("CRITICAL: Delta Sync process failed.", error);
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

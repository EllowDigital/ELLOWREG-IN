// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const HEADERS = [
    "Registration ID", "Name", "Company", "Phone", "Address",
    "City", "State", "Days Attending", "Payment ID", "Timestamp", "Image URL"
];
const PHONE_COLUMN_INDEX = 3; // The 'Phone' column (0-indexed)

/**
 * A robust, automated serverless function to synchronize data from the Neon PG database
 * to a Google Sheet. It handles updates, insertions, and deletions to ensure
 * data consistency.
 *
 * This function is designed to be triggered by a scheduled task (cron job).
 */
exports.handler = async () => {
    console.log("Starting Neon -> Google Sheets synchronization process...");

    let dbClient;
    try {
        // --- Step 1: Fetch All Data from Both Sources ---
        dbClient = await pool.connect();
        const sheets = await getGoogleSheetsClient();

        // Fetch all registrations from the primary database (Neon)
        const { rows: dbRows } = await dbClient.query("SELECT * FROM registrations ORDER BY timestamp ASC");
        console.log(`Found ${dbRows.length} records in the database.`);

        // Fetch all data from the Google Sheet
        const sheetResponse = await retryWithBackoff(() =>
            sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME,
            }), 'Google Sheets Get'
        );
        const sheetRows = sheetResponse.data.values || [];
        // Remove header row for processing, if it exists
        if (sheetRows.length > 0 && sheetRows[0][0] === HEADERS[0]) {
            sheetRows.shift();
        }
        console.log(`Found ${sheetRows.length} records in Google Sheets.`);


        // --- Step 2: Create Maps for Efficient Lookups ---
        // Use phone number as the unique key for comparison
        const dbMap = new Map(dbRows.map(row => [row.phone, row]));
        const sheetMap = new Map(sheetRows.map(row => [row[PHONE_COLUMN_INDEX], { rowData: row, isProcessed: false }]));


        // --- Step 3: Prepare Batch Update/Insert/Delete Requests ---
        const rowsToUpdate = [];
        const rowsToInsert = [];

        for (const dbRecord of dbRows) {
            const phone = dbRecord.phone;
            const sheetEntry = sheetMap.get(phone);

            const newRowData = [
                dbRecord.registration_id, dbRecord.name, dbRecord.company, dbRecord.phone,
                dbRecord.address, dbRecord.city, dbRecord.state, dbRecord.day,
                dbRecord.payment_id || 'N/A',
                new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                dbRecord.image_url,
            ];

            if (sheetEntry) {
                // RECORD EXISTS IN BOTH: Check if an update is needed.
                sheetEntry.isProcessed = true; // Mark as processed
                // Compare registration IDs to detect re-registrations.
                const oldRegId = sheetEntry.rowData[0];
                if (oldRegId !== dbRecord.registration_id) {
                    console.log(`Update detected for phone ${phone}. New RegID: ${dbRecord.registration_id}`);
                    rowsToUpdate.push(newRowData);
                }
            } else {
                // RECORD ONLY IN DB: This is a new record to be inserted into the sheet.
                console.log(`New record found for phone ${phone}. Adding to insert queue.`);
                rowsToInsert.push(newRowData);
            }
        }

        // --- Step 4: Execute Batch Operations ---
        // A full clear-and-write is the most atomic and reliable way to handle all
        // updates, inserts, and deletes at once, preventing complex range calculations.
        console.log("Preparing to overwrite the sheet with fresh data...");

        // Combine all final, correct data into one array.
        const finalSheetData = dbRows.map(dbRecord => [
            dbRecord.registration_id, dbRecord.name, dbRecord.company, dbRecord.phone,
            dbRecord.address, dbRecord.city, dbRecord.state, dbRecord.day,
            dbRecord.payment_id || 'N/A',
            new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            dbRecord.image_url,
        ]);

        const values = [HEADERS, ...finalSheetData];

        // First, clear the entire sheet.
        await retryWithBackoff(() =>
            sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME,
            }), 'Google Sheets Clear'
        );
        console.log("Google Sheet cleared successfully.");

        // Then, write all the fresh data back to the sheet.
        await retryWithBackoff(() =>
            sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A1`,
                valueInputOption: "USER_ENTERED",
                resource: { values },
            }), 'Google Sheets Update'
        );

        console.log(`Synchronization complete. Wrote ${finalSheetData.length} records to Google Sheets.`);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Sync successful. ${finalSheetData.length} records processed.` }),
        };

    } catch (error) {
        console.error("CRITICAL: Synchronization process failed.", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to synchronize data.",
                details: error.message
            }),
        };
    } finally {
        if (dbClient) dbClient.release();
    }
};

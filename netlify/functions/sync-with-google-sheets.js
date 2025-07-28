// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const HEADERS = [
    "Registration ID", "Name", "Company", "Phone", "Address",
    "City", "State", "Days Attending", "Payment ID", "Timestamp", "Image URL"
];
// Define columns to fetch for comparison. Phone is the key. Reg ID detects re-registrations.
const SHEET_RANGE = `${SHEET_NAME}!A:D`; // Fetch columns A (Reg ID) and D (Phone)
const PHONE_COLUMN_INDEX = 3; // 'D'
const REG_ID_COLUMN_INDEX = 0; // 'A'

/**
 * A robust, automated serverless function to intelligently synchronize data from the
 * Neon PG database to a Google Sheet. It handles updates, insertions, and deletions
 * efficiently to ensure data consistency without a full rewrite.
 */
exports.handler = async () => {
    console.log("Starting intelligent Neon -> Google Sheets synchronization...");

    let dbClient;
    try {
        // --- Step 1: Fetch Data from Both Sources ---
        dbClient = await pool.connect();
        const sheets = await getGoogleSheetsClient();

        const { rows: dbRows } = await dbClient.query("SELECT * FROM registrations ORDER BY timestamp ASC");
        console.log(`Found ${dbRows.length} records in the database.`);

        const sheetResponse = await retryWithBackoff(() =>
            sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_RANGE }),
            'Google Sheets Get'
        );

        const sheetRows = sheetResponse.data.values || [];
        const headerRow = sheetRows.length > 0 ? sheetRows.shift() : []; // Remove header
        console.log(`Found ${sheetRows.length} data records in Google Sheets.`);

        // --- Step 2: Create Maps for Efficient Lookups ---
        const dbMap = new Map(dbRows.map(row => [row.phone, row]));
        const sheetMap = new Map(sheetRows.map((row, index) => {
            const phone = row[PHONE_COLUMN_INDEX];
            const regId = row[REG_ID_COLUMN_INDEX];
            // Sheet rows are 1-based, plus another 1 for the shifted header.
            return [phone, { regId, rowIndex: index + 2, isProcessed: false }];
        }));

        // --- Step 3: Determine Changes (Inserts, Updates, Deletes) ---
        const rowsToAppend = [];
        const updateRequests = [];

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
                sheetEntry.isProcessed = true;
                if (sheetEntry.regId !== dbRecord.registration_id) {
                    console.log(`Update detected for phone ${phone}. New RegID: ${dbRecord.registration_id}`);
                    updateRequests.push({
                        range: `${SHEET_NAME}!A${sheetEntry.rowIndex}`,
                        values: [newRowData],
                    });
                }
            } else {
                // RECORD ONLY IN DB: This is a new record to append.
                console.log(`New record found for phone ${phone}. Adding to append queue.`);
                rowsToAppend.push(newRowData);
            }
        }

        // --- Step 4: Execute Batch Operations ---
        if (rowsToAppend.length > 0) {
            console.log(`Appending ${rowsToAppend.length} new rows...`);
            await retryWithBackoff(() => sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME,
                valueInputOption: "USER_ENTERED",
                resource: { values: rowsToAppend },
            }), 'Google Sheets Append');
        } else {
            console.log("No new rows to append.");
        }

        if (updateRequests.length > 0) {
            console.log(`Batch updating ${updateRequests.length} existing rows...`);
            await retryWithBackoff(() => sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    valueInputOption: "USER_ENTERED",
                    data: updateRequests,
                },
            }), 'Google Sheets Batch Update');
        } else {
            console.log("No rows to update.");
        }

        console.log("Synchronization complete.");

        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Sync successful. Appended: ${rowsToAppend.length}, Updated: ${updateRequests.length}.` }),
        };

    } catch (error) {
        console.error("CRITICAL: Synchronization process failed.", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to synchronize data.", details: error.message }),
        };
    } finally {
        if (dbClient) dbClient.release();
    }
};
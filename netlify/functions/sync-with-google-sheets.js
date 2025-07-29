// /netlify/functions/sync-with-google-sheets.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
// Define columns to fetch for comparison. Phone is the primary key.
// Fetching the entire row allows for more robust data comparison if needed later,
// but for now, we'll primarily use phone and registration ID.
const SHEET_RANGE = `${SHEET_NAME}!A:K`; // Fetch all columns defined in HEADERS
const PHONE_COLUMN_INDEX = 3; // Column D
const REG_ID_COLUMN_INDEX = 0; // Column A

/**
 * A robust, automated serverless function to intelligently synchronize data from a
 * Neon PG database to a Google Sheet. It handles updates, insertions, and deletions
 * to ensure data consistency without rewriting the entire sheet on every run.
 */
exports.handler = async () => {
    console.log("Starting intelligent Neon -> Google Sheets synchronization...");

    let dbClient;
    try {
        // --- Step 1: Fetch Data from Both Sources & Get Sheet Metadata ---
        dbClient = await pool.connect();
        const sheets = await getGoogleSheetsClient();

        // Fetch DB records and sheet data concurrently for efficiency
        const [dbResult, sheetResponse, spreadsheetMeta] = await Promise.all([
            dbClient.query("SELECT * FROM registrations ORDER BY timestamp ASC"),
            retryWithBackoff(() => sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_RANGE }), 'Google Sheets Get'),
            retryWithBackoff(() => sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }), 'Google Sheets Get Metadata')
        ]);

        const dbRows = dbResult.rows;
        console.log(`Found ${dbRows.length} records in the database.`);

        const sheetRows = sheetResponse.data.values || [];
        if (sheetRows.length > 0) {
            sheetRows.shift(); // Remove header row
        }
        console.log(`Found ${sheetRows.length} data records in Google Sheets.`);

        // Find the numeric ID of our target sheet, required for delete operations
        const sheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === SHEET_NAME);
        if (!sheet) {
            throw new Error(`Sheet with name "${SHEET_NAME}" not found in the spreadsheet.`);
        }
        const sheetId = sheet.properties.sheetId;


        // --- Step 2: Create Maps for Efficient Lookups ---
        const dbMap = new Map(dbRows.map(row => [row.phone, row]));
        const sheetMap = new Map(sheetRows.map((row, index) => {
            const phone = row[PHONE_COLUMN_INDEX];
            const regId = row[REG_ID_COLUMN_INDEX];
            // Key by phone number. Value contains all info needed for updates/deletes.
            // Sheet rows are 1-based, plus another 1 for the shifted header.
            return [phone, { regId, rowIndex: index + 2, isProcessed: false }];
        }));

        // --- Step 3: Determine Changes (Inserts, Updates) ---
        const rowsToAppend = [];
        const batchUpdateRequests = [];

        for (const dbRecord of dbRows) {
            const phone = dbRecord.phone;
            const sheetEntry = sheetMap.get(phone);

            // Standardize row data for both inserts and updates
            const newRowData = [
                dbRecord.registration_id, dbRecord.name, dbRecord.company, dbRecord.phone,
                dbRecord.address, dbRecord.city, dbRecord.state, dbRecord.day,
                dbRecord.payment_id || 'N/A',
                new Date(dbRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                dbRecord.image_url,
            ];

            if (sheetEntry) {
                // RECORD EXISTS IN BOTH: Mark as processed and check if an update is needed.
                sheetEntry.isProcessed = true;
                // An update is needed if the registration ID differs.
                if (sheetEntry.regId !== dbRecord.registration_id) {
                    console.log(`Update detected for phone ${phone}. New RegID: ${dbRecord.registration_id}`);
                    batchUpdateRequests.push({
                        updateCells: {
                            start: { sheetId, rowIndex: sheetEntry.rowIndex - 1, columnIndex: 0 },
                            rows: [{ values: newRowData.map(val => ({ userEnteredValue: { stringValue: String(val) } })) }],
                            fields: "userEnteredValue"
                        }
                    });
                }
            } else {
                // RECORD ONLY IN DB: This is a new record to append.
                console.log(`New record found for phone ${phone}. Adding to append queue.`);
                rowsToAppend.push(newRowData);
            }
        }

        // --- Step 4: Determine Deletions ---
        const rowsToDelete = [];
        for (const sheetEntry of sheetMap.values()) {
            if (!sheetEntry.isProcessed) {
                // This record exists in the sheet but not the DB; it needs to be deleted.
                rowsToDelete.push(sheetEntry);
            }
        }

        // IMPORTANT: Sort rows to delete in descending order of their row index.
        // This prevents the row indices from shifting during the batch delete operation.
        rowsToDelete.sort((a, b) => b.rowIndex - a.rowIndex);

        for (const entry of rowsToDelete) {
            console.log(`Queuing row ${entry.rowIndex} for phone ${sheetMap.get(entry.phone)?.phone || '(phone not found)'} for deletion.`);
            batchUpdateRequests.push({
                deleteDimension: {
                    range: {
                        sheetId: sheetId,
                        dimension: "ROWS",
                        startIndex: entry.rowIndex - 1, // API is 0-indexed
                        endIndex: entry.rowIndex
                    }
                }
            });
        }

        // --- Step 5: Execute Batch Operations ---
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

        if (batchUpdateRequests.length > 0) {
            const updateCount = batchUpdateRequests.filter(r => r.updateCells).length;
            const deleteCount = batchUpdateRequests.filter(r => r.deleteDimension).length;
            console.log(`Batch processing ${updateCount} updates and ${deleteCount} deletions...`);
            await retryWithBackoff(() => sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: batchUpdateRequests },
            }), 'Google Sheets Batch Update/Delete');
        } else {
            console.log("No rows to update or delete.");
        }

        console.log("Synchronization complete.");

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Sync successful.",
                appended: rowsToAppend.length,
                updated: batchUpdateRequests.filter(r => r.updateCells).length,
                deleted: rowsToDelete.length
            }),
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

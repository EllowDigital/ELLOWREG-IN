// /netlify/functions/export-data.js
const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");
const ExcelJS = require('exceljs');

// --- Constants ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations"; // The name of the tab in your Google Sheet

// --- Main Handler ---
exports.handler = async (event) => {
    // 1. Authenticate the request using a secret key from environment variables
    const providedKey = event.headers['x-admin-key'];
    const secretKey = process.env.EXPORT_SECRET_KEY;

    if (!providedKey || providedKey !== secretKey) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: "Unauthorized" })
        };
    }

    let dbClient;
    try {
        // 2. Fetch all data from the database
        dbClient = await pool.connect();
        console.log('Export: Fetching all records from the database...');
        const { rows } = await dbClient.query('SELECT * FROM registrations ORDER BY timestamp ASC');
        console.log(`Export: Found ${rows.length} records.`);

        // 3. Sync to Google Sheets (Overwrite method)
        // This ensures the sheet is a perfect mirror of the database at the time of export.
        try {
            const sheets = await getGoogleSheetsClient();
            const headers = ["Registration ID", "Name", "Company", "Phone", "Address", "City", "State", "Days Attending", "Payment ID", "Timestamp", "Image URL"];

            // Format rows for Google Sheets API
            const sheetData = rows.map(row => [
                row.registration_id,
                row.name,
                row.company,
                row.phone,
                row.address,
                row.city,
                row.state,
                row.day,
                row.payment_id,
                new Date(row.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                row.image_url
            ]);

            // Add headers to the beginning of the data
            const values = [headers, ...sheetData];

            console.log('Export: Clearing existing data from Google Sheet...');
            await retryWithBackoff(() => sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME,
            }));

            console.log('Export: Writing new data to Google Sheet...');
            await retryWithBackoff(() => sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values },
            }));
            console.log('Export: Google Sheets sync complete.');
        } catch (sheetsError) {
            console.error("Export: Google Sheets sync failed during export:", sheetsError.message);
            // We log the error but still proceed to create the Excel file, as the database is the source of truth.
        }

        // 4. Generate Excel File (.xlsx)
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Registrations');

        // Define columns which will also be the headers
        worksheet.columns = [
            { header: 'Registration ID', key: 'registration_id', width: 20 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Company', key: 'company', width: 35 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Address', key: 'address', width: 40 },
            { header: 'City', key: 'city', width: 20 },
            { header: 'State', key: 'state', width: 20 },
            { header: 'Days Attending', key: 'day', width: 20 },
            { header: 'Payment ID', key: 'payment_id', width: 30 },
            { header: 'Timestamp', key: 'timestamp', width: 25, style: { numFmt: 'dd/mm/yyyy hh:mm:ss' } },
            { header: 'Image URL', key: 'image_url', width: 50 },
        ];

        // Style the header row
        worksheet.getRow(1).font = { bold: true };

        // Add data rows from the database query result
        worksheet.addRows(rows);

        // Write the workbook to a buffer in memory
        const buffer = await workbook.xlsx.writeBuffer();

        // 5. Return the Excel file for download
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="expo-registrations-${new Date().toISOString().split('T')[0]}.xlsx"`,
            },
            body: buffer.toString('base64'),
            isBase64Encoded: true,
        };

    } catch (error) {
        console.error("Error exporting data:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to export data." }),
        };
    } finally {
        if (dbClient) {
            dbClient.release(); // Ensure the database connection is closed
        }
    }
};

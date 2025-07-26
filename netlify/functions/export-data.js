// /netlify/functions/export-data.js
const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");
const ExcelJS = require('exceljs');

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";

exports.handler = async (event) => {
    // Simple secret key authentication
    const providedKey = event.headers['x-admin-key'];
    const secretKey = process.env.EXPORT_SECRET_KEY;

    if (!providedKey || providedKey !== secretKey) {
        return { statusCode: 401, body: "Unauthorized" };
    }

    let dbClient;
    try {
        // --- 1. Fetch all data from the database ---
        dbClient = await pool.connect();
        console.log('Fetching all records from the database...');
        const { rows } = await dbClient.query('SELECT * FROM registrations ORDER BY timestamp ASC');
        console.log(`Found ${rows.length} records.`);
        
        // --- 2. Sync to Google Sheets (Overwrite method) ---
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

            console.log('Clearing existing data from Google Sheet...');
            await retryWithBackoff(() => sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME,
            }));

            console.log('Writing new data to Google Sheet...');
            await retryWithBackoff(() => sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values },
            }));
            console.log('Google Sheets sync complete.');
        } catch (sheetsError) {
            console.error("Google Sheets sync failed during export:", sheetsError.message);
            // We'll log the error but still proceed to create the Excel file.
        }

        // --- 3. Generate Excel File (.xlsx) ---
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Registrations');

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
        
        worksheet.getRow(1).font = { bold: true };
        worksheet.addRows(rows);
        
        const buffer = await workbook.xlsx.writeBuffer();

        // --- 4. Return the Excel file for download ---
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
            dbClient.release();
        }
    }
};

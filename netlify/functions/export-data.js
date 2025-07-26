// /netlify/functions/export-data.js

const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");
const ExcelJS = require("exceljs");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";

exports.handler = async (event) => {
    const providedKey = event.headers["x-admin-key"];
    const secretKey = process.env.EXPORT_SECRET_KEY;

    if (!providedKey || providedKey !== secretKey) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: "Unauthorized" }),
        };
    }

    let dbClient;
    try {
        dbClient = await pool.connect();
        console.log("Export: Fetching records...");
        const { rows } = await dbClient.query(
            "SELECT * FROM registrations ORDER BY timestamp ASC"
        );
        console.log(`Export: Retrieved ${rows.length} rows.`);

        // --- Sync to Google Sheets ---
        try {
            const sheets = await getGoogleSheetsClient();
            const headers = [
                "Registration ID",
                "Name",
                "Company",
                "Phone",
                "Address",
                "City",
                "State",
                "Days Attending",
                "Payment ID",
                "Timestamp",
                "Image URL",
            ];

            const sheetData = rows.map((row) => [
                row.registration_id,
                row.name,
                row.company,
                row.phone,
                row.address,
                row.city,
                row.state,
                row.day,
                row.payment_id,
                new Date(row.timestamp).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                }),
                row.image_url,
            ]);

            const values = [headers, ...sheetData];

            console.log("Export: Clearing existing Google Sheet...");
            await retryWithBackoff(() =>
                sheets.spreadsheets.values.clear({
                    spreadsheetId: SPREADSHEET_ID,
                    range: SHEET_NAME,
                })
            );

            console.log("Export: Writing new data to Google Sheet...");
            await retryWithBackoff(() =>
                sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${SHEET_NAME}!A1`,
                    valueInputOption: "USER_ENTERED",
                    resource: { values },
                })
            );

            console.log("Export: Google Sheets sync complete.");
        } catch (sheetsErr) {
            console.error("Sheets sync failed:", sheetsErr.message);
            // Continue with Excel generation even if Sheets update fails
        }

        // --- Create Excel File (.xlsx) ---
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Registrations");

        worksheet.columns = [
            { header: "Registration ID", key: "registration_id", width: 20 },
            { header: "Name", key: "name", width: 30 },
            { header: "Company", key: "company", width: 35 },
            { header: "Phone", key: "phone", width: 15 },
            { header: "Address", key: "address", width: 40 },
            { header: "City", key: "city", width: 20 },
            { header: "State", key: "state", width: 20 },
            { header: "Days Attending", key: "day", width: 20 },
            { header: "Payment ID", key: "payment_id", width: 30 },
            {
                header: "Timestamp",
                key: "timestamp",
                width: 25,
                style: { numFmt: "dd/mm/yyyy hh:mm:ss" },
            },
            { header: "Image URL", key: "image_url", width: 50 },
        ];

        worksheet.getRow(1).font = { bold: true };
        worksheet.addRows(rows);

        const buffer = await workbook.xlsx.writeBuffer();

        return {
            statusCode: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="expo-registrations-${new Date().toISOString().split("T")[0]
                    }.xlsx"`,
            },
            body: buffer.toString("base64"),
            isBase64Encoded: true,
        };
    } catch (error) {
        console.error("Export error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to export data." }),
        };
    } finally {
        if (dbClient) dbClient.release();
    }
};

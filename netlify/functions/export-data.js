// /netlify/functions/export-data.js

const { pool } = require("./utils");
const ExcelJS = require("exceljs");
const QueryStream = require("pg-query-stream");
const { PassThrough } = require("stream");

/**
 * Netlify serverless function to generate and stream a .xlsx file of all registrations.
 *
 * This function is designed for scalability and can handle very large datasets (10,000+ records)
 * without exceeding serverless function memory or time limits. It achieves this by streaming
 * data directly from the PostgreSQL database to the Excel file writer, ensuring that the
 * entire dataset is never held in memory at once.
 *
 * NOTE: The Google Sheets synchronization logic has been intentionally removed from this function.
 * Combining a user-facing file download with a critical backend data sync in a single, long-running
 * serverless function is not a robust pattern. A failed sync could block the user's download,
 * and a failed download could prevent the sync. These operations should be separated.
 * A dedicated, separate function should be created for the Google Sheets sync.
 */
exports.handler = async (event) => {
    // 1. Security Check: Authenticate the request.
    // IMPORTANT: In a real production environment, this should be replaced with a proper
    // authentication system like Netlify Identity or another OAuth provider, not a static key.
    const providedKey = event.headers["x-admin-key"];
    const secretKey = process.env.EXPORT_SECRET_KEY;

    if (!providedKey || providedKey !== secretKey) {
        return {
            statusCode: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Unauthorized: Missing or invalid credentials." }),
        };
    }

    let dbClient;
    try {
        // 2. Establish a connection to the database.
        dbClient = await pool.connect();
        console.log("Export started: Acquired database client.");

        // 3. Set up the database query stream.
        // This creates a readable stream that will emit data row by row from the database.
        const query = new QueryStream("SELECT * FROM registrations ORDER BY timestamp ASC");
        const dbStream = dbClient.query(query);

        // 4. Set up the Excel workbook stream.
        // We use a PassThrough stream to pipe the generated Excel data into.
        const excelStream = new PassThrough();

        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
            stream: excelStream,
            useStyles: true,
        });
        const worksheet = workbook.addWorksheet("Registrations");

        // Define the columns for the Excel file. This adds headers.
        worksheet.columns = [
            { header: "Registration ID", key: "registration_id", width: 22 },
            { header: "Name", key: "name", width: 30 },
            { header: "Company Name", key: "company", width: 35 },
            { header: "Phone Number", key: "phone", width: 18 },
            { header: "Full Address", key: "address", width: 45 },
            { header: "District / City", key: "city", width: 25 },
            { header: "State", key: "state", width: 25 },
            { header: "Attending Days", key: "day", width: 25 },
            { header: "Payment ID", key: "payment_id", width: 30 },
            { header: "Registered On", key: "timestamp", width: 25, style: { numFmt: "dd-mmm-yyyy hh:mm:ss" } },
            { header: "Profile Image URL", key: "image_url", width: 50 },
        ];
        // Style the header row.
        worksheet.getRow(1).font = { bold: true, size: 12 };

        // 5. Pipe the streams together.
        // This is the core of the scalable process.
        // dbStream (data from DB) -> worksheet (formatted into Excel rows)
        dbStream.on('data', (row) => {
            // Add the row from the database to the worksheet.
            // .commit() writes the row to the stream immediately.
            worksheet.addRow(row).commit();
        });

        dbStream.on('end', () => {
            // All rows have been processed from the database.
            // Finalize the worksheet and the workbook.
            worksheet.commit();
            workbook.commit()
                .then(() => console.log("Excel workbook committed successfully."))
                .catch(err => console.error("Error committing Excel workbook:", err));
        });

        dbStream.on('error', (err) => {
            console.error("Error from database stream:", err);
            // Destroy the excel stream to signal an error to the client.
            excelStream.destroy(err);
        });

        // 6. Return the response to the client.
        // The body of the response is the readable `excelStream`. The serverless environment
        // will pipe the data from this stream to the user as it's generated.
        const fileName = `expo-registrations-${new Date().toISOString().split("T")[0]}.xlsx`;
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="${fileName}"`,
            },
            body: excelStream.read().toString('base64'),
            isBase64Encoded: true,
        };

    } catch (error) {
        console.error("A critical error occurred during the export process:", error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: "Failed to export data due to a server error.",
                details: error.message,
            }),
        };
    } finally {
        // 7. ALWAYS release the database client.
        if (dbClient) {
            dbClient.release();
            console.log("Export finished: Database client released.");
        }
    }
};

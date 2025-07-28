// /netlify/functions/export-data.js

const { pool } = require("./utils");
const ExcelJS = require("exceljs");
const QueryStream = require("pg-query-stream");
const { PassThrough } = require("stream");

/**
 * Netlify serverless function to generate and stream a .xlsx file of all registrations.
 * This function buffers the complete file in memory before sending, ensuring reliability
 * within the standard serverless function environment.
 */
exports.handler = async (event) => {
    // 1. Security Check: Authenticate the request.
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

        // This function will now return a promise that resolves with the full file buffer.
        const fileBuffer = await new Promise((resolve, reject) => {
            const query = new QueryStream("SELECT * FROM registrations ORDER BY timestamp ASC");
            const dbStream = dbClient.query(query);

            const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
                stream: new PassThrough(), // Write to a temporary stream
                useStyles: true,
            });
            const worksheet = workbook.addWorksheet("Registrations");

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
            worksheet.getRow(1).font = { bold: true, size: 12 };

            const chunks = [];

            // Listen to the data from the workbook's stream
            workbook.stream.on('data', (chunk) => {
                chunks.push(chunk);
            });

            dbStream.on('data', (row) => {
                worksheet.addRow(row).commit();
            });

            dbStream.on('end', () => {
                console.log("Database stream finished. Committing workbook.");
                workbook.commit().then(() => {
                    const buffer = Buffer.concat(chunks);
                    console.log("Excel file buffer created successfully.");
                    resolve(buffer);
                });
            });

            dbStream.on('error', (err) => {
                console.error("Error from database stream:", err);
                reject(err);
            });
        });

        // 3. Return the successful response with the buffered data.
        const fileName = `expo-registrations-${new Date().toISOString().split("T")[0]}.xlsx`;
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="${fileName}"`,
            },
            body: fileBuffer.toString('base64'),
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
        // 4. ALWAYS release the database client.
        if (dbClient) {
            dbClient.release();
            console.log("Export finished: Database client released.");
        }
    }
};

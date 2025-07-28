// /netlify/functions/export-data.js

const { pool } = require("./utils");
const ExcelJS = require("exceljs");
const QueryStream = require("pg-query-stream");
const cloudinary = require("cloudinary").v2;

// --- Cloudinary Configuration ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
});

exports.handler = async (event) => {
    // 1. Security Check
    const providedKey = event.headers["x-admin-key"];
    const secretKey = process.env.EXPORT_SECRET_KEY;

    if (!providedKey || providedKey !== secretKey) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: "Unauthorized: Missing or invalid credentials." }),
        };
    }

    let dbClient;
    try {
        const uploadResult = await new Promise(async (resolve, reject) => {
            dbClient = await pool.connect();
            console.log("Export started: Acquired database client.");

            const query = new QueryStream("SELECT * FROM registrations ORDER BY timestamp ASC");
            const dbStream = dbClient.query(query);

            const fileName = `expo-registrations-${new Date().toISOString().split("T")[0]}.xlsx`;

            const cloudinaryStream = cloudinary.uploader.upload_stream({
                public_id: fileName,
                folder: 'expo-exports-2025',
                resource_type: 'raw',
                use_filename: true,
                unique_filename: false,
                overwrite: true,
            }, (error, result) => {
                if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
                console.log("Cloudinary upload successful.");
                resolve(result);
            });

            const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
                stream: cloudinaryStream,
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

            dbStream.on('data', (row) => {
                worksheet.addRow(row).commit();
            });

            dbStream.on('error', (err) => {
                console.error("Error from database stream:", err);
                cloudinaryStream.end();
                reject(err);
            });

            // --- THIS IS THE CORRECTED BLOCK ---
            dbStream.on('end', () => {
                console.log("Database stream finished. Committing workbook to finalize.");
                // We MUST wait for the commit promise to resolve.
                workbook.commit()
                    .then(() => {
                        console.log("Workbook commit successful. The upload stream is now closed.");
                    })
                    .catch((err) => {
                        console.error("Error committing workbook:", err);
                        reject(err);
                    });
            });
            // ------------------------------------
        });

        // 3. Return the successful response with the secure download URL.
        console.log(`File available at: ${uploadResult.secure_url}`);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: "Export file created successfully.",
                downloadUrl: uploadResult.secure_url
            }),
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
        if (dbClient) {
            dbClient.release();
            console.log("Export finished: Database client released.");
        }
    }
};
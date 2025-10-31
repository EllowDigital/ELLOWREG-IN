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
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;

  if (!providedKey || providedKey !== secretKey) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized." }),
    };
  }

  let dbClient;
  try {
    const uploadResult = await new Promise(async (resolve, reject) => {
      dbClient = await pool.connect();
      console.log("Export started: Acquired database client.");

      // --- CORRECTED SQL QUERY ---
      // 'company' column removed to match new schema.
      const sql = `
          SELECT 
            registration_id, name, phone, email, 
            city, state, payment_id, timestamp, image_url,
            checked_in_at
          FROM registrations ORDER BY timestamp ASC
        `;
      const query = new QueryStream(sql);
      // -----------------------------------------

      const dbStream = dbClient.query(query);
      const fileName = `emrs-registrations-${
        new Date().toISOString().split("T")[0]
      }.xlsx`;

      const cloudinaryStream = cloudinary.uploader.upload_stream(
        {
          public_id: fileName,
          folder: "emrs-exports",
          resource_type: "raw",
          use_filename: true,
          unique_filename: false,
          overwrite: true,
        },
        (error, result) => {
          if (error)
            return reject(
              new Error(`Cloudinary upload failed: ${error.message}`),
            );
          console.log("Cloudinary upload successful.");
          resolve(result);
        },
      );

      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: cloudinaryStream,
        useStyles: true,
      });
      const worksheet = workbook.addWorksheet("Registrations");

      // --- CORRECTED EXCEL COLUMNS ---
      // 1. Removed 'company' column.
      // 2. Fixed 'Email' column key from 'address' to 'email'.
      worksheet.columns = [
        { header: "Registration ID", key: "registration_id", width: 22 },
        { header: "Name", key: "name", width: 30 },
        { header: "Phone Number", key: "phone", width: 18 },
        { header: "Email", key: "email", width: 45 }, // KEY FIXED
        { header: "District / City", key: "city", width: 25 },
        { header: "State", key: "state", width: 25 },
        { header: "Payment ID", key: "payment_id", width: 30 },
        {
          header: "Registered On",
          key: "timestamp",
          width: 25,
          style: { numFmt: "dd-mmm-yyyy hh:mm:ss" },
        },
        { header: "Profile Image URL", key: "image_url", width: 50 },
        {
          header: "Checked-In At",
          key: "checked_in_at",
          width: 25,
          style: { numFmt: "dd-mmm-yyyy hh:mm:ss" },
        },
      ];
      // -----------------------------------------

      worksheet.getRow(1).font = { bold: true, size: 12 };

      dbStream.on("data", (row) => {
        worksheet.addRow(row).commit();
      });

      dbStream.on("error", (err) => {
        console.error("Error from database stream:", err);
        cloudinaryStream.end();
        reject(err);
      });

      dbStream.on("end", () => {
        console.log(
          "Database stream finished. Committing workbook to finalize.",
        );
        workbook
          .commit()
          .then(() => {
            console.log("Workbook commit successful.");
          })
          .catch((err) => {
            console.error("Error committing workbook:", err);
            reject(err);
          });
      });
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Export file created successfully.",
        downloadUrl: uploadResult.secure_url,
      }),
    };
  } catch (error) {
    console.error(
      "A critical error occurred during the export process:",
      error,
    );
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
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

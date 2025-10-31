// /netlify/functions/submit-registration.js

const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");
const { pool } = require("./utils");

// --- Constants ---
const CLOUDINARY_FOLDER = "emrs-profile-images";

// --- Cloudinary Configuration ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Flag: Ensure required Cloudinary credentials are present at runtime.
const CLOUDINARY_ENABLED = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET,
);

// Helper function to parse multipart form data
const parseMultipartForm = (event) =>
  new Promise((resolve, reject) => {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType)
      return reject(new Error("Request is missing 'Content-Type' header."));

    const bb = busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: 10 * 1024 * 1024 },
    });
    const fields = {};
    const files = {};

    bb.on("file", (name, file, info) => {
      const allowedTypes = ["image/jpeg", "image/png", "image/jpg"];
      if (!allowedTypes.includes(info.mimeType)) {
        return reject(
          new Error(`Invalid file type. Only JPG and PNG are allowed.`),
        );
      }
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("limit", () =>
        reject(new Error(`File '${info.filename}' exceeds the 5MB limit.`)),
      );
      file.on("end", () => {
        files[name] = {
          filename: info.filename,
          content: Buffer.concat(chunks),
          contentType: info.mimeType,
        };
      });
    });

    bb.on("field", (name, value) => {
      fields[name] = value;
    });
    bb.on("close", () => {
      resolve({ fields, files });
    });
    bb.on("error", (err) =>
      reject(new Error(`Error parsing form data: ${err.message}`)),
    );
    bb.end(
      Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary"),
    );
  });

// Helper function to upload to Cloudinary
const uploadToCloudinary = (buffer, folder) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "auto" },
      (err, result) => {
        if (err)
          return reject(new Error(`Cloudinary upload failed: ${err.message}`));
        if (!result)
          return reject(new Error("Cloudinary returned an empty result."));
        resolve(result);
      },
    );
    uploadStream.end(buffer);
  });

// --- Main Handler Function ---
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL environment variable is not configured.");
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "Server misconfiguration: database connection is unavailable.",
      }),
    };
  }

  let dbClient;
  try {
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, email, district, state } = fields;
    const { profileImage } = files;

    // --- FINAL IMPROVEMENT: Strict Server-Side Validation ---
    const trimmedName = name ? name.trim() : "";
    const trimmedPhone = phone ? phone.trim() : "";
    const trimmedEmail = email ? email.trim() : "";
    const trimmedCity = district ? district.trim() : "";
    const trimmedState = state ? state.trim() : "";
    const normalizedEmail = trimmedEmail.toLowerCase();

    const validationErrors = [];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    if (trimmedName.length < 3)
      validationErrors.push("Full Name must be at least 3 characters.");
    if (!/^[6-9]\d{9}$/.test(trimmedPhone))
      validationErrors.push(
        "A valid 10-digit Indian phone number is required.",
      );
    if (!emailRegex.test(trimmedEmail))
      validationErrors.push("A valid email address is required.");
    if (trimmedCity.length < 2)
      validationErrors.push(
        "Please enter your city or district (min. 2 characters).",
      );
    if (trimmedState.length < 2)
      validationErrors.push("State is a required field.");
    if (!profileImage) validationErrors.push("A profile photo is required.");

    if (validationErrors.length > 0) {
      return {
        statusCode: 400, // Bad Request
        body: JSON.stringify({
          status: "validation_error",
          errors: validationErrors,
        }),
      };
    }
    // --- End Validation Block ---

    dbClient = await pool.connect();
    const existingUserQuery = "SELECT * FROM registrations WHERE phone = $1";
    const { rows } = await dbClient.query(existingUserQuery, [trimmedPhone]);

    if (rows.length > 0) {
      const existingRecord = rows[0];
      const updateAssignments = ["needs_sync = true"];
      const updateValues = [];

      if (normalizedEmail && normalizedEmail !== (existingRecord.email || "")) {
        updateValues.push(normalizedEmail);
        updateAssignments.push(`email = $${updateValues.length}`);
        existingRecord.email = normalizedEmail;
      }

      if (trimmedCity && trimmedCity !== (existingRecord.city || "")) {
        updateValues.push(trimmedCity);
        updateAssignments.push(`city = $${updateValues.length}`);
        existingRecord.city = trimmedCity;
      }

      if (trimmedState && trimmedState !== (existingRecord.state || "")) {
        updateValues.push(trimmedState);
        updateAssignments.push(`state = $${updateValues.length}`);
        existingRecord.state = trimmedState;
      }

      updateAssignments.push("updated_at = NOW()");

      const wherePlaceholderIndex = updateValues.length + 1;
      updateValues.push(trimmedPhone);
      await dbClient.query(
        `UPDATE registrations SET ${updateAssignments.join(", ")} WHERE phone = $${wherePlaceholderIndex}`,
        updateValues,
      );

      const registrationData = {
        registrationId: existingRecord.registration_id,
        name: existingRecord.name,
        phone: existingRecord.phone,
        email: existingRecord.email,
        city: existingRecord.city,
        state: existingRecord.state,
        profileImageUrl: existingRecord.image_url,
      };
      return {
        statusCode: 409, // Conflict
        body: JSON.stringify({
          status: "exists",
          error: "This phone number is already registered.",
          registrationData,
        }),
      };
    }

    if (!CLOUDINARY_ENABLED) {
      console.error(
        "Cloudinary credentials are missing. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in your environment.",
      );
      return {
        statusCode: 500,
        body: JSON.stringify({
          status: "error",
          error:
            "Cloudinary disabled: missing credentials. Contact the administrator or set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
        }),
      };
    }

    let uploadResult;
    try {
      uploadResult = await uploadToCloudinary(
        profileImage.content,
        CLOUDINARY_FOLDER,
      );
    } catch (cloudErr) {
      console.error(
        "Cloudinary upload failed:",
        cloudErr && cloudErr.message ? cloudErr.message : cloudErr,
      );
      if (cloudErr && cloudErr.stack) console.error(cloudErr.stack);
      return {
        statusCode: 500,
        body: JSON.stringify({
          status: "error",
          error: `Cloudinary upload failed: ${cloudErr && cloudErr.message ? cloudErr.message : "unknown error"}`,
        }),
      };
    }

    const registrationId = `EMRS-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const registrationTimestamp = new Date();

    const insertQuery = `INSERT INTO registrations (registration_id, name, phone, email, city, state, image_url, timestamp, updated_at, needs_sync) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *;`;
    const values = [
      registrationId,
      trimmedName,
      trimmedPhone,
      normalizedEmail,
      trimmedCity || null,
      trimmedState || null,
      uploadResult.secure_url,
      registrationTimestamp,
      registrationTimestamp,
      true,
    ];
    const result = await dbClient.query(insertQuery, values);
    const newRecord = result.rows[0];

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId: newRecord.registration_id,
          name: newRecord.name,
          phone: newRecord.phone,
          email: newRecord.email,
          city: newRecord.city,
          state: newRecord.state,
          profileImageUrl: newRecord.image_url,
        },
      }),
    };
  } catch (err) {
    console.error("SUBMIT_REGISTRATION_ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "An internal server error occurred.",
        details: err.message,
      }),
    };
  } finally {
    if (dbClient) {
      dbClient.release();
    }
  }
};

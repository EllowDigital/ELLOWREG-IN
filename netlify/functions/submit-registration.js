// This function requires 'busboy' to parse multipart/form-data with file uploads.
// Netlify's environment includes 'busboy'.
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// --- Helper function to parse multipart form data ---
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
    const fields = {};
    const files = {};
    const bb = busboy({ headers: event.headers });

    bb.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        files[name] = {
          filename,
          content: Buffer.concat(chunks),
          contentType: mimeType,
        };
      });
    });

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err}`)));
    bb.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    bb.end();
  });
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // --- Configure services ---
    cloudinary.config({ 
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
      api_key: process.env.CLOUDINARY_API_KEY, 
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    
    // 1. Parse the incoming form data
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const paymentScreenshot = files.paymentScreenshot;

    if (!paymentScreenshot) {
      throw new Error("Payment screenshot file is missing.");
    }

    // --- Authenticate with Google ---
    const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    
    // *** NEW: Check for duplicate mobile number ***
    // We assume the phone number is in Column D.
    const getRows = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Registrations!D:D',
    });

    if (getRows.data.values) {
        const phoneNumbers = getRows.data.values.flat();
        if (phoneNumbers.includes(phone)) {
            // Return a 409 Conflict error if the number is found
            return {
                statusCode: 409,
                body: JSON.stringify({ error: 'This mobile number has already been registered.' }),
            };
        }
    }

    // 2. Generate a unique Enrollment ID (no changes here)
    const timestamp = Date.now().toString().slice(-5);
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const enrollmentId = `TDE25-${randomSuffix}${timestamp}`;
    
    // 3. Upload the screenshot to Cloudinary
    const uploadResponse = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "expo-registrations-2025" },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        uploadStream.end(paymentScreenshot.content);
    });

    // 4. Append the new data to the Google Sheet
    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Registrations', 
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[
                new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                enrollmentId,
                name,
                phone,
                firmName,
                address,
                district,
                state,
                attendance,
                uploadResponse.secure_url,
            ]],
        },
    });

    // 5. Return the successful response
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentId: enrollmentId }),
    };

  } catch (error) {
    console.error('REGISTRATION_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to process registration. ${error.message}` }),
    };
  }
};

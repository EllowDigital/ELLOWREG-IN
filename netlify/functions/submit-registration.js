
// This is a placeholder for a Netlify Function.
// You would need to install libraries like 'googleapis' for Google Sheets
// and a library for your chosen file upload service (e.g., 'cloudinary').

// Example: Using Google Sheets API
// You'll need to set up a Google Cloud Project, enable the Sheets API,
// and create a Service Account to get credentials.
const { google } = require('googleapis');

// Example: Using Cloudinary for image uploads
// You'll need a Cloudinary account to get your credentials.
const cloudinary = require('cloudinary').v2;

// --- Configure Services (use environment variables in Netlify for security) ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

exports.handler = async (event) => {
    // 1. Check if the request is a POST request
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // NOTE: Netlify automatically handles multipart/form-data parsing
        const { name, phone, firmName, address, district, state, attendance } = event.body;
        const paymentScreenshot = event.files.paymentScreenshot;

        // 2. Generate a Unique Enrollment ID
        const timestamp = Date.now();
        const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
        const enrollmentId = `TDE${timestamp}-${randomSuffix}`;

        // 3. Upload the screenshot to a cloud service (e.g., Cloudinary)
        // This returns a secure URL to the uploaded image.
        const uploadResult = await cloudinary.uploader.upload(paymentScreenshot.path, {
            folder: "expo-registrations"
        });
        const screenshotUrl = uploadResult.secure_url;

        // 4. Connect to Google Sheets and append the data
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Registrations!A1', // Assumes a sheet named "Registrations"
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [
                    [
                        new Date().toISOString(), // Timestamp
                        enrollmentId,
                        name,
                        phone,
                        firmName,
                        address,
                        district,
                        state,
                        attendance,
                        screenshotUrl // Link to the uploaded image
                    ]
                ],
            },
        });

        // 5. Return the unique ID to the user's browser
        return {
            statusCode: 200,
            body: JSON.stringify({ enrollmentId: enrollmentId }),
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process registration.' }),
        };
    }
};

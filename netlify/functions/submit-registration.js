// This function uses Firebase Firestore for scalable, concurrent data handling.
// It also syncs the data to Google Sheets for easy viewing.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// --- Helper Functions (unchanged) ---
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
    const fields = {};
    const files = {};
    const bb = busboy({
      headers: event.headers,
      limits: { fileSize: 5 * 1024 * 1024 } // 5MB file size limit per file
    });

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
      file.on('limit', () => {
        reject(new Error(`File "${filename}" is too large. The limit is 5MB.`));
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err}`)));
    bb.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    bb.end();
  });
};

const uploadToCloudinary = (fileBuffer, folderName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: folderName },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

// --- Firebase Initialization ---
let firebaseApp;
if (!global._firebaseApp) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_CREDENTIALS);
  global._firebaseApp = initializeApp({
    credential: cert(serviceAccount)
  });
}
firebaseApp = global._firebaseApp;
const db = getFirestore(firebaseApp);

// --- Main Handler ---
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // --- Configure Cloudinary ---
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    // 1. Parse and Validate Form Data
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage, paymentScreenshot } = files;

    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value || !value.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) return { statusCode: 400, body: JSON.stringify({ error: 'Profile photo is required.' }) };
    if (!paymentScreenshot) return { statusCode: 400, body: JSON.stringify({ error: 'Payment screenshot is required.' }) };

    // 2. Check for Duplicate Phone Number in Firestore (Authoritative Check)
    const registrationsRef = db.collection('registrations');
    const snapshot = await registrationsRef.where('phone', '==', phone).limit(1).get();

    if (!snapshot.empty) {
      const existingDoc = snapshot.docs[0].data();
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: 'This mobile number has already been registered.',
          details: {
            registrationId: existingDoc.registrationId,
            name: existingDoc.name,
            firmName: existingDoc.firmName,
            phone: existingDoc.phone,
            profileImageUrl: existingDoc.profileImageUrl,
            attendance: existingDoc.attendance,
          }
        }),
      };
    }

    // 3. Get a new sequential registration ID using a Firestore Transaction
    const counterRef = db.collection('counters').doc('registrations');
    let nextId;

    await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      if (!counterDoc.exists) {
        nextId = 1;
        transaction.set(counterRef, { count: nextId });
      } else {
        nextId = counterDoc.data().count + 1;
        transaction.update(counterRef, { count: FieldValue.increment(1) });
      }
    });

    const registrationId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    // 4. Upload images to Cloudinary
    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025")
    ]);

    // 5. Save the new registration to Firestore (Primary Write)
    const newRegistrationData = {
      registrationId,
      name,
      phone,
      firmName,
      address,
      district,
      state,
      attendance,
      paymentScreenshotUrl: uploadPaymentResponse.secure_url,
      profileImageUrl: uploadProfileResponse.secure_url,
      createdAt: FieldValue.serverTimestamp()
    };

    await registrationsRef.doc(phone).set(newRegistrationData);

    // --- 6. Sync to Google Sheets (Secondary Write) ---
    // This is wrapped in a try/catch so a failure here does not break the registration.
    try {
      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Registrations!A1', // Append to the sheet
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            registrationId,
            name,
            phone,
            firmName,
            address,
            district,
            state,
            attendance,
            newRegistrationData.paymentScreenshotUrl,
            newRegistrationData.profileImageUrl,
          ]],
        },
      });
    } catch (sheetError) {
      // Log the error but don't stop the function. The user has been registered successfully in Firestore.
      console.error('GOOGLE_SHEET_SYNC_ERROR:', sheetError.message);
    }

    // --- 7. Return a successful response to the user ---
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationId,
        name,
        phone,
        firmName,
        profileImageUrl: newRegistrationData.profileImageUrl,
        attendance: attendance,
      }),
    };

  } catch (error) {
    console.error('REGISTRATION_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An unexpected error occurred. Details: ${error.message}` }),
    };
  }
};

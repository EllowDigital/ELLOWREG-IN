// This is the final, production-ready version of the backend function.
// It is optimized for performance to prevent timeouts and handles all operations reliably.

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');

// --- Helper Functions (No changes needed) ---
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
    const fields = {};
    const files = {};
    const bb = busboy({
      headers: event.headers,
      limits: { fileSize: 5 * 1024 * 1024 } // 5MB
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
      file.on('limit', () => reject(new Error(`File "${filename}" is too large.`)));
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
    cloudinary.uploader.upload_stream({ folder: folderName }, (error, result) => {
      if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
      resolve(result);
    }).end(fileBuffer);
  });
};

// --- Initialization Block (Cached for performance) ---
let firebaseApp;
let googleAuth;

if (!global._firebaseApp) {
  const firebaseCredsPath = path.join(__dirname, 'firebase-credentials.json');
  const googleCredsPath = path.join(__dirname, 'google-credentials.json');

  if (!fs.existsSync(firebaseCredsPath) || !fs.existsSync(googleCredsPath)) {
    throw new Error('Credential files not found. Ensure the build script ran successfully.');
  }

  const serviceAccount = require(firebaseCredsPath);
  const googleKey = require(googleCredsPath);

  global._firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  global._googleAuth = new google.auth.GoogleAuth({
    credentials: googleKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

firebaseApp = global._firebaseApp;
googleAuth = global._googleAuth;
const db = getFirestore(firebaseApp);


// --- Separate Function for Google Sheets Sync ---
// This allows the main handler to finish quickly without waiting for the slow sheet sync.
const syncToGoogleSheets = async (data) => {
    try {
        const sheets = google.sheets({ version: 'v4', auth: googleAuth });
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: 'Registrations!A1',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                    data.registrationId, data.name, data.phone, data.firmName, data.address,
                    data.district, data.state, data.attendance,
                    data.paymentScreenshotUrl, data.profileImageUrl
                ]],
            },
        });
        console.log('SUCCESS: Synced registration to Google Sheets for:', data.phone);
    } catch (sheetError) {
        // If Sheets fails, log the error but don't crash the main process.
        console.error('ERROR: Google Sheets sync failed for:', data.phone, sheetError.message);
    }
};


// --- Main Handler ---
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage, paymentScreenshot } = files;

    if (!name || !phone || !firmName || !address || !district || !state || !attendance || !profileImage || !paymentScreenshot) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
    }

    // --- Optimization: Run duplicate check and image uploads in parallel ---
    const registrationsRef = db.collection('registrations');
    
    const [snapshot, uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
        registrationsRef.where('phone', '==', phone).limit(1).get(),
        uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
        uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025")
    ]);

    if (!snapshot.empty) {
        const existingDoc = snapshot.docs[0].data();
        return { statusCode: 409, body: JSON.stringify({ error: 'Mobile number already registered.', details: existingDoc }) };
    }

    // --- Firestore Transaction for Unique ID (must be sequential) ---
    const counterRef = db.collection('counters').doc('registrations');
    let nextId;
    await db.runTransaction(async (transaction) => {
        const counterDoc = await transaction.get(counterRef);
        nextId = (counterDoc.exists ? counterDoc.data().count : 0) + 1;
        transaction.set(counterRef, { count: nextId }, { merge: true });
    });
    const registrationId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    // --- Final Data Assembly & Primary Save ---
    const newRegistrationData = {
      registrationId, name, phone, firmName, address, district, state, attendance,
      paymentScreenshotUrl: uploadPaymentResponse.secure_url,
      profileImageUrl: uploadProfileResponse.secure_url,
      createdAt: FieldValue.serverTimestamp()
    };
    await registrationsRef.doc(phone).set(newRegistrationData);
    
    // --- Final Fix: Return Response BEFORE waiting for Sheets ---
    // This makes the user experience instant and prevents timeouts.
    const responseData = {
        registrationId, name, phone, firmName, attendance,
        profileImageUrl: newRegistrationData.profileImageUrl
    };
    
    // Sync to sheets in the background without making the user wait.
    syncToGoogleSheets(newRegistrationData);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responseData),
    };

  } catch (error) {
    console.error('FATAL_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `A critical error occurred: ${error.message}` }),
    };
  }
};

// This script runs during the Netlify build process.
// It decodes Base64 environment variables and writes them to your specific function directory.
const fs = require('fs');
const path = require('path');

// This path points to your custom functions directory structure.
// Netlify runs this script from the root, so the path must be correct.
const functionDir = path.join(__dirname, 'functions/submit-registration');

console.log(`Attempting to write credential files to: ${functionDir}`);

// Ensure the target directory exists before trying to write to it.
// The 'recursive: true' option creates parent directories if they don't exist.
try {
    if (!fs.existsSync(functionDir)) {
        fs.mkdirSync(functionDir, { recursive: true });
        console.log('Function directory created successfully.');
    }
} catch (error) {
    console.error(`Failed to create directory: ${error.message}`);
    process.exit(1); // Exit with an error code to fail the build.
}


// Check for and write Firebase credentials
if (process.env.FIREBASE_CREDENTIALS_B64) {
    const firebaseCreds = Buffer.from(process.env.FIREBASE_CREDENTIALS_B64, 'base64').toString('utf-8');
    fs.writeFileSync(path.join(functionDir, 'firebase-credentials.json'), firebaseCreds);
    console.log('Successfully created firebase-credentials.json');
} else {
    console.error('ERROR: FIREBASE_CREDENTIALS_B64 environment variable not found!');
    process.exit(1); // Fail the build if the variable is missing.
}

// Check for and write Google Sheets credentials
if (process.env.GOOGLE_CREDENTIALS_B64) {
    const googleCreds = Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf-8');
    fs.writeFileSync(path.join(functionDir, 'google-credentials.json'), googleCreds);
    console.log('Successfully created google-credentials.json');
} else {
    console.error('ERROR: GOOGLE_CREDENTIALS_B64 environment variable not found!');
    process.exit(1); // Fail the build if the variable is missing.
}

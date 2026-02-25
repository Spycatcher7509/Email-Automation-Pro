// Optional lightweight signing hook for Electron Builder.
// - On macOS, set SIGN_MAC=1 to apply ad-hoc signing so the app runs without “unidentified developer”.
// - If you provide real certificates via CSC_LINK/CSC_KEY_PASSWORD or Apple ID env vars,
//   electron-builder will handle full signing/notarization automatically.

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  const { appOutDir, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  if (!process.env.SIGN_MAC) {
    console.log('[after-sign] SIGN_MAC not set; skipping ad-hoc signing.');
    return;
  }

  const appPath = path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[after-sign] Ad-hoc signing ${appPath}`);

  try {
    execSync(
      `codesign --deep --force --timestamp --options runtime --sign - "${appPath}"`,
      { stdio: 'inherit' }
    );
    console.log('[after-sign] Ad-hoc signing complete.');
  } catch (err) {
    console.error('[after-sign] Signing failed:', err);
    throw err;
  }
};

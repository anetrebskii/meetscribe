# Chrome Web Store Publish — Setup

The CD workflow automatically publishes to the Chrome Web Store on every push to `main`.

## Required Secrets

Add these in `Settings > Secrets and variables > Actions`:

| Secret               | Description                                      |
| -------------------- | ------------------------------------------------ |
| `CWS_CLIENT_ID`      | OAuth2 client ID from Google Cloud Console       |
| `CWS_CLIENT_SECRET`  | OAuth2 client secret                             |
| `CWS_REFRESH_TOKEN`  | OAuth2 refresh token                             |
| `CWS_EXTENSION_ID`   | Extension ID from the Chrome Web Store dashboard |

## Getting OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Chrome Web Store API** under `APIs & Services > Library`
4. Go to `APIs & Services > Credentials`
5. Create an **OAuth 2.0 Client ID** (application type: Desktop app)
6. Note the **Client ID** and **Client Secret**

## Getting a Refresh Token

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon (top right), check **Use your own OAuth credentials**
3. Enter your Client ID and Client Secret
4. In Step 1, enter scope: `https://www.googleapis.com/auth/chromewebstore`
5. Click **Authorize APIs** and sign in with the Google account that owns the extension
6. In Step 2, click **Exchange authorization code for tokens**
7. Copy the **Refresh token**

## Getting the Extension ID

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Select your extension
3. The extension ID is in the URL and on the extension details page

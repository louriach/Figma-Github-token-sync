/**
 * GitHub Device Flow OAuth (RFC 8628)
 *
 * Lets users authenticate without copying tokens. The plugin shows a short
 * code; the user approves it on github.com/login/device in their browser.
 *
 * Requires a GitHub OAuth App with Device Flow enabled:
 *   github.com/settings/developers → OAuth Apps → your app → Enable Device Flow
 *
 * The client_id is public — it is NOT a secret and is safe to commit.
 */

// Register your OAuth App at github.com/settings/developers and paste the
// client_id here. Scope requested: "repo" (read/write repository contents).
export const GITHUB_CLIENT_ID = 'YOUR_OAUTH_APP_CLIENT_ID';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const SCOPE = 'repo';

export interface DeviceCodeResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;   // seconds
  interval: number;    // minimum polling interval in seconds
}

export interface PollResult {
  token: string;
}

export async function requestDeviceCode(): Promise<DeviceCodeResult> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: SCOPE }),
  });

  if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status} ${res.statusText}`);

  const data = await res.json();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

/**
 * Polls GitHub until the user approves or the code expires.
 * Pass an AbortSignal to cancel (e.g. when the user clicks Cancel).
 */
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  signal: AbortSignal
): Promise<PollResult> {
  let currentInterval = intervalSeconds;

  while (!signal.aborted) {
    await delay(currentInterval * 1000);
    if (signal.aborted) break;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal,
    });

    const data = await res.json();

    if (data.access_token) return { token: data.access_token };

    switch (data.error) {
      case 'authorization_pending':
        break; // still waiting — keep polling
      case 'slow_down':
        currentInterval += 5; // GitHub asked us to back off
        break;
      case 'expired_token':
        throw new Error('The code expired. Please try again.');
      case 'access_denied':
        throw new Error('Access was denied.');
      default:
        if (data.error) throw new Error(data.error_description ?? data.error);
    }
  }

  throw new Error('Cancelled');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { describe, expect, it } from 'bun:test';
import { deviceVerificationUrl, type DeviceAuthorization } from '../../src/auth/pairing/deviceAuth';

const authorization = (complete?: string): DeviceAuthorization => ({
  device_code: 'device-code-not-for-display',
  user_code: 'RJXN-HMFW',
  verification_uri: 'https://auth.example.invalid/device',
  ...(complete === undefined ? {} : { verification_uri_complete: complete }),
  expires_in: 300,
  interval: 5,
});

describe('deviceVerificationUrl', () => {
  it('prefers the WorkOS URL that opens with the user code prefilled', () => {
    const complete = 'https://auth.example.invalid/device?user_code=RJXN-HMFW';

    expect(deviceVerificationUrl(authorization(complete))).toBe(complete);
  });

  it('retains the bare verification URL as a compatibility fallback', () => {
    expect(deviceVerificationUrl(authorization())).toBe('https://auth.example.invalid/device');
    expect(deviceVerificationUrl(authorization('   '))).toBe('https://auth.example.invalid/device');
  });
});

import { describe, expect, it } from 'vitest';

import { parseConnectPayload } from './parseConnectPayload';

describe('parseConnectPayload', () => {
  it('extracts the server and token from a #login= URL', () => {
    expect(
      parseConnectPayload(
        'https://intercom.example.org/#login=EXAMPLE_LOGIN_TOKEN',
      ),
    ).toEqual({
      serverAddress: 'https://intercom.example.org',
      token: 'EXAMPLE_LOGIN_TOKEN',
    });
  });

  it('treats the admin portal QR as a server address', () => {
    expect(parseConnectPayload('https://intercom.example.org')).toEqual({
      serverAddress: 'https://intercom.example.org',
    });
  });

  it('reads a token from the query string', () => {
    expect(parseConnectPayload('https://intercom.local:8443/?login=abcDEF1234567890')).toEqual({
      serverAddress: 'https://intercom.local:8443',
      token: 'abcDEF1234567890',
    });
  });

  it('reads a hash-only login fragment', () => {
    expect(parseConnectPayload('#login=abcDEF1234567890')).toEqual({
      token: 'abcDEF1234567890',
    });
  });

  it('treats a long token without a host as a login token', () => {
    expect(parseConnectPayload('EXAMPLE_LOGIN_TOKEN')).toEqual({
      token: 'EXAMPLE_LOGIN_TOKEN',
    });
  });

  it('returns empty for blank input', () => {
    expect(parseConnectPayload('   ')).toEqual({});
  });

  it('does not adopt an http URL', () => {
    expect(parseConnectPayload('http://intercom.local:8443/#login=abcDEF1234567890')).toEqual({});
  });
});

import { describe, expect, test } from 'bun:test';
import {
  backupsToPrune,
  base64UrlEncode,
  buildAuthUrl,
  buildMultipartBody,
  parseRedirect,
  pkceChallenge,
  sha256,
  toHex,
  utf8Bytes,
} from '../src/utils/oauthPkce';

const hex = (text: string) => toHex(sha256(utf8Bytes(text)));

describe('sha256', () => {
  test('matches the standard test vectors', () => {
    expect(hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  test('handles inputs that span several blocks', () => {
    expect(hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  test('encodes non-ASCII text as UTF-8', () => {
    expect([...utf8Bytes('é')]).toEqual([0xc3, 0xa9]);
    expect([...utf8Bytes('ሀ')]).toEqual([0xe1, 0x88, 0x80]);
    expect([...utf8Bytes('😁')]).toEqual([0xf0, 0x9f, 0x98, 0x81]);
    expect(hex('ሀ😁')).toBe(new Bun.CryptoHasher('sha256').update('ሀ😁').digest('hex'));
  });
});

describe('PKCE', () => {
  test('base64url has no padding or unsafe characters', () => {
    expect(base64UrlEncode(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    expect(base64UrlEncode(Uint8Array.from([1]))).toBe('AQ');
    expect(base64UrlEncode(utf8Bytes('abc'))).toBe('YWJj');
  });

  test('S256 challenge matches the RFC 7636 example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('auth URL asks only for the app data scope with offline access', () => {
    const url = new URL(
      buildAuthUrl({ clientId: 'id.apps.googleusercontent.com', redirectUri: 'com.hisab.budget:/oauth2redirect', verifier: 'v'.repeat(43), state: 'xyz' }),
    );
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.appdata');
    expect(url.searchParams.get('redirect_uri')).toBe('com.hisab.budget:/oauth2redirect');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge('v'.repeat(43)));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('xyz');
  });

  test('parses the redirect back into the app', () => {
    expect(parseRedirect('com.hisab.budget:/oauth2redirect?state=abc&code=4%2F0Ab_x&scope=x')).toEqual({
      code: '4/0Ab_x',
      state: 'abc',
      error: null,
    });
    expect(parseRedirect('com.hisab.budget:/oauth2redirect?error=access_denied&state=abc#')).toEqual({
      code: null,
      state: 'abc',
      error: 'access_denied',
    });
    expect(parseRedirect('com.hisab.budget:/oauth2redirect')).toEqual({ code: null, state: null, error: null });
  });
});

describe('Drive helpers', () => {
  test('multipart body holds metadata then content', () => {
    const body = buildMultipartBody({ name: 'a.json' }, '{"x":1}', 'application/json', 'B');
    expect(body).toBe(
      '--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.json"}\r\n--B\r\nContent-Type: application/json\r\n\r\n{"x":1}\r\n--B--\r\n',
    );
  });

  test('prunes everything past the newest keepCount backups', () => {
    const files = [
      { id: 'b', createdTime: '2026-01-02T00:00:00Z' },
      { id: 'd', createdTime: '2026-01-04T00:00:00Z' },
      { id: 'a', createdTime: '2026-01-01T00:00:00Z' },
      { id: 'c', createdTime: '2026-01-03T00:00:00Z' },
    ];
    expect(backupsToPrune(files, 2).map((f) => f.id)).toEqual(['b', 'a']);
    expect(backupsToPrune(files, 10)).toEqual([]);
    // Always keeps at least the newest one.
    expect(backupsToPrune(files, 0).map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateDestinationUrl, isPrivateOrReservedIp } from '../ssrf.js';
import { generateSlug } from '../slug.js';

describe('validateDestinationUrl (SSRF Guard)', () => {
  const originalEnv = process.env.ALLOW_LOCAL_DESTINATION;

  beforeEach(() => {
    delete process.env.ALLOW_LOCAL_DESTINATION;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ALLOW_LOCAL_DESTINATION = originalEnv;
    } else {
      delete process.env.ALLOW_LOCAL_DESTINATION;
    }
  });

  it('rejects loopback IPv4 (127.0.0.1)', async () => {
    const valid = await validateDestinationUrl('http://127.0.0.1:8000/webhook');
    expect(valid).toBe(false);
  });

  it('rejects private IPv4 (10.0.0.1)', async () => {
    const valid = await validateDestinationUrl('http://10.0.0.1/api/receive');
    expect(valid).toBe(false);
  });

  it('rejects link-local / cloud-metadata IPv4 (169.254.169.254)', async () => {
    const valid = await validateDestinationUrl('http://169.254.169.254/latest/meta-data');
    expect(valid).toBe(false);
  });

  it('rejects IPv6 loopback (::1)', async () => {
    const valid = await validateDestinationUrl('http://[::1]:3000/hook');
    expect(valid).toBe(false);
  });

  it('rejects localhost and localhost subdomains', async () => {
    expect(await validateDestinationUrl('http://localhost:3000')).toBe(false);
    expect(await validateDestinationUrl('http://api.localhost:4000/webhook')).toBe(false);
  });

  it('rejects non-http/https protocols', async () => {
    expect(await validateDestinationUrl('ftp://example.com/file')).toBe(false);
    expect(await validateDestinationUrl('file:///etc/passwd')).toBe(false);
    expect(await validateDestinationUrl('gopher://example.com')).toBe(false);
  });

  it('accepts valid public HTTP/HTTPS URLs', async () => {
    const validHttps = await validateDestinationUrl('https://example.com/webhook');
    expect(validHttps).toBe(true);

    const validHttp = await validateDestinationUrl('http://example.com/events');
    expect(validHttp).toBe(true);
  });
});

describe('isPrivateOrReservedIp helper', () => {
  it('flags 192.168.1.1 and 172.16.0.1 as private', () => {
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.5.10')).toBe(true);
    expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedIp('172.32.0.1')).toBe(false);
  });

  it('flags IPv4-mapped IPv6 loopback as private', () => {
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows public IPv4 addresses', () => {
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
  });
});

describe('generateSlug', () => {
  it('generates a 12-character URL-safe string by default', () => {
    const slug = generateSlug();
    expect(slug).toHaveLength(12);
    // Base64url characters: A-Z, a-z, 0-9, -, _
    expect(/^[A-Za-z0-9_-]{12}$/.test(slug)).toBe(true);
  });

  it('generates unique slugs across multiple iterations', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      slugs.add(generateSlug());
    }
    expect(slugs.size).toBe(1000);
  });
});

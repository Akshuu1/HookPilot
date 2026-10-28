import dns from 'node:dns';
import net from 'node:net';

/**
 * Checks whether an IP address belongs to private, loopback, link-local,
 * cloud-metadata, or reserved ranges (both IPv4 and IPv6).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  // Check for IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    const ipv4Part = ip.slice(7);
    if (ipv4Part.includes('.')) {
      return isPrivateOrReservedIp(ipv4Part);
    }
  }

  // IPv4 range checks
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }

    const [b0, b1] = parts;
    if (b0 === undefined || b1 === undefined) return true;

    // 0.0.0.0/8 (Broadcast/Current network)
    if (b0 === 0) return true;
    // 10.0.0.0/8 (Private RFC1918)
    if (b0 === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;
    // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Cloud Metadata 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;
    // 172.16.0.0/12 (Private RFC1918: 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 (Private RFC1918)
    if (b0 === 192 && b1 === 168) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (b0 >= 224) return true;

    return false;
  }

  // IPv6 range checks
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // Loopback (::1)
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    // Unspecified (::)
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
    // Link-local unicast (fe80::/10 -> fe80 to febf)
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }
    // Unique Local Address (fc00::/7 -> fc00 to fdff)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true;
    }

    return false;
  }

  // If not valid IPv4 or IPv6, treat as unsafe
  return true;
}

/**
 * Validates destination URLs against SSRF:
 * - Protocol must be http or https only.
 * - Rejects localhost and .localhost domains.
 * - Resolves DNS and blocks private, loopback, link-local, and cloud metadata IPs.
 */
export async function validateDestinationUrl(urlStr: string): Promise<boolean> {
  try {
    const parsed = new URL(urlStr);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return false;
    }

    // Direct IP check (e.g. http://127.0.0.1:8000 or http://[::1]/)
    // Strip brackets from IPv6 hostnames like [::1]
    const cleanHost = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(cleanHost)) {
      return !isPrivateOrReservedIp(cleanHost);
    }

    // Resolve DNS records
    const records = await dns.promises.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return false;
    }

    // Ensure none of the resolved IPs belong to restricted networks
    for (const record of records) {
      if (isPrivateOrReservedIp(record.address)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

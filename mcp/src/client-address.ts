import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

// Normalize textual aliases, mapped IPv4 and IPv6 privacy addresses before
// assigning a budget. An IPv6 /64 is one caller, as on the backend API.
export function clientKey(address: string): string | null {
  const version = isIP(address);
  if (!version || address.includes('%')) return null;
  if (version === 4) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, tail = ''] = canonical.split('::');
  const first = head ? head.split(':') : [], last = tail ? tail.split(':') : [];
  const groups = canonical.includes('::') ? [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last] : first;
  const words = groups.map(group => Number.parseInt(group, 16));
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 65535) {
    return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join('.');
  }
  return groups.slice(0, 4).map(group => group.padStart(4, '0')).join(':') + '::/64';
}

export function proxyList(value = ''): BlockList {
  const list = new BlockList();
  if (!value.trim()) return list;
  for (const entry of value.split(',').map(part => part.trim())) {
    const [address = '', prefix, extra] = entry.split('/'), version = isIP(address);
    if (!version || address.includes('%') || extra !== undefined || (prefix !== undefined &&
      (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (version === 6 ? 128 : 32)))) {
      throw new Error('Invalid MCP_TRUSTED_PROXY_ADDRESSES');
    }
    if (prefix === undefined) list.addAddress(address, version === 6 ? 'ipv6' : 'ipv4');
    else list.addSubnet(address, Number(prefix), version === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

export function clientAddress(request: IncomingMessage, proxies: BlockList): string | null {
  const peer = request.socket.remoteAddress ?? '';
  const key = clientKey(peer);
  if (!key) return null;
  const address = isIP(key) === 4 ? key : peer;
  if (!proxies.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')) return key;
  // Only a configured proxy that overwrites X-Real-IP may supply identity.
  // Missing, duplicate or malformed headers fail closed; X-Forwarded-For is ignored.
  const forwarded = request.headers['x-real-ip'];
  return typeof forwarded === 'string' ? clientKey(forwarded) : null;
}

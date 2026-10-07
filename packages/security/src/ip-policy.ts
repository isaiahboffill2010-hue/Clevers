import { isIP } from "node:net";

export type IpCategory =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "multicast"
  | "unspecified"
  | "carrier-grade-nat"
  | "reserved";

export interface IpClassification {
  address: string;
  version: 4 | 6;
  category: IpCategory;
  isPublic: boolean;
}

export function classifyIpAddress(input: string): IpClassification | undefined {
  const address = stripIpv6Brackets(input.trim());
  const version = isIP(address);
  if (version === 4) return classifyIpv4(address);
  if (version === 6) return classifyIpv6(address);
  return undefined;
}

function classifyIpv4(address: string): IpClassification {
  const value = ipv4ToNumber(address);
  const category = classifyIpv4Value(value);
  return { address, version: 4, category, isPublic: category === "public" };
}

function classifyIpv4Value(value: number): IpCategory {
  if (inIpv4Range(value, "0.0.0.0", 8)) return value === 0 ? "unspecified" : "reserved";
  if (inIpv4Range(value, "10.0.0.0", 8)) return "private";
  if (inIpv4Range(value, "100.64.0.0", 10)) return "carrier-grade-nat";
  if (inIpv4Range(value, "127.0.0.0", 8)) return "loopback";
  if (inIpv4Range(value, "169.254.0.0", 16)) return "link-local";
  if (inIpv4Range(value, "172.16.0.0", 12)) return "private";
  if (inIpv4Range(value, "192.0.0.0", 24)) return "reserved";
  if (inIpv4Range(value, "192.0.2.0", 24)) return "reserved";
  if (inIpv4Range(value, "192.88.99.0", 24)) return "reserved";
  if (inIpv4Range(value, "192.168.0.0", 16)) return "private";
  if (inIpv4Range(value, "198.18.0.0", 15)) return "reserved";
  if (inIpv4Range(value, "198.51.100.0", 24)) return "reserved";
  if (inIpv4Range(value, "203.0.113.0", 24)) return "reserved";
  if (inIpv4Range(value, "224.0.0.0", 4)) return "multicast";
  if (inIpv4Range(value, "240.0.0.0", 4)) return "reserved";
  return "public";
}

function classifyIpv6(address: string): IpClassification {
  const words = parseIpv6(address);
  const [word0 = 0, word1 = 0] = words;
  const mappedIpv4 = ipv4MappedValue(words);
  if (mappedIpv4 !== undefined) {
    const category = classifyIpv4Value(mappedIpv4);
    return { address, version: 6, category, isPublic: category === "public" };
  }

  let category: IpCategory = "public";
  if (words.every((word) => word === 0)) category = "unspecified";
  else if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) category = "loopback";
  else if ((word0 & 0xfe00) === 0xfc00) category = "private";
  else if ((word0 & 0xffc0) === 0xfe80) category = "link-local";
  else if ((word0 & 0xff00) === 0xff00) category = "multicast";
  else if (word0 === 0x2001 && word1 === 0x0db8) category = "reserved";

  return { address, version: 6, category, isPublic: category === "public" };
}

function parseIpv6(address: string): number[] {
  const zoneIndex = address.indexOf("%");
  const withoutZone = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  const [left = "", right = ""] = withoutZone.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const convert = (parts: string[]): number[] =>
    parts.flatMap((part) => {
      if (part.includes(".")) {
        const value = ipv4ToNumber(part);
        return [(value >>> 16) & 0xffff, value & 0xffff];
      }
      return [Number.parseInt(part, 16)];
    });
  const leftWords = convert(leftParts);
  const rightWords = convert(rightParts);
  const missing = 8 - leftWords.length - rightWords.length;
  return [...leftWords, ...Array.from({ length: Math.max(0, missing) }, () => 0), ...rightWords];
}

function ipv4MappedValue(words: number[]): number | undefined {
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (!mapped) return undefined;
  const word6 = words[6] ?? 0;
  const word7 = words[7] ?? 0;
  return ((word6 << 16) | word7) >>> 0;
}

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4ToNumber(base);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (baseValue & mask) >>> 0;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

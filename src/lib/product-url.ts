/**
 * Builds the product link that goes under every alert, so the number in the
 * message can be checked against the real page in one tap.
 *
 * Both parts come from the extension, so both are validated: anything that is
 * not a plain hostname and a plain ASIN yields no link rather than a broken or
 * unsafe one.
 */

const HOSTNAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ASIN_RE = /^[A-Za-z0-9]{6,16}$/;

/** `https://www.amazon.de` -> `amazon.de`, `AMAZON.DE/` -> `amazon.de`. */
export function normaliseDomain(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  if (!host || !HOSTNAME_RE.test(host)) return null;
  return host;
}

export function productUrl(asin: string | null | undefined, domain: string | null | undefined): string | null {
  const host = normaliseDomain(domain);
  if (!host) return null;
  if (typeof asin !== 'string') return null;
  const code = asin.trim();
  if (!ASIN_RE.test(code)) return null;
  return `https://www.${host}/dp/${code}`;
}

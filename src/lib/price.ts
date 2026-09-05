/**
 * Price and stock parsing.
 *
 * Prices arrive from the extension as display strings ("$29.99", "1.234,56 €",
 * "£12.00"), so every comparison has to go through a numeric parse first —
 * comparing the strings directly is what made price-drop alerts unreliable.
 */

const CURRENCY_SYMBOLS = ['$', '€', '£', '₼', '₺', '¥', '₽', '₹', 'USD', 'EUR', 'GBP', 'AZN', 'TRY'];

/**
 * Parses a displayed price into a number, understanding both `1,234.56` and
 * `1.234,56` grouping. Returns null when there is no number in the string.
 */
export function parsePrice(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  // Drop everything that cannot belong to a number, including non-breaking spaces.
  const cleaned = raw.replace(/[\s  ]/g, '').replace(/[^0-9.,-]/g, '');
  if (cleaned === '' || !/[0-9]/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalised: string;

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal separator.
    const decimalAt = Math.max(lastDot, lastComma);
    const intPart = cleaned.slice(0, decimalAt).replace(/[.,]/g, '');
    const decPart = cleaned.slice(decimalAt + 1).replace(/[.,]/g, '');
    normalised = `${intPart}.${decPart}`;
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sepAt = lastDot !== -1 ? lastDot : lastComma;
    const separator = cleaned[sepAt] as string;
    const decPart = cleaned.slice(sepAt + 1);
    const occurrences = cleaned.split(separator).length - 1;
    // "1.234" / "1,234" with exactly three trailing digits is grouping, not decimals.
    const isGrouping = occurrences > 1 || (decPart.length === 3 && cleaned.slice(0, sepAt).replace('-', '').length <= 3);
    normalised = isGrouping
      ? cleaned.replace(/[.,]/g, '')
      : `${cleaned.slice(0, sepAt).replace(/[.,]/g, '')}.${decPart}`;
  } else {
    normalised = cleaned;
  }

  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/** Currency marker of a displayed price, so deltas can be rendered in the same currency. */
export function currencyOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const symbol of CURRENCY_SYMBOLS) {
    if (raw.includes(symbol)) return symbol;
  }
  return null;
}

/**
 * Renders an absolute amount the way the sample price is written: same currency
 * marker, same side, same decimal separator.
 */
export function formatAmount(amount: number, like: string | null | undefined): string {
  const symbol = currencyOf(like);
  const usesComma = typeof like === 'string' && /\d,\d{1,2}(\D|$)/.test(like);
  const digits = amount.toFixed(2);
  const body = usesComma ? digits.replace('.', ',') : digits;

  if (!symbol) return body;
  const symbolLeads = typeof like === 'string' && like.trimStart().startsWith(symbol);
  return symbolLeads ? `${symbol}${body}` : `${body} ${symbol}`;
}

export type StockState = 'in_stock' | 'out_of_stock' | 'unknown';

/**
 * Checked before the positive hints, so "out of stock" is never read as "stock"
 * and "nicht verfügbar" is never read as "verfügbar". Amazon serves the
 * availability text in the marketplace's own language, so the domains this
 * project watches are all covered.
 */
const OUT_OF_STOCK_HINTS = [
  // en
  'out of stock',
  'out_of_stock',
  'outofstock',
  'unavailable',
  'not available',
  'sold out',
  'soldout',
  'no stock',
  'nostock',
  'currently unavailable',
  // az
  'stokda yoxdur',
  'yoxdur',
  'bitib',
  // tr
  'stokta yok',
  'tükendi',
  // de
  'nicht verfügbar',
  'nicht auf lager',
  'derzeit nicht',
  'ausverkauft',
  // ru
  'нет в наличии',
  'нет на складе',
  'закончился',
  // fr / es / it
  'non disponible',
  'rupture de stock',
  'no disponible',
  'agotado',
  'non disponibile',
  'esaurito',
];

const IN_STOCK_HINTS = [
  // en
  'in stock',
  'in_stock',
  'instock',
  'available',
  // az
  'stokda var',
  'stokda',
  'mövcuddur',
  'var',
  // tr
  'stokta',
  // de
  'auf lager',
  'verfügbar',
  'lieferbar',
  // ru
  'в наличии',
  'на складе',
  // fr / es / it
  'en stock',
  'disponible',
  'disponibile',
];

/** Reads the availability text alone; null when it says nothing recognisable. */
function stateFromStatus(status: string | null | undefined): StockState | null {
  if (typeof status !== 'string') return null;
  const normalised = status.trim().toLowerCase().replace(/[-_]+/g, ' ');
  if (normalised === '') return null;

  if (normalised === 'false' || normalised === '0' || normalised === 'no') return 'out_of_stock';
  if (normalised === 'true' || normalised === '1' || normalised === 'yes') return 'in_stock';
  if (OUT_OF_STOCK_HINTS.some((hint) => normalised.includes(hint.replace(/[-_]+/g, ' ')))) return 'out_of_stock';
  if (IN_STOCK_HINTS.some((hint) => normalised.includes(hint.replace(/[-_]+/g, ' ')))) return 'in_stock';
  return null;
}

/**
 * Works out whether a product is buyable from whatever the extension reported.
 *
 * The availability TEXT wins, because that is what the page actually says. The
 * quantity only decides when the text is missing or unrecognisable: a count is
 * frequently absent from the page, and a client that cannot read one tends to
 * send 0 — trusting that number over an explicit "in stock" produced false
 * "out of stock" alerts.
 */
export function stockStateOf(status: string | null | undefined, quantity: number | null | undefined): StockState {
  const fromStatus = stateFromStatus(status);
  if (fromStatus !== null) return fromStatus;

  if (typeof quantity === 'number' && Number.isFinite(quantity)) {
    return quantity > 0 ? 'in_stock' : 'out_of_stock';
  }

  return 'unknown';
}

/** A count worth showing: a real, positive number. Anything else is "unknown". */
export function usableQuantity(quantity: number | null | undefined): number | null {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  return Math.trunc(quantity);
}

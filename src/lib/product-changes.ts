import type { ProductInput } from '../db/repo';
import type { ProductRow } from '../db/types';
import { currencyOf, parsePrice, stockStateOf, usableQuantity, type StockState } from './price';

/**
 * Diffing a stored product against the state the extension just reported.
 * Pure functions only: the caller decides what to do with the events.
 */

export interface ProductIdentity {
  asin: string;
  domain: string;
  name: string | null;
}

export interface PriceChange {
  kind: 'price';
  product: ProductIdentity;
  oldPrice: string;
  newPrice: string;
  oldValue: number;
  newValue: number;
  /** Positive when the price went up, negative when it dropped. */
  delta: number;
  /** False when the two prices are quoted in different currencies, which makes the delta meaningless. */
  comparable: boolean;
  direction: 'up' | 'down';
  /** Current stock, for context in the message. */
  stock: StockState;
  quantity: number | null;
}

export interface StockChange {
  kind: 'back_in_stock' | 'out_of_stock';
  product: ProductIdentity;
  quantity: number | null;
  price: string | null;
}

export interface QuantityChange {
  kind: 'quantity';
  product: ProductIdentity;
  oldQuantity: number;
  newQuantity: number;
  direction: 'up' | 'down';
  /** True when the new quantity sits at or below the user's threshold. */
  belowThreshold: boolean;
  threshold: number | null;
  price: string | null;
}

export type ProductChange = PriceChange | StockChange | QuantityChange;

/** Prices are money, so a sub-cent difference is noise, not a change. */
const PRICE_EPSILON = 0.005;

function identityOf(previous: ProductRow, next: ProductInput): ProductIdentity {
  return { asin: next.asin, domain: next.domain, name: next.name ?? previous.name };
}

/**
 * Compares the stored row with the incoming state and returns everything the
 * user should be told about.
 *
 * Both prices are converted with `parsePrice` before comparison — string
 * comparison is why "$9.99" -> "$10.50" could look like a drop and why some
 * drops produced no alert at all.
 */
export function diffProduct(previous: ProductRow, next: ProductInput): ProductChange[] {
  const changes: ProductChange[] = [];
  const product = identityOf(previous, next);

  const previousStock = stockStateOf(previous.last_status, previous.last_quantity);
  const nextStock = stockStateOf(next.status, next.quantity);

  // --- stock transitions --------------------------------------------------
  if (previousStock === 'out_of_stock' && nextStock === 'in_stock') {
    changes.push({ kind: 'back_in_stock', product, quantity: next.quantity, price: next.price });
  } else if (previousStock === 'in_stock' && nextStock === 'out_of_stock') {
    changes.push({ kind: 'out_of_stock', product, quantity: next.quantity, price: next.price });
  } else if (previousStock === 'in_stock' && nextStock === 'in_stock') {
    // Only real counts are compared. A 0 (or a missing number) means "no count
    // reported", not "none left" — reporting "12 -> 0" from that would be wrong.
    const oldQuantity = usableQuantity(previous.last_quantity);
    const newQuantity = usableQuantity(next.quantity);

    if (oldQuantity !== null && newQuantity !== null && oldQuantity !== newQuantity) {
      changes.push({
        kind: 'quantity',
        product,
        oldQuantity,
        newQuantity,
        direction: newQuantity > oldQuantity ? 'up' : 'down',
        belowThreshold: typeof next.threshold === 'number' && newQuantity <= next.threshold,
        threshold: next.threshold,
        price: next.price,
      });
    }
  }

  // --- price change (either direction) ------------------------------------
  const oldValue = parsePrice(previous.last_price);
  const newValue = parsePrice(next.price);
  if (
    oldValue !== null &&
    newValue !== null &&
    previous.last_price !== null &&
    next.price !== null &&
    Math.abs(newValue - oldValue) > PRICE_EPSILON
  ) {
    // A switch of currency (a different marketplace, a changed locale) makes the
    // subtraction meaningless, so the change is still reported but without a delta.
    const oldCurrency = currencyOf(previous.last_price);
    const newCurrency = currencyOf(next.price);
    const comparable = oldCurrency === null || newCurrency === null || oldCurrency === newCurrency;

    changes.push({
      kind: 'price',
      product,
      oldPrice: previous.last_price,
      newPrice: next.price,
      oldValue,
      newValue,
      delta: newValue - oldValue,
      comparable,
      direction: newValue > oldValue ? 'up' : 'down',
      stock: nextStock,
      quantity: next.quantity,
    });
  }

  return changes;
}

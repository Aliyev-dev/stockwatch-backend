import { escapeHtml } from './notifier';
import { t, type Language } from './i18n';
import { formatAmount } from '../lib/price';
import type { ProductChange, ProductIdentity } from '../lib/product-changes';

/**
 * Telegram message bodies for product changes.
 *
 * Every string comes from `src/bot/i18n.ts` in the user's own language; nothing
 * user-facing is written here. HTML parse mode is used, so each interpolated
 * value is escaped first.
 */

function titleOf(product: ProductIdentity): string {
  const title = product.name && product.name.trim() !== '' ? product.name.trim() : product.asin;
  return escapeHtml(title);
}

/** Never leave the price empty — an unknown price says so in the user's language. */
export function priceText(price: string | null | undefined, lang: Language): string {
  if (price === null || price === undefined || price.trim() === '') {
    return `<i>${t(lang, 'price_unknown')}</i>`;
  }
  return `<b>${escapeHtml(price.trim())}</b>`;
}

/** Full Telegram body for one change, in the user's language. */
export function renderChange(change: ProductChange, lang: Language): string {
  const name = titleOf(change.product);

  switch (change.kind) {
    case 'back_in_stock':
      return t(
        lang,
        'back_in_stock',
        name,
        change.quantity === null ? '—' : change.quantity,
        priceText(change.price, lang),
      );

    case 'out_of_stock':
      return t(lang, 'out_of_stock', name);

    case 'quantity': {
      const key = change.direction === 'up' ? 'stock_increase' : 'stock_decrease';
      const body = t(lang, key, name, change.newQuantity, priceText(change.price, lang));
      if (change.belowThreshold && change.threshold !== null) {
        return `${body}\n${t(lang, 'below_threshold', change.threshold)}`;
      }
      return body;
    }

    case 'price': {
      const dropped = change.direction === 'down';
      const delta = formatAmount(Math.abs(change.delta), change.newPrice);
      return t(
        lang,
        'price_change',
        name,
        escapeHtml(change.oldPrice.trim()),
        escapeHtml(change.newPrice.trim()),
        dropped,
        escapeHtml(delta),
      );
    }
  }
}

/**
 * Short plain-text form stored in the notifications table and shown in the admin
 * panel. Admin-facing, so it stays in one language regardless of the user's.
 */
export function summariseChange(change: ProductChange): string {
  const title =
    change.product.name && change.product.name.trim() !== '' ? change.product.name.trim() : change.product.asin;
  switch (change.kind) {
    case 'back_in_stock':
      return `${title}: yenidən stokda (${change.price ?? '?'})`;
    case 'out_of_stock':
      return `${title}: stokda yoxdur`;
    case 'quantity':
      return `${title}: stok ${change.oldQuantity} → ${change.newQuantity}`;
    case 'price':
      return `${title}: qiymət ${change.oldPrice} → ${change.newPrice}`;
  }
}

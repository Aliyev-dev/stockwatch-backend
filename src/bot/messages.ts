import { escapeHtml } from './notifier';
import { t, type Language } from './i18n';
import { formatAmount, usableQuantity } from '../lib/price';
import { productUrl } from '../lib/product-url';
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

/**
 * Link to the product page, so the reported figure can be checked immediately.
 * Omitted when the ASIN or the domain does not look usable.
 */
function linkLine(product: ProductIdentity, lang: Language): string {
  const url = productUrl(product.asin, product.domain);
  if (!url) return '';
  return `\n\n<a href="${escapeHtml(url)}">${t(lang, 'open_product')}</a>`;
}

/** Full Telegram body for one change, in the user's language. */
export function renderChange(change: ProductChange, lang: Language): string {
  const name = titleOf(change.product);
  const link = linkLine(change.product, lang);

  switch (change.kind) {
    case 'back_in_stock': {
      const qty = usableQuantity(change.quantity);
      // No quantity reported: say it is back in stock without inventing a number.
      const body =
        qty === null
          ? t(lang, 'back_in_stock_no_qty', name, priceText(change.price, lang))
          : t(lang, 'back_in_stock', name, qty, priceText(change.price, lang));
      return body + link;
    }

    case 'out_of_stock':
      return t(lang, 'out_of_stock', name) + link;

    case 'quantity': {
      const key = change.direction === 'up' ? 'stock_increase' : 'stock_decrease';
      // Both figures are shown: a misread count is obvious next to the old one.
      const body = t(lang, key, name, change.oldQuantity, change.newQuantity, priceText(change.price, lang));
      const warning =
        change.belowThreshold && change.threshold !== null
          ? `\n${t(lang, 'below_threshold', change.threshold)}`
          : '';
      return body + warning + link;
    }

    case 'price': {
      const dropped = change.direction === 'down';
      // Across currencies the difference is not a number worth printing.
      const delta = change.comparable ? formatAmount(Math.abs(change.delta), change.newPrice) : '';
      return (
        t(
          lang,
          'price_change',
          name,
          escapeHtml(change.oldPrice.trim()),
          escapeHtml(change.newPrice.trim()),
          dropped,
          escapeHtml(delta),
        ) + link
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

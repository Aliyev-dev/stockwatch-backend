import { escapeHtml } from './notifier';
import { formatAmount } from '../lib/price';
import type { ProductChange, ProductIdentity } from '../lib/product-changes';

/**
 * Telegram message bodies for product changes. HTML parse mode: <s> for the old
 * price, <b> for the new one. Every value that comes from the extension or from
 * Amazon is escaped before it reaches the message.
 */

const UNKNOWN_PRICE = 'Qiymət məlum deyil';

/** Never leave the price cell empty — an unknown price says so explicitly. */
export function priceLine(label: string, price: string | null | undefined): string {
  if (price === null || price === undefined || price.trim() === '') {
    return `${label}: <i>${UNKNOWN_PRICE}</i>`;
  }
  return `${label}: <b>${escapeHtml(price.trim())}</b>`;
}

function heading(product: ProductIdentity): string[] {
  const title = product.name && product.name.trim() !== '' ? product.name.trim() : product.asin;
  return [
    `<b>${escapeHtml(title)}</b>`,
    `ASIN: <code>${escapeHtml(product.asin)}</code> · ${escapeHtml(product.domain)}`,
  ];
}

function quantityLine(quantity: number | null): string | null {
  if (typeof quantity !== 'number') return null;
  return `Miqdar: <b>${quantity}</b>`;
}

/**
 * Old price struck through, then the new price with a green/red signal and the
 * signed difference.
 *
 *   Əvvəlki qiymət: <s>$29.99</s>
 *   🟢 ⬇️ Yeni qiymət: <b>$24.99</b> (−$5.00)
 */
export function priceChangeBlock(change: Extract<ProductChange, { kind: 'price' }>): string {
  const signal = change.direction === 'down' ? '🟢 ⬇️' : '🔴 ⬆️';
  const sign = change.direction === 'down' ? '−' : '+';
  const delta = formatAmount(Math.abs(change.delta), change.newPrice);

  return [
    `Əvvəlki qiymət: <s>${escapeHtml(change.oldPrice.trim())}</s>`,
    `${signal} Yeni qiymət: <b>${escapeHtml(change.newPrice.trim())}</b> (${sign}${escapeHtml(delta)})`,
  ].join('\n');
}

/** Full Telegram body for one change. */
export function renderChange(change: ProductChange): string {
  const lines = [...heading(change.product), ''];

  switch (change.kind) {
    case 'back_in_stock': {
      lines.unshift('✅ <b>Məhsul yenidən stokda!</b>', '');
      const qty = quantityLine(change.quantity);
      if (qty) lines.push(qty);
      lines.push(priceLine('Qiymət', change.price));
      break;
    }

    case 'out_of_stock': {
      lines.unshift('❌ <b>Məhsul stokda yoxdur</b>', '');
      lines.push(priceLine('Son qiymət', change.price));
      break;
    }

    case 'quantity': {
      const arrow = change.direction === 'down' ? '📉' : '📈';
      const verb = change.direction === 'down' ? 'Stok azaldı' : 'Stok artdı';
      lines.unshift(`${arrow} <b>${verb}</b>`, '');
      lines.push(`Miqdar: <s>${change.oldQuantity}</s> → <b>${change.newQuantity}</b>`);
      if (change.belowThreshold && change.threshold !== null) {
        lines.push(`⚠️ Həddən aşağıdır (hədd: ${change.threshold})`);
      }
      lines.push(priceLine('Qiymət', change.price));
      break;
    }

    case 'price': {
      lines.unshift('💰 <b>Qiymət dəyişdi</b>', '');
      lines.push(priceChangeBlock(change));
      if (change.stock === 'out_of_stock') lines.push('', '❌ Hazırda stokda yoxdur.');
      break;
    }
  }

  return lines.join('\n');
}

/** Short plain-text form stored in the notifications table and shown in the panel. */
export function summariseChange(change: ProductChange): string {
  const title = change.product.name && change.product.name.trim() !== '' ? change.product.name.trim() : change.product.asin;
  switch (change.kind) {
    case 'back_in_stock':
      return `${title}: yenidən stokda (${change.price ?? UNKNOWN_PRICE})`;
    case 'out_of_stock':
      return `${title}: stokda yoxdur`;
    case 'quantity':
      return `${title}: stok ${change.oldQuantity} → ${change.newQuantity}`;
    case 'price':
      return `${title}: qiymət ${change.oldPrice} → ${change.newPrice}`;
  }
}

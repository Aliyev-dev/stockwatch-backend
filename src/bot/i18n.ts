/**
 * Bot texts in five languages.
 *
 * Every user-facing string the bot sends lives here — nothing user-facing is
 * hard-coded anywhere else. Values are either plain strings or functions that
 * take the values to interpolate; `t()` handles both.
 *
 * Telegram HTML parse mode is used, so any value interpolated into a template
 * must already be escaped by the caller (see `escapeHtml`).
 */

export const LANGUAGES = ['az', 'en', 'ru', 'tr', 'de'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'az';

/** Labels for the language-picker keyboard; not translated on purpose. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  az: '🇦🇿 Azərbaycan',
  en: '🇬🇧 English',
  ru: '🇷🇺 Русский',
  tr: '🇹🇷 Türkçe',
  de: '🇩🇪 Deutsch',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Anything unknown (null, an old row, a bad value) falls back to Azerbaijani. */
export function normaliseLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

type Template = string | ((...args: never[]) => string);

interface Dictionary {
  /** Language picker prompt — one line per language, so it reads for everyone. */
  lang_prompt: string;
  lang_set: string;
  welcome: string;
  link_code_info: (code: string) => string;
  code_reminder: (code: string) => string;
  help_prompt: string;
  help_sent: string;
  help_body: string;
  language_changed_hint: string;
  unknown_command: string;
  text_only: string;
  error_generic: string;
  support_reply_prefix: string;
  price_unknown: string;
  below_threshold: (threshold: number) => string;
  /** Link label under every product message. */
  open_product: string;
  /** Both numbers are shown, so a wrong reading is obvious at a glance. */
  stock_increase: (name: string, oldQty: number | string, newQty: number | string, price: string) => string;
  stock_decrease: (name: string, oldQty: number | string, newQty: number | string, price: string) => string;
  out_of_stock: (name: string) => string;
  back_in_stock: (name: string, qty: number | string, price: string) => string;
  /** Used when the extension reported no usable quantity: no number is invented. */
  back_in_stock_no_qty: (name: string, price: string) => string;
  price_change: (name: string, oldPrice: string, newPrice: string, dropped: boolean, delta: string) => string;
}

export type TranslationKey = keyof Dictionary;

/** Shared by every language: 🟢⬇️ for a drop, 🔴⬆️ for a rise. */
const signal = (dropped: boolean): string => (dropped ? '🟢 ⬇️' : '🔴 ⬆️');
const sign = (dropped: boolean): string => (dropped ? '−' : '+');
const deltaSuffix = (dropped: boolean, delta: string): string => (delta === '' ? '' : ` (${sign(dropped)}${delta})`);

const az: Dictionary = {
  lang_prompt: [
    '🌍 Dilinizi seçin:',
    'Choose your language:',
    'Выберите язык:',
    'Dilinizi seçin:',
    'Wählen Sie Ihre Sprache:',
  ].join('\n'),
  lang_set: '✅ Dil seçildi: Azərbaycan dili',
  welcome: 'StockWatch-a xoş gəlmisiniz! Məhsullarınız izlənəcək.',
  link_code_info: (code) =>
    [
      'Bu kodu extension-a yapışdırın:',
      `<code>${code}</code>`,
      '',
      'Kodu yenidən görmək üçün /code yazın.',
    ].join('\n'),
  code_reminder: (code) => `Sizin StockWatch kodunuz:\n<code>${code}</code>`,
  help_prompt: 'Mesajınızı yazın, dəstək komandamıza çatacaq.',
  help_sent: '✅ Mesajınız göndərildi. Tezliklə cavab verəcəyik.',
  help_body: [
    '<b>StockWatch bot</b>',
    '',
    '1. /code ilə kodunuzu götürün.',
    '2. Kodu extension parametrlərinə yapışdırın.',
    '3. Qiymət və stok bildirişləri bu çata gələcək.',
    '',
    'Dili dəyişmək üçün: /language',
  ].join('\n'),
  language_changed_hint: 'Dili istənilən vaxt /language ilə dəyişə bilərsiniz.',
  unknown_command: 'Naməlum əmr. /code və ya /help yazın.',
  text_only: 'Yalnız mətn mesajlarını oxuya bilirəm. Problemi sözlə yazın.',
  error_generic: 'Bağışlayın, əməliyyat alınmadı. Bir dəqiqədən sonra yenidən cəhd edin.',
  support_reply_prefix: 'StockWatch dəstək',
  price_unknown: 'Qiymət məlum deyil',
  below_threshold: (threshold) => `⚠️ Həddən aşağıdır (hədd: ${threshold})`,
  open_product: 'Məhsula bax',
  stock_increase: (name, oldQty, newQty, price) =>
    `📈 <b>${name}</b>\nStok artdı: ${oldQty} → ${newQty} ədəd\nQiymət: ${price}`,
  stock_decrease: (name, oldQty, newQty, price) =>
    `📉 <b>${name}</b>\nStok azaldı: ${oldQty} → ${newQty} ədəd\nQiymət: ${price}`,
  out_of_stock: (name) => `❌ <b>${name}</b>\nStokda yoxdur`,
  back_in_stock: (name, qty, price) => `🔔 <b>${name}</b>\nYenidən stokda: ${qty} ədəd\nQiymət: ${price}`,
  back_in_stock_no_qty: (name, price) => `🔔 <b>${name}</b>\nYenidən stokda\nQiymət: ${price}`,
  price_change: (name, oldPrice, newPrice, dropped, delta) =>
    [
      `💰 <b>${name}</b>`,
      `Əvvəlki qiymət: <s>${oldPrice}</s>`,
      `${signal(dropped)} Yeni qiymət: <b>${newPrice}</b>${deltaSuffix(dropped, delta)}`,
    ].join('\n'),
};

const en: Dictionary = {
  lang_prompt: az.lang_prompt,
  lang_set: '✅ Language selected: English',
  welcome: 'Welcome to StockWatch! Your products are now being watched.',
  link_code_info: (code) =>
    [
      'Paste this code into the extension:',
      `<code>${code}</code>`,
      '',
      'Send /code to see it again.',
    ].join('\n'),
  code_reminder: (code) => `Your StockWatch code:\n<code>${code}</code>`,
  help_prompt: 'Write your message and it will reach our support team.',
  help_sent: '✅ Your message has been sent. We will reply soon.',
  help_body: [
    '<b>StockWatch bot</b>',
    '',
    '1. Get your code with /code.',
    '2. Paste it into the extension settings.',
    '3. Price and stock alerts arrive in this chat.',
    '',
    'To change the language: /language',
  ].join('\n'),
  language_changed_hint: 'You can change the language any time with /language.',
  unknown_command: 'Unknown command. Try /code or /help.',
  text_only: 'I can only read text messages. Please describe the problem in words.',
  error_generic: 'Sorry, that did not work. Please try again in a minute.',
  support_reply_prefix: 'StockWatch support',
  price_unknown: 'Price unknown',
  below_threshold: (threshold) => `⚠️ Below your threshold (threshold: ${threshold})`,
  open_product: 'View product',
  stock_increase: (name, oldQty, newQty, price) =>
    `📈 <b>${name}</b>\nStock increased: ${oldQty} → ${newQty} pcs\nPrice: ${price}`,
  stock_decrease: (name, oldQty, newQty, price) =>
    `📉 <b>${name}</b>\nStock decreased: ${oldQty} → ${newQty} pcs\nPrice: ${price}`,
  out_of_stock: (name) => `❌ <b>${name}</b>\nOut of stock`,
  back_in_stock: (name, qty, price) => `🔔 <b>${name}</b>\nBack in stock: ${qty} pcs\nPrice: ${price}`,
  back_in_stock_no_qty: (name, price) => `🔔 <b>${name}</b>\nBack in stock\nPrice: ${price}`,
  price_change: (name, oldPrice, newPrice, dropped, delta) =>
    [
      `💰 <b>${name}</b>`,
      `Previous price: <s>${oldPrice}</s>`,
      `${signal(dropped)} New price: <b>${newPrice}</b>${deltaSuffix(dropped, delta)}`,
    ].join('\n'),
};

const ru: Dictionary = {
  lang_prompt: az.lang_prompt,
  lang_set: '✅ Язык выбран: Русский',
  welcome: 'Добро пожаловать в StockWatch! Ваши товары теперь отслеживаются.',
  link_code_info: (code) =>
    [
      'Вставьте этот код в расширение:',
      `<code>${code}</code>`,
      '',
      'Отправьте /code, чтобы увидеть его снова.',
    ].join('\n'),
  code_reminder: (code) => `Ваш код StockWatch:\n<code>${code}</code>`,
  help_prompt: 'Напишите ваше сообщение, оно попадёт в нашу службу поддержки.',
  help_sent: '✅ Ваше сообщение отправлено. Мы скоро ответим.',
  help_body: [
    '<b>Бот StockWatch</b>',
    '',
    '1. Получите код командой /code.',
    '2. Вставьте его в настройки расширения.',
    '3. Уведомления о цене и наличии приходят в этот чат.',
    '',
    'Сменить язык: /language',
  ].join('\n'),
  language_changed_hint: 'Язык можно сменить в любой момент командой /language.',
  unknown_command: 'Неизвестная команда. Попробуйте /code или /help.',
  text_only: 'Я понимаю только текстовые сообщения. Опишите проблему словами.',
  error_generic: 'Извините, не получилось. Попробуйте ещё раз через минуту.',
  support_reply_prefix: 'Поддержка StockWatch',
  price_unknown: 'Цена неизвестна',
  below_threshold: (threshold) => `⚠️ Ниже вашего порога (порог: ${threshold})`,
  open_product: 'Открыть товар',
  stock_increase: (name, oldQty, newQty, price) =>
    `📈 <b>${name}</b>\nОстаток увеличился: ${oldQty} → ${newQty} шт.\nЦена: ${price}`,
  stock_decrease: (name, oldQty, newQty, price) =>
    `📉 <b>${name}</b>\nОстаток уменьшился: ${oldQty} → ${newQty} шт.\nЦена: ${price}`,
  out_of_stock: (name) => `❌ <b>${name}</b>\nНет в наличии`,
  back_in_stock: (name, qty, price) => `🔔 <b>${name}</b>\nСнова в наличии: ${qty} шт.\nЦена: ${price}`,
  back_in_stock_no_qty: (name, price) => `🔔 <b>${name}</b>\nСнова в наличии\nЦена: ${price}`,
  price_change: (name, oldPrice, newPrice, dropped, delta) =>
    [
      `💰 <b>${name}</b>`,
      `Прежняя цена: <s>${oldPrice}</s>`,
      `${signal(dropped)} Новая цена: <b>${newPrice}</b>${deltaSuffix(dropped, delta)}`,
    ].join('\n'),
};

const tr: Dictionary = {
  lang_prompt: az.lang_prompt,
  lang_set: '✅ Dil seçildi: Türkçe',
  welcome: "StockWatch'a hoş geldiniz! Ürünleriniz artık takip ediliyor.",
  link_code_info: (code) =>
    [
      'Bu kodu eklentiye yapıştırın:',
      `<code>${code}</code>`,
      '',
      'Tekrar görmek için /code yazın.',
    ].join('\n'),
  code_reminder: (code) => `StockWatch kodunuz:\n<code>${code}</code>`,
  help_prompt: 'Mesajınızı yazın, destek ekibimize ulaşacak.',
  help_sent: '✅ Mesajınız gönderildi. En kısa sürede yanıtlayacağız.',
  help_body: [
    '<b>StockWatch bot</b>',
    '',
    '1. /code ile kodunuzu alın.',
    '2. Kodu eklenti ayarlarına yapıştırın.',
    '3. Fiyat ve stok bildirimleri bu sohbete gelir.',
    '',
    'Dili değiştirmek için: /language',
  ].join('\n'),
  language_changed_hint: 'Dili istediğiniz zaman /language ile değiştirebilirsiniz.',
  unknown_command: 'Bilinmeyen komut. /code veya /help deneyin.',
  text_only: 'Yalnızca metin mesajlarını okuyabiliyorum. Lütfen sorunu yazıyla anlatın.',
  error_generic: 'Üzgünüz, işlem başarısız oldu. Bir dakika sonra tekrar deneyin.',
  support_reply_prefix: 'StockWatch destek',
  price_unknown: 'Fiyat bilinmiyor',
  below_threshold: (threshold) => `⚠️ Eşiğinizin altında (eşik: ${threshold})`,
  open_product: 'Ürüne git',
  stock_increase: (name, oldQty, newQty, price) =>
    `📈 <b>${name}</b>\nStok arttı: ${oldQty} → ${newQty} adet\nFiyat: ${price}`,
  stock_decrease: (name, oldQty, newQty, price) =>
    `📉 <b>${name}</b>\nStok azaldı: ${oldQty} → ${newQty} adet\nFiyat: ${price}`,
  out_of_stock: (name) => `❌ <b>${name}</b>\nStokta yok`,
  back_in_stock: (name, qty, price) => `🔔 <b>${name}</b>\nTekrar stokta: ${qty} adet\nFiyat: ${price}`,
  back_in_stock_no_qty: (name, price) => `🔔 <b>${name}</b>\nTekrar stokta\nFiyat: ${price}`,
  price_change: (name, oldPrice, newPrice, dropped, delta) =>
    [
      `💰 <b>${name}</b>`,
      `Önceki fiyat: <s>${oldPrice}</s>`,
      `${signal(dropped)} Yeni fiyat: <b>${newPrice}</b>${deltaSuffix(dropped, delta)}`,
    ].join('\n'),
};

const de: Dictionary = {
  lang_prompt: az.lang_prompt,
  lang_set: '✅ Sprache ausgewählt: Deutsch',
  welcome: 'Willkommen bei StockWatch! Ihre Produkte werden überwacht.',
  link_code_info: (code) =>
    [
      'Fügen Sie diesen Code in die Erweiterung ein:',
      `<code>${code}</code>`,
      '',
      'Senden Sie /code, um ihn erneut zu sehen.',
    ].join('\n'),
  code_reminder: (code) => `Ihr StockWatch-Code:\n<code>${code}</code>`,
  help_prompt: 'Schreiben Sie Ihre Nachricht, sie erreicht unser Support-Team.',
  help_sent: '✅ Ihre Nachricht wurde gesendet. Wir antworten bald.',
  help_body: [
    '<b>StockWatch Bot</b>',
    '',
    '1. Holen Sie sich Ihren Code mit /code.',
    '2. Fügen Sie ihn in die Einstellungen der Erweiterung ein.',
    '3. Preis- und Bestandsmeldungen kommen in diesen Chat.',
    '',
    'Sprache ändern: /language',
  ].join('\n'),
  language_changed_hint: 'Sie können die Sprache jederzeit mit /language ändern.',
  unknown_command: 'Unbekannter Befehl. Versuchen Sie /code oder /help.',
  text_only: 'Ich kann nur Textnachrichten lesen. Bitte beschreiben Sie das Problem in Worten.',
  error_generic: 'Entschuldigung, das hat nicht geklappt. Bitte versuchen Sie es in einer Minute erneut.',
  support_reply_prefix: 'StockWatch Support',
  price_unknown: 'Preis unbekannt',
  below_threshold: (threshold) => `⚠️ Unter Ihrem Schwellenwert (Schwelle: ${threshold})`,
  open_product: 'Zum Produkt',
  stock_increase: (name, oldQty, newQty, price) =>
    `📈 <b>${name}</b>\nBestand erhöht: ${oldQty} → ${newQty} Stück\nPreis: ${price}`,
  stock_decrease: (name, oldQty, newQty, price) =>
    `📉 <b>${name}</b>\nBestand verringert: ${oldQty} → ${newQty} Stück\nPreis: ${price}`,
  out_of_stock: (name) => `❌ <b>${name}</b>\nNicht auf Lager`,
  back_in_stock: (name, qty, price) => `🔔 <b>${name}</b>\nWieder auf Lager: ${qty} Stück\nPreis: ${price}`,
  back_in_stock_no_qty: (name, price) => `🔔 <b>${name}</b>\nWieder auf Lager\nPreis: ${price}`,
  price_change: (name, oldPrice, newPrice, dropped, delta) =>
    [
      `💰 <b>${name}</b>`,
      `Vorheriger Preis: <s>${oldPrice}</s>`,
      `${signal(dropped)} Neuer Preis: <b>${newPrice}</b>${deltaSuffix(dropped, delta)}`,
    ].join('\n'),
};

const DICTIONARIES: Record<Language, Dictionary> = { az, en, ru, tr, de };

/**
 * Looks up a text in the given language.
 *
 * - unknown language  -> Azerbaijani
 * - missing key       -> the Azerbaijani entry, and if that is missing too, the
 *                        key name itself (never undefined: Telegram rejects an
 *                        empty message body)
 * - function template -> called with the extra arguments
 * - plain string      -> returned as is
 */
export function t(lang: string | null | undefined, key: TranslationKey, ...args: unknown[]): string {
  const language = normaliseLanguage(lang);
  const value = (DICTIONARIES[language][key] ?? DICTIONARIES[DEFAULT_LANGUAGE][key]) as Template | undefined;

  if (typeof value === 'function') {
    return (value as (...callArgs: unknown[]) => string)(...args);
  }
  if (typeof value === 'string') return value;
  return String(key);
}

/** Inline keyboard rows for the language picker. */
export function languageKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [
      { text: LANGUAGE_LABELS.az, callback_data: 'setlang:az' },
      { text: LANGUAGE_LABELS.en, callback_data: 'setlang:en' },
    ],
    [
      { text: LANGUAGE_LABELS.ru, callback_data: 'setlang:ru' },
      { text: LANGUAGE_LABELS.tr, callback_data: 'setlang:tr' },
    ],
    [{ text: LANGUAGE_LABELS.de, callback_data: 'setlang:de' }],
  ];
}

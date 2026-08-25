import cors, { type CorsOptions } from 'cors';
import type { RequestHandler } from 'express';
import type { Config } from '../config';

/**
 * CORS for the endpoints the Chrome extension calls. Extensions send a
 * `chrome-extension://<id>` origin, which cannot be predicted before the
 * extension is packed, so the default is to allow any origin — but only on these
 * routes, and only for POST. Setting ALLOWED_EXTENSION_ORIGIN pins it to one origin.
 */
export function extensionCors(config: Config): RequestHandler {
  const options: CorsOptions = {
    origin: config.allowedExtensionOrigin ?? true,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 86_400,
  };
  return cors(options);
}

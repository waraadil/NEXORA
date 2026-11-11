import 'server-only';

/**
 * Personal WhatsApp bridge — shared risk copy.
 *
 * The token/ingest machinery that used to live here is gone: it was a
 * receive-only prototype with no way to send a reply, superseded by the relay
 * (`/api/whatsapp/relay/*` + `relay/relay.mjs`). The consent text is still
 * imported from this module by the UI, so it stays.
 */

export { CONSENT_VERSION, BRIDGE_RISKS, REQUIRED_ACKNOWLEDGEMENTS, CONFIRMATION_PHRASE } from './bridge-risks';

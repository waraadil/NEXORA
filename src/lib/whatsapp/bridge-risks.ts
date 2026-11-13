/**
 * Consent copy for the personal bridge — shared between server and client.
 *
 * This module must stay free of server-only imports. The client needs this text
 * to render the consent gate, and pulling it from `bridge.ts` (which imports
 * node:crypto and the service-role Supabase client) would drag server code into
 * the browser bundle. The production build fails loudly on exactly that mistake.
 */

export const CONSENT_VERSION = '2026-11-personal-bridge-v1';

export type BridgeRiskKey =
  | 'accountSuspensionRisk'
  | 'termsOfServiceViolation'
  | 'dataPrivacyResponsibility'
  | 'noOfficialSupport';

export const BRIDGE_RISKS: { key: BridgeRiskKey; title: string; detail: string }[] = [
  {
    key: 'accountSuspensionRisk',
    title: 'Your WhatsApp account can be banned',
    detail:
      'Automating a personal WhatsApp account is detectable. Meta may suspend or permanently ban the number — losing your message history, contacts and access to the account. This has happened to real users and is not reversible by us or by you.',
  },
  {
    key: 'termsOfServiceViolation',
    title: 'This violates WhatsApp’s Terms of Service',
    detail:
      'WhatsApp’s ToS prohibits unauthorised automation and modified clients. Using this feature is a breach of those terms, independent of whether you are caught.',
  },
  {
    key: 'dataPrivacyResponsibility',
    title: 'You become responsible for other people’s messages',
    detail:
      'Messages from your contacts will be stored in this database and sent to your AI provider for analysis. Those people have not consented to that. In many jurisdictions you are the data controller for that processing.',
  },
  {
    key: 'noOfficialSupport',
    title: 'No support path, no recourse',
    detail:
      'Meta will not help you recover a banned account. If the bridge breaks after a WhatsApp update, you fix it yourself. NEXORA provides the ingest endpoint only — not the automation.',
  },
];

export const REQUIRED_ACKNOWLEDGEMENTS: BridgeRiskKey[] = BRIDGE_RISKS.map((r) => r.key);

export const CONFIRMATION_PHRASE = 'I understand the risks';

/**
 * How long the app keeps a pairing attempt open.
 *
 * WhatsApp itself honours a code for 15 minutes, so this cannot be longer — but
 * it does not have to be that long either. Three minutes is comfortably enough
 * to paste a 9-character code, and it fails fast: an attempt whose agent never
 * picked it up, or whose socket died, stops looking like progress after three
 * minutes instead of fifteen. Waiting a quarter of an hour on a pairing that
 * already failed is not patience, it is a stall that reads as a broken page.
 *
 * It lives here, beside the consent copy, because the client renders a countdown
 * from it — and this module is the one place in this feature that is explicitly
 * server-free. Importing it from `relay.ts` would pull `next/headers` into a
 * client component and break the build.
 */
export const PAIRING_TTL_MS = 3 * 60 * 1000;

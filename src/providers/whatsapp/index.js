import { DryRunWhatsAppProvider } from "./dry-run.js";
import { MetaWhatsAppProvider } from "./meta.js";
import { NotConfiguredWhatsAppProvider } from "./not-configured.js";
import { whatsappConfig } from "./config.js";

// Provider interface (all adapters implement it; the reminder service only knows this):
//   sendMessage({ from, to, body, reminder }) -> Promise<{ success, provider, dryRun?, providerMessageId?, errorCode?, errorMessage? }>
//     body     the consolidated reminder as plain text (dry run / free-text providers)
//     reminder the same reminder as structured, already-formatted fields (template providers such as Meta)
// `from`/`to` are "+91..." numbers; an adapter converts to whatever its provider requires.
//
// Selection is configuration-driven (WHATSAPP_MODE). Later, per-Owner senders (Owner A -> Owner A's WhatsApp Business number) = a factory
// that looks the sender up per academy. The eligibility and message logic does not change; only this selection does.
export function createWhatsAppProvider(env, options = {}) {
  const config = whatsappConfig(env);
  if (config.dryRun) return new DryRunWhatsAppProvider();
  if (config.meta) return new MetaWhatsAppProvider(env, options);
  return new NotConfiguredWhatsAppProvider(config.mode);
}

export { MetaWhatsAppProvider, DryRunWhatsAppProvider, NotConfiguredWhatsAppProvider };
export { whatsappConfig, publicConfig, normalizeIndianMobile, toE164India, toMetaRecipient, metaSettings } from "./config.js";

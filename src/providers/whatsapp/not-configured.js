// Used when a real mode is requested but no provider has been set up. It never pretends: every send fails with a clear code.
export class NotConfiguredWhatsAppProvider {
  constructor(requestedMode) {
    this.name = `${requestedMode}-not-configured`;
  }

  async sendMessage() {
    return { success: false, provider: this.name, errorCode: "PROVIDER_NOT_CONFIGURED", errorMessage: "No WhatsApp provider is configured for this environment" };
  }
}

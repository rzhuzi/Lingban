/** Only intentional, fixed configuration messages may be shown before sending a turn. */
export class CotConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'CotConfigurationError'; }
}

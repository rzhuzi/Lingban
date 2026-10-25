/** The framing subset of WHATWG SSE; reconnection is deliberately owned by the caller. */
export class SseParser {
  private line = '';
  private data: string[] = [];
  private event = '';
  private skipLf = false;
  private size = 0;

  constructor(
    private readonly dispatch: (data: string, event: string) => void,
    private readonly maxEventChars = 1_048_576,
  ) {}

  push(text: string): void {
    for (const character of text) {
      if (this.skipLf) {
        this.skipLf = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        this.processLine();
        this.skipLf = character === '\r';
      } else {
        this.line += character;
        if (this.line.length + this.size > this.maxEventChars) throw new Error('SSE event limit');
      }
    }
  }

  private processLine(): void {
    const line = this.line;
    this.line = '';
    if (!line) {
      const data = this.data;
      const event = this.event;
      this.data = [];
      this.event = '';
      this.size = 0;
      if (data.length) this.dispatch(data.join('\n'), event);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.data.push(value);
      this.size += value.length + 1;
    } else if (field === 'event') {
      this.event = value;
    }
  }
  // Pending data at EOF is intentionally discarded: only a blank line dispatches an event.
}

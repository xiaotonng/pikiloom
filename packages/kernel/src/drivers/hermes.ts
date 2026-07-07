import { AcpDriver } from './acp.js';

// Hermes = the reference ACP agent, shipped as a thin preset over the generic AcpDriver.
// Any other ACP CLI (OpenCode, Gemini-ACP, …) is just `new AcpDriver({ id, command, args })`.
export class HermesDriver extends AcpDriver {
  constructor(bin: string = 'hermes') {
    super({ id: 'hermes', command: bin, args: ['acp'] });
  }
}

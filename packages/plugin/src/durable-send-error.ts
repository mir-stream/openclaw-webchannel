/** The authored frame was not accepted by the server's durable store.
 * Callers may retry that output under its existing identity; they must not
 * replay the agent task or issue a normal durable-success receipt.
 */
export class DurableSendError extends Error {
  constructor(readonly frameType: string, readonly messageId?: string) {
    super(`webchannel: durable ${frameType} was not stored`);
    this.name = "DurableSendError";
  }
}

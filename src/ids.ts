export function responseId(): string {
  return `resp_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function messageId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function reasoningId(): string {
  return `rs_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function toolCallId(seed?: string | number): string {
  if (seed !== undefined && seed !== null && String(seed).length > 0) {
    return `call_${String(seed).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  }
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}

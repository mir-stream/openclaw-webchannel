/** Decode the strict logfmt subset emitted by webchannel diagnostics. */
export function decodeStrictLogfmt(record: string): Map<string, string> {
  if (/\r|\n/.test(record)) throw new Error("logfmt records must be single-line");
  const fields = new Map<string, string>();
  let index = 0;
  while (index < record.length) {
    while (/\s/.test(record[index] ?? "")) index += 1;
    if (index >= record.length) break;

    const keyStart = index;
    while (index < record.length && !/[\s=]/.test(record[index]!)) {
      if (record[index] === '"') throw new Error(`quote in logfmt key at ${index}`);
      index += 1;
    }
    if (index === keyStart) throw new Error(`invalid logfmt key at ${index}`);
    const key = record.slice(keyStart, index);
    let value = "";

    if (record[index] === "=") {
      index += 1;
      if (record[index] === '"') {
        const valueStart = index;
        index += 1;
        while (index < record.length && record[index] !== '"') {
          if (record[index] === "\\") index += 1;
          index += 1;
        }
        if (record[index] !== '"') throw new Error(`unterminated logfmt value for ${key}`);
        index += 1;
        const decoded = JSON.parse(record.slice(valueStart, index)) as unknown;
        if (typeof decoded !== "string") throw new Error(`non-string logfmt value for ${key}`);
        value = decoded;
        if (index < record.length && !/\s/.test(record[index]!)) {
          throw new Error(`invalid character after quoted logfmt value for ${key}`);
        }
      } else {
        const valueStart = index;
        while (index < record.length && !/\s/.test(record[index]!)) index += 1;
        value = record.slice(valueStart, index);
        if (/["=]/.test(value)) throw new Error(`invalid bare logfmt value for ${key}`);
      }
    }
    fields.set(key, value);
  }
  return fields;
}

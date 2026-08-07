export interface ReceiptPrintInput {
  storeName: string;
  receiptId: string;
  items: Array<{ name: string; price: string }>;
  totalText: string;
}

export function compileEscPosReceiptBytes(input: ReceiptPrintInput): Uint8Array {
  const chunks: number[] = [];

  // ESC @: Initialize printer
  chunks.push(0x1b, 0x40);

  // ESC a 1: Center align header
  chunks.push(0x1b, 0x61, 0x01);

  // Store name text
  const header = `${input.storeName}\nReceipt #${input.receiptId}\n--------------------------------\n`;
  for (let i = 0; i < header.length; i++) {
    chunks.push(header.charCodeAt(i));
  }

  // ESC a 0: Left align items
  chunks.push(0x1b, 0x61, 0x00);

  for (const item of input.items) {
    const line = `${item.name.padEnd(20)} ${item.price}\n`;
    for (let i = 0; i < line.length; i++) {
      chunks.push(line.charCodeAt(i));
    }
  }

  // Total line
  const totalLine = `--------------------------------\n${input.totalText}\n\n`;
  for (let i = 0; i < totalLine.length; i++) {
    chunks.push(totalLine.charCodeAt(i));
  }

  // GS V 66 0: Full cut paper
  chunks.push(0x1d, 0x56, 0x42, 0x00);

  return new Uint8Array(chunks);
}

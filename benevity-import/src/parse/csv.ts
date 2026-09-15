export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

// Line-oriented: does not handle a quoted field containing an embedded newline. See the
// module-level note in this task's plan entry for why that's an accepted scope limit.
export function parseCsvRows(text: string): string[][] {
  return text
    .split(/\r\n|\n/)
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
}

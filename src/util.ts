export const countNewlines = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) count++;
  }
  return count;
};

/** Levenshtein distance, for "did you mean" suggestions over short names. */
export const editDistance = (left: string, right: string): number => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length]!;
};

export const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = `\n\n... ${value.length - maxChars} characters omitted by Pi Fabric ...\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
};

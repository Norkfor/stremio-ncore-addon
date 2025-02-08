const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  value < min ? min : value > max ? max : value;

const BYTES_RANGE_REGEX = /bytes=(?<start>\d+)?-(?<end>\d+)?/;

export const parseRangeHeader = (
  rangeHeader: string | undefined,
  fileSize: number,
  maxChunkSize?: number,
): { start: number; end: number } | null => {
  if (!rangeHeader) return null;
  
  const match = rangeHeader.match(BYTES_RANGE_REGEX);
  if (!match?.groups) return null;
  
  const { start: startStr, end: endStr } = match.groups;
  const start = startStr ? parseInt(startStr, 10) : NaN;
  const end = endStr ? parseInt(endStr, 10) : NaN;
  if ((startStr && isNaN(start)) || (endStr && isNaN(end))) return null;
  
  const max = maxChunkSize ? Math.min(maxChunkSize, fileSize) : fileSize;
  if (!startStr && !endStr) return null;
  if (startStr && start >= fileSize) return null;
  if (endStr && end >= fileSize) return null;
  
  if (!startStr) {
    // Suffix byte format: "bytes=-500"
    const length = clamp(end, { min: 0, max });
    return length > 0 
      ? { start: fileSize - length, end: fileSize - 1 }
      : null;
  }
  
  if (!endStr) {
    // Prefix byte format: "bytes=1000-"
    return {
      start: clamp(start, { min: 0, max: fileSize - 1 }),
      end: clamp(start + max - 1, { min: 0, max: fileSize - 1 }),
    };
  }
  
  // Fully specified format: "bytes=1000-2000"
  if (end < start) return null;
  const clampedStart = clamp(start, { min: 0, max: fileSize - 1 });
  const clampedEnd = clamp(end, { min: clampedStart, max: fileSize - 1 });
  
  return clampedEnd - clampedStart + 1 > 0
    ? { start: clampedStart, end: clampedEnd }
    : null;
};

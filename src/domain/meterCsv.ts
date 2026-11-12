import { celsiusToFahrenheit } from './temperature';
import type { HistorySample } from './history';
import { TIME_ZONE } from './time';
import { DateTime } from 'luxon';

export type MeterImportSummary = {
  inserted: number;
  duplicates: number;
  skipped: number;
  firstAt: string | null;
  lastAt: string | null;
};

export type ParsedMeterCsv =
  | { ok: true; rows: HistorySample[]; skipped: number }
  | { ok: false; error: string };

type TempUnit = 'C' | 'F';

type Columns = {
  time: number;
  temp: number;
  unit: TempUnit;
  humidity: number;
  co2: number;
};

const FORMATS = [
  'yyyy-MM-dd H:mm:ss',
  'yyyy-MM-dd H:mm',
  'yyyy/M/d H:mm:ss',
  'yyyy/M/d H:mm',
  'yyyy-MM-dd h:mm:ss a',
  'yyyy-MM-dd h:mm a',
  'yyyy/M/d h:mm:ss a',
  'yyyy/M/d h:mm a',
];

export function parseMeterCsv(csv: string, zone = TIME_ZONE): ParsedMeterCsv {
  const table = parseCsv(csv);
  if (table.length === 0) {
    return { ok: false, error: 'The CSV is empty.' };
  }
  const columns = columnsFrom(table[0]);
  if (!columns) {
    return { ok: false, error: 'This CSV needs a timestamp, temperature, humidity, and CO2 column.' };
  }
  const rows: HistorySample[] = [];
  let skipped = 0;
  for (let index = 1; index < table.length; index += 1) {
    const sample = rowToSample(table[index], columns, zone);
    if (!sample) {
      skipped += 1;
      continue;
    }
    rows.push(sample);
  }
  return { ok: true, rows, skipped };
}

export function parseMeterTimestamp(value: string, zone = TIME_ZONE): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const iso = DateTime.fromISO(trimmed, { setZone: true });
    if (iso.isValid) {
      const utc = iso.toUTC().toISO();
      return utc;
    }
  }
  const local = withMeridian(trimmed);
  for (const format of FORMATS) {
    const parsed = DateTime.fromFormat(local, format, { zone });
    if (parsed.isValid) {
      return parsed.toUTC().toISO();
    }
  }
  return null;
}

export function planMeterImport(rows: HistorySample[]): {
  insert: HistorySample[];
  duplicates: number;
  firstAt: string | null;
  lastAt: string | null;
} {
  const seen = new Set<number>();
  const insert: HistorySample[] = [];
  let duplicates = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const time = Date.parse(row.at);
    if (!Number.isFinite(time)) {
      continue;
    }
    if (time < first) {
      first = time;
    }
    if (time > last) {
      last = time;
    }
    if (seen.has(time)) {
      duplicates += 1;
      continue;
    }
    seen.add(time);
    insert.push(row);
  }
  if (insert.length === 0 && duplicates === 0) {
    return { insert, duplicates, firstAt: null, lastAt: null };
  }
  return {
    insert,
    duplicates,
    firstAt: new Date(first).toISOString(),
    lastAt: new Date(last).toISOString(),
  };
}

export function mergeMeterHistory(
  existing: HistorySample[],
  rows: HistorySample[],
  skipped: number,
): { history: HistorySample[]; summary: MeterImportSummary } {
  const planned = planMeterImport(rows);
  const have = new Set<number>();
  for (const sample of existing) {
    const time = Date.parse(sample.at);
    if (Number.isFinite(time)) {
      have.add(time);
    }
  }
  const added: HistorySample[] = [];
  let duplicates = planned.duplicates;
  for (const row of planned.insert) {
    const time = Date.parse(row.at);
    if (have.has(time)) {
      duplicates += 1;
      continue;
    }
    have.add(time);
    added.push(row);
  }
  const history = [...existing, ...added].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    history,
    summary: {
      inserted: added.length,
      duplicates,
      skipped,
      firstAt: planned.firstAt,
      lastAt: planned.lastAt,
    },
  };
}

export function combineSummaries(left: MeterImportSummary, right: MeterImportSummary): MeterImportSummary {
  return {
    inserted: left.inserted + right.inserted,
    duplicates: left.duplicates + right.duplicates,
    skipped: left.skipped + right.skipped,
    firstAt: earlierIso(left.firstAt, right.firstAt),
    lastAt: laterIso(left.lastAt, right.lastAt),
  };
}

export function chunkMeterCsv(csv: string, rowsPerChunk: number): string[] {
  const normalized = csv.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  let headerIndex = 0;
  while (headerIndex < lines.length && lines[headerIndex].trim() === '') {
    headerIndex += 1;
  }
  if (headerIndex >= lines.length) {
    return [csv];
  }
  const header = lines[headerIndex];
  const data: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '') {
      data.push(lines[index]);
    }
  }
  if (data.length <= rowsPerChunk) {
    return [csv];
  }
  const chunks: string[] = [];
  for (let index = 0; index < data.length; index += rowsPerChunk) {
    chunks.push([header, ...data.slice(index, index + rowsPerChunk)].join('\n'));
  }
  return chunks;
}

export function emptySummary(): MeterImportSummary {
  return { inserted: 0, duplicates: 0, skipped: 0, firstAt: null, lastAt: null };
}

function earlierIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function withMeridian(value: string): string {
  let meridian = '';
  if (value.includes('午後') || /\bPM\b/i.test(value) || /p\.m\./i.test(value)) {
    meridian = 'PM';
  } else if (value.includes('午前') || /\bAM\b/i.test(value) || /a\.m\./i.test(value)) {
    meridian = 'AM';
  }
  let local = value
    .replace(/午後/g, '')
    .replace(/午前/g, '')
    .replace(/a\.m\./gi, '')
    .replace(/p\.m\./gi, '')
    .replace(/\b(AM|PM)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (meridian) {
    local = `${local} ${meridian}`;
  }
  return local;
}

function columnsFrom(header: string[]): Columns | null {
  let time = -1;
  let temp = -1;
  let unit: TempUnit | null = null;
  let humidity = -1;
  let co2 = -1;
  for (let index = 0; index < header.length; index += 1) {
    const kind = headerKind(header[index]);
    if (kind === 'time' && time < 0) {
      time = index;
    }
    if (kind === 'tempC' && unit !== 'F') {
      temp = index;
      unit = 'C';
    }
    if (kind === 'tempF') {
      temp = index;
      unit = 'F';
    }
    if (kind === 'tempBare' && unit === null) {
      temp = index;
      unit = 'C';
    }
    if (kind === 'humidity' && humidity < 0) {
      humidity = index;
    }
    if (kind === 'co2' && co2 < 0) {
      co2 = index;
    }
  }
  if (time < 0 || temp < 0 || unit === null || humidity < 0 || co2 < 0) {
    return null;
  }
  return { time, temp, unit, humidity, co2 };
}

function headerKind(
  value: string,
): 'time' | 'tempC' | 'tempF' | 'tempBare' | 'humidity' | 'co2' | 'ignore' {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/₂/g, '2')
    .replace(/℃/g, 'c')
    .replace(/℉/g, 'f')
    .replace(/°/g, '')
    .replace(/º/g, '')
    .replace(/[^a-z0-9]/g, '');
  if (name === 'timestamp' || name === 'date' || name === 'time' || name === 'datetime') {
    return 'time';
  }
  if (name.startsWith('dpt') || name.includes('dew') || name.includes('absolute') || name.startsWith('vpd')) {
    return 'ignore';
  }
  if (name.includes('fahrenheit') || name.endsWith('temperaturef') || name === 'tempf') {
    return 'tempF';
  }
  if (name.includes('celsius') || name.endsWith('temperaturec') || name === 'tempc') {
    return 'tempC';
  }
  if (name === 'temperature' || name === 'temp') {
    return 'tempBare';
  }
  if (name === 'humidity' || name === 'relativehumidity' || name.endsWith('humidity')) {
    return 'humidity';
  }
  if (name === 'co2' || name === 'co2ppm' || name.startsWith('co2')) {
    return 'co2';
  }
  return 'ignore';
}

function rowToSample(row: string[], columns: Columns, zone: string): HistorySample | null {
  const at = parseMeterTimestamp(row[columns.time] ?? '', zone);
  const temperature = parseNumber(row[columns.temp] ?? '');
  const humidity = parseNumber(row[columns.humidity] ?? '');
  const co2 = parseNumber(row[columns.co2] ?? '');
  if (!at || temperature === null || humidity === null || co2 === null) {
    return null;
  }
  if (humidity < 0 || humidity > 100) {
    return null;
  }
  if (co2 < 0 || co2 > 9999) {
    return null;
  }
  if (columns.unit === 'C' && (temperature < -30 || temperature > 85)) {
    return null;
  }
  if (columns.unit === 'F' && (temperature < -22 || temperature > 185)) {
    return null;
  }
  const temperatureF = columns.unit === 'C' ? celsiusToFahrenheit(temperature) : temperature;
  return {
    at,
    temperatureF: Math.round(temperatureF * 10) / 10,
    humidity: Math.round(humidity * 10) / 10,
    co2Ppm: Math.round(co2),
  };
}

function parseNumber(value: string): number | null {
  const cleaned = value.trim().replace(/%$/u, '').replace(/ppm$/iu, '').trim();
  if (!cleaned) {
    return null;
  }
  const number = Number(cleaned);
  if (!Number.isFinite(number)) {
    return null;
  }
  return number;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

import { parseMeterCsv, planMeterImport, type MeterImportSummary } from '../domain/meterCsv';
import type { SetpointDb } from './sqlDb';

export class MeterImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeterImportError';
  }
}

const BATCH = 400;

export async function importMeterCsv(db: SetpointDb, csv: string): Promise<MeterImportSummary> {
  const parsed = parseMeterCsv(csv);
  if (!parsed.ok) {
    throw new MeterImportError(parsed.error);
  }
  const planned = planMeterImport(parsed.rows);
  let inserted = 0;
  for (let index = 0; index < planned.insert.length; index += BATCH) {
    const batch = planned.insert.slice(index, index + BATCH);
    inserted += await db.importReads(batch);
  }
  return {
    inserted,
    duplicates: planned.duplicates + (planned.insert.length - inserted),
    skipped: parsed.skipped,
    firstAt: planned.firstAt,
    lastAt: planned.lastAt,
    skipReasons: parsed.skipReasons,
  };
}

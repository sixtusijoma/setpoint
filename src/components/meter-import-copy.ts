import type { MeterImportSummary } from '@/domain/meterCsv';
import type { MeterImportState } from '@/state/model';

export function importSheetTitle(summary: MeterImportSummary): string {
  if (summary.inserted === 0 && summary.duplicates === 0) {
    return 'Nothing was imported';
  }
  return 'Import complete';
}

export function importSheetWarning(summary: MeterImportSummary): string | null {
  if (summary.inserted === 0 && summary.duplicates === 0 && summary.skipped > 0) {
    return 'Every row was skipped. Nothing was stored.';
  }
  return null;
}

export function titleFor(state: MeterImportState): string {
  if (state.status === 'uploading') {
    return 'Importing';
  }
  if (state.status === 'done') {
    return importSheetTitle(state.summary);
  }
  if (state.status === 'error') {
    return 'Import failed';
  }
  return 'Import meter CSV';
}

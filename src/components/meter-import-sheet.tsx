import { PillButton, Sheet } from '@/components/ui';
import { importSheetWarning, titleFor } from '@/components/meter-import-copy';
import type { MeterImportSummary } from '@/domain/meterCsv';
import { formatDayTime } from '@/domain/time';
import type { MeterImportState } from '@/state/model';
import { colors, fonts } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';

export function MeterImportSheet({
  state,
  onChoose,
  onClose,
}: {
  state: MeterImportState;
  onChoose: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={state.status !== 'idle'} onClose={onClose}>
      <View testID="meter-import-sheet" style={styles.block}>
        <Text style={styles.title}>{titleFor(state)}</Text>
        {state.status === 'picking' ? (
          <View style={styles.block}>
            <Text style={styles.body}>
              Choose the CSV from the SwitchBot app. Open the Meter Pro, scroll to Export Data, pick the date range, and
              save the file. Celsius and Fahrenheit exports both work. Times without a zone are read as Eastern Time.
            </Text>
            <PillButton label="Choose CSV" testID="meter-import-choose" onPress={onChoose} />
          </View>
        ) : null}
        {state.status === 'uploading' ? <Text style={styles.body}>Importing readings.</Text> : null}
        {state.status === 'done' ? <Summary summary={state.summary} /> : null}
        {state.status === 'error' ? (
          <View style={styles.block}>
            <Text testID="meter-import-error" style={styles.error}>
              {state.message}
            </Text>
            <PillButton label="Try again" testID="meter-import-retry" onPress={onChoose} />
          </View>
        ) : null}
        {state.status === 'done' || state.status === 'error' ? (
          <PillButton label="Close" tone="ghost" testID="meter-import-dismiss" onPress={onClose} />
        ) : null}
        {state.status === 'picking' ? (
          <PillButton label="Cancel" tone="ghost" testID="meter-import-cancel" onPress={onClose} />
        ) : null}
      </View>
    </Sheet>
  );
}

function Summary({ summary }: { summary: MeterImportSummary }) {
  const warning = importSheetWarning(summary);
  const range =
    summary.firstAt && summary.lastAt
      ? `From ${formatDayTime(summary.firstAt)} to ${formatDayTime(summary.lastAt)}.`
      : 'No readings were imported.';
  return (
    <View testID="meter-import-summary" style={styles.block}>
      {warning ? (
        <Text testID="meter-import-warning" style={styles.error}>
          {warning}
        </Text>
      ) : null}
      <Text style={styles.body}>Inserted {summary.inserted}.</Text>
      <Text style={styles.body}>Already stored {summary.duplicates}.</Text>
      <Text style={styles.body}>Skipped {summary.skipped}.</Text>
      {(summary.skipReasons ?? []).map((reason) => (
        <Text key={reason} style={styles.body}>
          {reason}
        </Text>
      ))}
      <Text style={styles.body}>{range}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  title: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 28 },
  body: { color: colors.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  error: { color: colors.poor, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
});

import { formatStamp } from '@/domain/time';
import { useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ActivityScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 16), paddingBottom: 96 }]}
    >
      <Text style={styles.title}>Activity</Text>
      {app.state.log.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No activity yet</Text>
          <Text style={styles.body}>Presses, calibrations, and schedule runs will land here.</Text>
        </View>
      ) : (
        app.state.log.map((entry) => (
          <View key={entry.id} testID="activity-row" style={styles.row}>
            <Text style={styles.time}>{formatStamp(entry.at)}</Text>
            <Text style={styles.message}>{entry.message}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, gap: 10 },
  title: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 36, marginBottom: 6 },
  empty: { backgroundColor: colors.card, borderRadius: 16, padding: 16, gap: 6 },
  emptyTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18 },
  body: { color: colors.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  row: { backgroundColor: colors.card, borderRadius: 14, padding: 12, gap: 4 },
  time: { color: colors.faint, fontFamily: fonts.medium, fontSize: 12 },
  message: { color: colors.text, fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
});

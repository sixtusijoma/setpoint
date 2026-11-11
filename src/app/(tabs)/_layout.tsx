import { colors, fonts } from '@/theme';
import { Tabs } from 'expo-router';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.line,
          height: 56 + insets.bottom,
          paddingTop: 0,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: {
          fontFamily: fonts.medium,
          fontSize: 11,
          lineHeight: 14,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarButtonTestID: 'tab-home',
          tabBarIcon: ({ color }) => <TabGlyph kind="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          tabBarButtonTestID: 'tab-schedule',
          tabBarIcon: ({ color }) => <TabGlyph kind="schedule" color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarButtonTestID: 'tab-history',
          tabBarIcon: ({ color }) => <TabGlyph kind="history" color={color} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarButtonTestID: 'tab-activity',
          tabBarIcon: ({ color }) => <TabGlyph kind="activity" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarButtonTestID: 'tab-settings',
          tabBarIcon: ({ color }) => <TabGlyph kind="settings" color={color} />,
        }}
      />
    </Tabs>
  );
}

function TabGlyph({ kind, color }: { kind: 'home' | 'schedule' | 'activity' | 'settings' | 'history'; color: ColorValue }) {
  if (kind === 'home') {
    return (
      <View style={styles.icon}>
        <View style={[styles.roof, { borderBottomColor: color }]} />
        <View style={[styles.house, { borderColor: color }]} />
      </View>
    );
  }
  if (kind === 'schedule') {
    return (
      <View style={[styles.clock, { borderColor: color }]}>
        <View style={[styles.hand, { backgroundColor: color }]} />
      </View>
    );
  }
  if (kind === 'history') {
    return (
      <View style={styles.lines}>
        <View style={[styles.line, { backgroundColor: color, height: 6 }]} />
        <View style={[styles.line, styles.lineShort, { backgroundColor: color, height: 10 }]} />
        <View style={[styles.line, { backgroundColor: color, height: 4 }]} />
      </View>
    );
  }
  if (kind === 'activity') {
    return (
      <View style={styles.lines}>
        <View style={[styles.line, { backgroundColor: color }]} />
        <View style={[styles.line, styles.lineShort, { backgroundColor: color }]} />
        <View style={[styles.line, { backgroundColor: color }]} />
      </View>
    );
  }
  return (
    <View style={styles.sliders}>
      <View style={[styles.slider, { backgroundColor: color }]} />
      <View style={[styles.slider, styles.sliderMid, { backgroundColor: color }]} />
      <View style={[styles.slider, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  icon: {
    width: 22,
    height: 18,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  roof: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  house: {
    width: 12,
    height: 8,
    borderWidth: 1.5,
    borderTopWidth: 0,
  },
  clock: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  hand: {
    width: 1.5,
    height: 5,
    marginTop: 3,
  },
  lines: {
    width: 16,
    gap: 3,
  },
  line: {
    height: 1.5,
    borderRadius: 1,
  },
  lineShort: {
    width: 10,
  },
  sliders: {
    width: 16,
    gap: 3,
  },
  slider: {
    height: 1.5,
    borderRadius: 1,
  },
  sliderMid: {
    marginLeft: 6,
  },
});

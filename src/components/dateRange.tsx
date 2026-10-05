import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import {
  dayOfMonth,
  formatRange,
  makeRange,
  matchingPreset,
  monthGrid,
  nextRangeSelection,
  presetRange,
  RANGE_PRESETS,
  WEEKDAY_INITIALS,
  type DateRange,
} from '../utils/dateRange';
import { addDays, sameDay, startOfDay } from '../utils/periodUtils';
import { Button, Chip, IconButton, Sheet, styles as ui } from './ui';

/** Pick a date range: a preset, or two taps on the calendar (one tap = a single day). */
export function DateRangeSheet(props: {
  visible: boolean;
  onClose: () => void;
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const [draft, setDraft] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [anchor, setAnchor] = useState(() => new Date());

  useEffect(() => {
    if (!props.visible) return;
    setDraft({ start: props.value?.start ?? null, end: props.value ? startOfDay(props.value.end) : null });
    setAnchor(props.value?.end ?? new Date());
  }, [props.visible, props.value]);

  const grid = useMemo(() => monthGrid(anchor, calendar), [anchor, calendar]);
  const today = startOfDay(new Date());
  const draftRange = draft.start ? makeRange(draft.start, draft.end ?? draft.start) : null;
  const preset = matchingPreset(draftRange, new Date(), calendar);

  const apply = (range: DateRange | null) => {
    props.onChange(range);
    props.onClose();
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Date range">
      <View style={{ gap: spacing.md }}>
        <View style={[ui.rowWrap, { gap: spacing.sm }]}>
          {RANGE_PRESETS.map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              selected={preset === p.value}
              onPress={() => apply(presetRange(p.value, new Date(), calendar))}
            />
          ))}
        </View>

        <View style={styles.monthRow}>
          <IconButton name="chevron-left" accessibilityLabel="Previous month" onPress={() => setAnchor(addDays(grid.start, -1))} />
          <Text style={[styles.monthLabel, { color: colors.text }]}>{grid.label}</Text>
          <IconButton
            name="chevron-right"
            accessibilityLabel="Next month"
            color={grid.next.getTime() > today.getTime() ? colors.textMuted : colors.text}
            onPress={() => grid.next.getTime() <= today.getTime() && setAnchor(grid.next)}
          />
        </View>

        <View>
          <View style={styles.week}>
            {WEEKDAY_INITIALS.map((d, i) => (
              <Text key={i} style={[styles.weekday, { color: colors.textMuted }]}>
                {d}
              </Text>
            ))}
          </View>
          {grid.weeks.map((week, w) => (
            <View key={w} style={styles.week}>
              {week.map((day, i) => {
                if (!day) return <View key={i} style={styles.cell} />;
                const future = day.getTime() > today.getTime();
                const endpoint = (draft.start && sameDay(day, draft.start)) || (draft.end && sameDay(day, draft.end));
                const inside = !!draftRange && day.getTime() >= draftRange.start.getTime() && day.getTime() <= draftRange.end.getTime();
                return (
                  <Pressable
                    key={i}
                    disabled={future}
                    onPress={() => setDraft((current) => nextRangeSelection(current, day))}
                    style={[styles.cell, inside && !endpoint && { backgroundColor: colors.primarySoft }]}
                    accessibilityLabel={day.toDateString()}
                  >
                    <View style={[styles.day, endpoint && { backgroundColor: colors.primary }]}>
                      <Text
                        style={{
                          color: endpoint ? colors.onPrimary : future ? colors.textMuted : colors.text,
                          fontWeight: sameDay(day, today) || endpoint ? '700' : '400',
                        }}
                      >
                        {dayOfMonth(day, calendar)}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
          {draftRange
            ? `${formatRange(draftRange, calendar)}${draft.end ? '' : ' · tap an end day'}`
            : 'Tap a start day, then an end day'}
        </Text>

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button title="Clear" variant="ghost" style={{ flex: 1 }} onPress={() => apply(null)} />
          <Button title="Apply" style={{ flex: 1 }} disabled={!draftRange} onPress={() => apply(draftRange)} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monthLabel: { fontSize: 16, fontWeight: '700' },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', paddingVertical: spacing.xs },
  cell: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' },
  day: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
